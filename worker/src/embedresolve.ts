import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./index";
import { NXSHA_HOST, nxshaStreams, nxshaTmdbOf, type NxshaTitle } from "./nxsha";
import { vidlinkSources, vidlinkTitleOf } from "./vidlink";
import { vidnestSources, vidnestTitleOf } from "./vidnest";
import { xpassSources, xpassTitleOf } from "./xpass";

/**
 * Embed → HLS resolver ("Server 3").
 *
 * Mirrors what the "m3u8 Sniffer" Chrome extension does, but server-side:
 * follow the iframe/redirect chain of an embed page (vidapi.ru, vidbox.wtf,
 * vidcloud mirrors, ...) and pull the .m3u8 stream URLs out of the HTML/JS.
 * The site then plays the raw stream in its own player — no provider iframe,
 * no ads.
 *
 * Limits: hops protected by Cloudflare Turnstile or that build the playlist
 * URL only inside JS after a token handshake cannot be resolved here (a real
 * browser is needed); callers fall back to the iframe view.
 */

export const embedResolveRoutes = new Hono<Env>();

const MAX_HOPS = 6;
const FETCH_TIMEOUT_MS = 12_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** One stream a provider handed us, plus what probing it revealed. The flags
 *  travel to the player because they decide how it must be fetched: a stream
 *  without CORS has to be piped through /proxy, and `codec` says whether the
 *  browser can decode it at all. */
interface Candidate {
  url: string;
  via: string;
  quality?: string;
  kind?: "hls" | "file" | "dash";
  codec?: "h264" | "hevc" | "unknown";
  cors?: boolean;
}

/** Reject non-http(s) targets and anything pointing at localhost/private ranges (SSRF guard). */
function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "0.0.0.0" ||
    /^\d+$/.test(h.replace(/\./g, "")) // bare integer "URL"
  )
    return null;
  // IPv4 private/loopback/link-local ranges and IPv6 equivalents
  if (
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h === "::1" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc") ||
    h.startsWith("fd")
  )
    return null;
  return u;
}

/** Decode a gzip+base64 blob ("H4sIAAAA…" — the format many redirectors wrap). */
async function gunzipBase64(b64: string): Promise<string | null> {
  try {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const ds = new DecompressionStream("gzip");
    const buf = await new Response(
      new Blob([bytes]).stream().pipeThrough(ds),
    ).arrayBuffer();
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

/** Unpack Dean Edwards' `eval(function(p,a,c,k,e,d){…})` obfuscation. */
function unpackPacker(html: string): string {
  const out: string[] = [];
  const re =
    /eval\(function\(p,a,c,k,e,[dr]?\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const [, payload, radixStr, countStr, keywords] = m;
      const radix = parseInt(radixStr, 36) || 36;
      const count = parseInt(countStr, 10);
      const words = keywords.split("|");
      const map: Record<string, string> = {};
      const encode = (n: number): string =>
        n.toString(radix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (let i = 0; i < count && i < words.length; i++) {
        if (words[i]) map[encode(i)] = words[i];
      }
      const decoded = payload.replace(
        new RegExp("\\b(" + Object.keys(map).join("|") + ")\\b", "g"),
        (w) => map[w] ?? w,
      );
      out.push(decoded);
    } catch {
      /* one malformed packer blob should not kill the scan */
    }
  }
  return out.join("\n");
}

function extractM3u8(text: string, base: URL): { url: string; from: string }[] {
  const found: { url: string; from: string }[] = [];
  const push = (raw: string, from: string) => {
    const abs = safeUrl(new URL(raw, base).href)?.href;
    if (abs && !found.some((f) => f.url === abs)) found.push({ url: abs, from });
  };
  // absolute m3u8 URLs (allow signed query strings)
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>()]+?\.m3u8(?:\?[^\s"'<>()]*)?/g))
    push(m[0], "regex");
  // relative playlist references: file:"/path/x.m3u8", src="…m3u8"
  for (const m of text.matchAll(
    /(?:file|src|url|playlist)\s*[:=]\s*["']([^"']*?\.m3u8(?:[^"']*?))["']/gi,
  ))
    push(m[1], "assignment");
  return found;
}

function firstIframeSrc(html: string, base: URL): string | null {
  const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!m) return null;
  return safeUrl(new URL(m[1], base).href)?.href ?? null;
}

async function fetchPage(
  url: string,
  referer: string,
  cookie = "",
  extra?: Record<string, string>,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: referer,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/vnd.apple.mpegurl;q=0.8,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        /* Some provider CDNs sign their playlist with a CloudFront cookie
           instead of a URL token; without it the manifest 403s. */
        ...(cookie ? { Cookie: cookie } : {}),
        /* And some decide what to hand back by a header the caller has to name
           (vidlink's playback environment), so the generic fetcher stays open. */
        ...(extra ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Walk the embed chain and return every m3u8 candidate found, best first. */
export async function resolveEmbedStream(
  start: string,
): Promise<{ candidates: Candidate[]; hops: string[]; error?: string }> {
  const hops: string[] = [];
  const candidates: Candidate[] = [];
  const addCandidate = (url: string, via: string) => {
    if (!candidates.some((c) => c.url === url)) candidates.push({ url, via });
  };

  let current = safeUrl(start)?.href;
  let referer = "";
  if (!current) return { candidates: [], hops, error: "invalid url" };

  for (let hop = 0; hop < MAX_HOPS && current; hop++) {
    if (hops.includes(current)) break;
    hops.push(current);
    let res: Response;
    try {
      res = await fetchPage(current, referer || start);
    } catch (err) {
      return { candidates, hops, error: `fetch failed at hop ${hop}: ${String(err)}` };
    }
    const finalUrl: string = safeUrl(res.url)?.href ?? current;
    referer = current;
    current = finalUrl;

    const ctype = res.headers.get("content-type") ?? "";
    const html = await res.text();

    // The chain terminal: a playlist served directly.
    if (ctype.includes("mpegurl") || html.trimStart().startsWith("#EXTM3U")) {
      addCandidate(finalUrl, "playlist response");
      break;
    }
    if (ctype.includes("json")) {
      // Some providers answer the embed id with JSON containing file/url fields.
      for (const c of extractM3u8(html, new URL(finalUrl)))
        addCandidate(c.url, "json");
      const jm = html.match(
        /"(?:file|url|src|playlist)"\s*:\s*"(https?:\/\/[^"]+)"/gi,
      );
      if (jm) {
        const first = jm[0].match(/(https?:\/\/[^"]+)"/);
        if (first && safeUrl(first[1])) current = first[1];
      }
      continue;
    }

    for (const c of extractM3u8(html, new URL(finalUrl)))
      addCandidate(c.url, "html scan");

    // gzip+base64 wrapped redirect targets ("H4sI…" tokens in URLs or scripts)
    for (const m of html.matchAll(/H4sIA[A-Za-z0-9+\/=_-]{20,}/g)) {
      const decoded = await gunzipBase64(m[0]);
      if (!decoded) continue;
      for (const c of extractM3u8(decoded, new URL(finalUrl)))
        addCandidate(c.url, "gunzip");
      const target = decoded.match(/https?:\/\/[^\s"']+/)?.[0];
      if (target && safeUrl(target) && !hops.includes(target)) current = target;
    }

    // JS-packer obfuscated scripts
    const unpacked = unpackPacker(html);
    if (unpacked) {
      for (const c of extractM3u8(unpacked, new URL(finalUrl)))
        addCandidate(c.url, "packer");
    }

    if (candidates.length) break;

    // No stream yet — descend into the nested player iframe.
    const next = firstIframeSrc(html, new URL(finalUrl));
    current = next && !hops.includes(next) ? next : undefined;
  }

  // Prefer plain CDN playlists over token-heavy ones (shorter query = longer-lived).
  candidates.sort((a, b) => (a.url.split("?")[1]?.length ?? 0) - (b.url.split("?")[1]?.length ?? 0));
  return { candidates, hops };
}

/** Ask one stream URL what a browser would actually get from it.
 *
 *  Every provider hands out links that look fine and then play as a black
 *  rectangle: the playlist 403s outside the provider's own session, the CDN
 *  refuses cross-origin fetches, or the file is HEVC, which most desktop
 *  browsers cannot decode at all. Reading the head of the real response tells
 *  us which of those we are looking at, so the player only ever gets a source
 *  it can render. Only the first 64 KB is ever read. */
interface StreamProbe {
  ok: boolean;
  kind: "hls" | "file" | "dash" | "dead";
  codec: "h264" | "hevc" | "unknown";
  cors: boolean;
}

const PROBE_TIMEOUT_MS = 9_000;
const PROBE_HEAD_BYTES = 65_536;

/** Read at most `max` bytes of a response body, then release the connection. */
async function readHead(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    /* a CDN that dies mid-stream simply has no playable head */
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    if (at >= out.length) break;
    out.set(c.subarray(0, out.length - at), at);
    at += c.byteLength;
  }
  return out;
}

function findBrand(bytes: Uint8Array, brand: string): boolean {
  const b = [brand.charCodeAt(0), brand.charCodeAt(1), brand.charCodeAt(2), brand.charCodeAt(3)];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === b[0] && bytes[i + 1] === b[1] && bytes[i + 2] === b[2] && bytes[i + 3] === b[3])
      return true;
  }
  return false;
}

async function probeStream(
  rawUrl: string,
  referer?: string,
  cookie?: string,
): Promise<StreamProbe> {
  const dead: StreamProbe = { ok: false, kind: "dead", codec: "unknown", cors: false };
  const url = safeUrl(rawUrl);
  if (!url) return dead;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url.href, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        /* A CDN that gates on the provider's page must be probed with that
           page's referer, or it answers 403 and we write off a stream the
           pipe would have served without trouble. */
        Referer: referer ?? url.origin + "/",
        Origin: url.origin,
        Accept: "*/*",
        /* Some CDNs sign the path into a cookie instead of the URL (vidlink's
           CloudFront), so the probe has to carry it or it fails on a live
           stream. */
        ...(cookie ? { Cookie: cookie } : {}),
        Range: `bytes=0-${PROBE_HEAD_BYTES - 1}`,
      },
    });
    const cors = (res.headers.get("access-control-allow-origin") ?? "") !== "";
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    /* A 4xx/5xx on the playlist itself is the provider saying "this link was
       minted for its own player session" — never playable from here. */
    if (res.status >= 400) return { ...dead, cors };
    const head = await readHead(res, PROBE_HEAD_BYTES);
    const text = new TextDecoder().decode(head);

    if (ctype.includes("mpegurl") || text.trimStart().startsWith("#EXTM3U")) {
      const codecs = [...text.matchAll(/CODECS="([^"]+)"/g)].map((m) => m[1]).join(",");
      const hevc = /hev1|hvc1|h265|dvh1|dvhe/i.test(codecs);
      const avc = /avc1|avc3/i.test(codecs);
      return {
        ok: true,
        kind: "hls",
        codec: codecs ? (hevc && !avc ? "hevc" : "h264") : "unknown",
        cors,
      };
    }
    if (ctype.startsWith("video/") || ctype.startsWith("audio/") || /\.(mp4|m4v|mov|mkv|webm)(\?|$)/i.test(url.pathname)) {
      const hevc = findBrand(head, "hvc1") || findBrand(head, "hev1");
      const avc = findBrand(head, "avc1") || findBrand(head, "avc3");
      return { ok: true, kind: "file", codec: hevc && !avc ? "hevc" : avc ? "h264" : "unknown", cors };
    }
    /* Anything else (an HTML error page with a 200 on it) is not media. */
    if (/<html|<!doctype/i.test(text)) return { ...dead, cors };
    return { ok: true, kind: "file", codec: "unknown", cors };
  } catch {
    return dead;
  } finally {
    clearTimeout(timer);
  }
}

/** Order probed candidates the way the player wants them: H.264 first (every
 *  browser can decode it), CORS-open next (hls.js can fetch it without the
 *  proxy). A HEVC stream is dropped unless the caller said the viewer's browser
 *  passed the decode probe — vidlink keeps some titles only as HEVC, and for a
 *  machine that can decode it our player beats the provider's page. */
async function rankPlayable(
  items: { c: Candidate; p: Promise<StreamProbe> }[],
  opts: { allowHevc?: boolean } = {},
): Promise<Candidate[]> {
  const checked = await Promise.all(items.map(async (x) => ({ c: x.c, p: await x.p })));
  return checked
    .filter((x) => x.p.ok && (opts.allowHevc || x.p.codec !== "hevc"))
    .sort((a, b) => {
      const rank = (x: { p: StreamProbe }) =>
        (x.p.codec === "h264" ? 0 : 1) + (x.p.cors ? 0 : 2);
      return rank(a) - rank(b);
    })
    .map((x) => ({
      ...x.c,
      kind:
        x.p.kind === "hls" ? ("hls" as const) : x.p.kind === "dash" ? ("dash" as const) : ("file" as const),
      codec: x.p.codec,
      cors: x.p.cors,
    }));
}

/** Keep the candidates a browser can really play, best first. Probing starts
 *  here, so it is only used when the caller has no earlier hook. */
async function playableCandidates(items: Candidate[], limit = 4): Promise<Candidate[]> {
  return rankPlayable(
    items.slice(0, limit).map((c) => ({ c, p: probeStream(c.url) })),
  );
}

/* ---------------- direct provider APIs (TMDB id → stream, no page walk) ----- */

/** nhdapi.com's stream back end.
 *
 *  It answers an SSE feed with only a TMDB id and hands back ready-to-play
 *  HLS URLs — the one provider in the lineup whose stream can be pulled with
 *  plain HTTP, because every other player builds its playlist URL inside JS
 *  after a WASM/token handshake. Same family of upstreams the nhdapi page
 *  itself uses, so a win here is the title the viewer clicked, not a guess. */
const DURBIN_BASE = "https://proxy.durbin.st";
const DURBIN_PAGE = "https://nhdapi.com";

interface DirectSource {
  url: string;
  via: string;
  quality?: string;
}

async function durbinSources(
  tmdb: string,
  kind: "movie" | "tv",
  season: number,
  episode: number,
  /** Called the moment a source is parsed, with its probe already running:
   *  the feed takes ~20s to warm up, so validation has to overlap it instead
   *  of starting after it. */
  onSource?: (s: DirectSource, probe: Promise<StreamProbe>) => void,
): Promise<{ sources: DirectSource[]; error?: string }> {
  const url =
    kind === "tv"
      ? `${DURBIN_BASE}/tv?id=${encodeURIComponent(tmdb)}&season=${season}&episode=${episode}`
      : `${DURBIN_BASE}/movie?id=${encodeURIComponent(tmdb)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 26_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: `${DURBIN_PAGE}/`,
        Origin: DURBIN_PAGE,
        Accept: "text/event-stream",
      },
    });
    if (!res.ok) return { sources: [], error: `direct API answered ${res.status}` };

    /* The feed is slow to warm up — it validates the TMDB id upstream before it
       emits anything, and then keeps the connection open with heartbeats, so
       read until sources actually arrive rather than until the stream closes. */
    const sources: DirectSource[] = [];
    let buffer = "";
    let lastError = "";
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 22_000;
    while (reader && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let event: { type?: string; source?: Record<string, unknown> } = {};
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event.type === "error") lastError = String(event.source ?? "direct API error");
        const s = event.source;
        if (event.type !== "source" || !s || typeof s.url !== "string") continue;
        const target = safeUrl(s.url);
        if (!target) continue;
        sources.push({
          url: target.href,
          via: String(s.source ?? "direct"),
          quality: typeof s.quality === "string" ? s.quality : undefined,
        });
        const last = sources[sources.length - 1];
        onSource?.(last, probeStream(last.url));
      }
      if (sources.length >= 4) break;
    }
    void reader?.cancel().catch(() => undefined);
    return { sources, error: sources.length ? undefined : lastError || undefined };
  } catch (err) {
    return { sources: [], error: `direct API failed: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveDirectAnswer(c: Context<Env>): Promise<Response> {
  const tmdb = (c.req.query("tmdb") ?? "").replace(/\D/g, "");
  if (!tmdb) return c.json({ candidates: [], error: "no usable id" }, 400);
  const kind = c.req.query("kind") === "tv" ? "tv" : "movie";
  const season = Math.min(200, Math.max(1, Number(c.req.query("season")) || 1));
  const episode = Math.min(1000, Math.max(1, Number(c.req.query("episode")) || 1));
  try {
    const probing: { c: Candidate; p: Promise<StreamProbe> }[] = [];
    const { sources, error } = await durbinSources(tmdb, kind, season, episode, (s, p) =>
      probing.push({ c: { url: s.url, via: s.via, quality: s.quality }, p }),
    );
    /* Probing started as each source arrived, so only the slowest tail of the
       feed is still outstanding here. */
    const candidates = await rankPlayable(probing.slice(0, 6));
    return c.json({
      candidates,
      error: candidates.length
        ? ""
        : error ||
          (sources.length
            ? "Its links belonged to the provider's own session."
            : "No direct stream for this title."),
    });
  } catch (err) {
    console.error("direct resolve failed", err);
    return c.json({ candidates: [], error: "direct resolver crashed" }, 502);
  }
}

embedResolveRoutes.get("/direct", (c) =>
  cachedAnswer(c.req.raw, () => resolveDirectAnswer(c)),
);

/* ---------------- vixsrc handshake (its playlist is built in JS) ------------- */

const VIXSRC_HOST = "vixsrc.to";

/** vixsrc's provider page URL → the id path its keyless API expects, or null.
 *  Its pages are `/movie/{tmdb}` and `/tv/{tmdb}/{season}/{episode}`. */
function vixsrcApiPath(raw: string): string | null {
  const u = safeUrl(raw);
  if (!u || u.hostname.toLowerCase() !== VIXSRC_HOST) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  const num = (s?: string) => Boolean(s && /^\d+$/.test(s));
  if (seg[0] === "movie" && num(seg[1])) return `/api/movie/${seg[1]}`;
  if (seg[0] === "tv" && num(seg[1]) && num(seg[2]) && num(seg[3]))
    return `/api/tv/${seg[1]}/${seg[2]}/${seg[3]}`;
  return null;
}

/** Walk vixsrc's three-step handshake and return the playlist a viewer's own
 *  browser can fetch.
 *
 *  The provider looks unresolvable from the outside — the page is a Next.js
 *  shell and JWPlayer builds its config in JS — but every step is plain HTTP
 *  with no session and no cookie: `/api/movie/{tmdb}` hands back the tokenised
 *  embed path, that page injects `window.masterPlaylist` (playlist URL plus a
 *  second token of its own), and the playlist answers `#EXTM3U` with
 *  `Access-Control-Allow-Origin: *` on the manifest, the renditions and the
 *  segments. So the stream can go straight into our player: H.264 at
 *  480/720/1080, separate dub and subtitle renditions, no iframe, no ads.
 *
 *  Titles it does not carry answer 404 at the API, which is a real miss rather
 *  than a broken handshake, so the player says so instead of guessing. */
async function vixsrcPlaylist(
  embedUrl: string,
): Promise<{ url?: string; error: string }> {
  const apiPath = vixsrcApiPath(embedUrl);
  if (!apiPath) return { error: "not a vixsrc title page" };
  const base = `https://${VIXSRC_HOST}`;

  let playerPath: string;
  try {
    const res = await fetchPage(`${base}${apiPath}`, embedUrl);
    if (res.status === 404) return { error: "vixsrc does not carry this title" };
    if (!res.ok) return { error: `vixsrc API answered ${res.status}` };
    const j = (await res.json()) as { src?: string };
    /* Only ever follow its own embed path — the response must not be able to
       point this fetch at a third host. */
    if (!j.src?.startsWith("/embed/")) return { error: "vixsrc API gave no player path" };
    playerPath = j.src;
  } catch (err) {
    return { error: `vixsrc API failed: ${String(err)}` };
  }

  let head: string;
  try {
    const res = await fetchPage(
      `${base}${playerPath}`,
      `${base}${apiPath.replace("/api/", "/")}`,
    );
    if (!res.ok) return { error: `vixsrc player answered ${res.status}` };
    head = await res.text();
  } catch (err) {
    return { error: `vixsrc player failed: ${String(err)}` };
  }

  const at = head.indexOf("window.masterPlaylist");
  if (at < 0) return { error: "vixsrc player carried no playlist config" };
  const block = head.slice(at, at + 600);
  const read = (re: RegExp) => block.match(re)?.[1]?.trim() ?? "";
  const playlist = safeUrl(read(/url:\s*['"]([^'"]+)['"]/));
  const token = read(/'token':\s*['"]([^'"]*)['"]/);
  const expires = read(/'expires':\s*['"]([^'"]*)['"]/);
  if (!playlist || !token) return { error: "vixsrc playlist config was unreadable" };
  /* The skin script adds these three before it hands the URL to JWPlayer;
     without them the CDN returns the wrong rendition set. */
  playlist.searchParams.set("token", token);
  playlist.searchParams.set("expires", expires);
  playlist.searchParams.set("h", "1");
  if (!playlist.searchParams.has("lang")) playlist.searchParams.set("lang", "en");
  return { url: playlist.href, error: "" };
}

/* ---------------- nxsha (its API only speaks an encrypted query) ------------- */

/** nxsha's title page → the ids its handshake wants, or null for any other host.
 *  Its pages are `/embed/movie/{tmdb}` and `/embed/tv/{tmdb}/{season}/{episode}`
 *  (the `/watch/` spelling is the same player reached from the site itself). */
function nxshaTitleOf(raw: string): NxshaTitle | null {
  const u = safeUrl(raw);
  if (!u || u.hostname.toLowerCase() !== NXSHA_HOST) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  while (seg[0] === "embed" || seg[0] === "watch") seg.shift();
  const kind = seg.shift();
  const id = (seg.shift() ?? "").trim();
  if (!id) return null;
  const numeric = /^\d+$/.test(id);
  const imdb = /^tt\d+$/i.test(id) ? id : "";
  if (kind === "movie" && (numeric || imdb))
    return { tmdbId: numeric ? id : "", imdbId: imdb, type: "movie" };
  if (kind === "tv" && (numeric || imdb)) {
    const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
    return {
      tmdbId: numeric ? id : "",
      imdbId: imdb,
      type: "tv",
      season: num(seg[0]) ?? 1,
      episode: num(seg[1]) ?? 1,
    };
  }
  return null;
}

/** A byte-pipe link to one upstream resource, rewritten on the way out.
 *  `cookie` carries the case where the CDN signs the path into a cookie rather
 *  than the URL, so the pipe has to present it on every hop. `headerless` is
 *  for a CDN that refuses everything browser-shaped (vidlink's mp4 host answers
 *  428 to a browser User-Agent and 429 to the site's own referer): that hop
 *  goes out bare, and `ref=` empty is how the pipe is told to omit both. */
function pipeUrl(
  target: string,
  referer: string,
  self: string,
  cookie = "",
  headerless = false,
): string {
  const q = new URLSearchParams({ url: target, ref: referer, rewrite: "1" });
  if (cookie) q.set("ck", cookie);
  if (headerless) q.set("ua", "none");
  return `${self}?${q.toString()}`;
}

/** Re-wrap every URI in an HLS playlist so the viewer never has to face the
 *  provider's CDN itself — its gate is a referer (or a signed cookie) a browser
 *  on our site cannot claim. Both the manifests and the media they name come
 *  back through us. */
function rewritePlaylist(
  text: string,
  base: URL,
  referer: string,
  self: string,
  cookie = "",
  headerless = false,
): string {
  const wrap = (uri: string): string => {
    const abs = safeUrl(new URL(uri.trim(), base).href)?.href;
    /* Already piped, or not a fetchable resource at all: leave the line alone
       rather than hand back a URI the player cannot resolve. */
    if (!abs || abs.startsWith(self)) return uri;
    return pipeUrl(abs, referer, self, cookie, headerless);
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith("#"))
        return /URI="[^"]+"/.test(line)
          ? line.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${wrap(u)}"`)
          : line;
      return wrap(line);
    })
    .join("\n");
}

/** Provider answers live for minutes, but the walk that mints them costs
 *  seconds of handshakes and probes — and the player asks again on every mount,
 *  chip switch and reload. A short edge cache turns that repeat open into one
 *  hop; a miss is never cached, so a title the scrapers did not have is asked
 *  again on the next pass. `fresh=1` is the retry path's way of saying the
 *  cached link already died in the player. */
const ANSWER_TTL_S = 120;

async function cachedAnswer(
  request: Request,
  produce: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const fresh = url.searchParams.has("fresh");
  url.searchParams.delete("fresh");
  const key = new Request(url.toString(), { method: "GET" });
  let cache: Cache | undefined;
  try {
    cache = caches.default;
  } catch {
    cache = undefined;
  }
  if (cache && !fresh) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      /* A cache the runtime refuses to read is only slower, never wrong. */
    }
  }
  const res = await produce();
  if (cache && res.ok && !fresh) {
    try {
      const body = (await res.clone().json()) as { candidates?: unknown[] };
      if (Array.isArray(body.candidates) && body.candidates.length)
        await cache.put(
          key,
          new Response(JSON.stringify(body), {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": `public, max-age=${ANSWER_TTL_S}`,
            },
          }),
        );
    } catch {
      /* An answer that cannot round-trip through JSON is simply not cached. */
    }
  }
  return res;
}

async function resolveStreamAnswer(c: Context<Env>): Promise<Response> {
  const url = c.req.query("url") ?? "";
  if (!safeUrl(url))
    return c.json({ candidates: [], hops: [], error: "invalid url" }, 400);
  try {
    /* Ask vixsrc its own way first: the generic walk below only ever sees its
       JS shell, so a title it does hold would otherwise be written off as
       unresolvable and fall back to the iframe. */
    if (vixsrcApiPath(url)) {
      const pl = await vixsrcPlaylist(url);
      if (!pl.url)
        return c.json({ candidates: [], hops: [url], error: pl.error });
      const candidates = await playableCandidates([
        { url: pl.url, via: "vixsrc handshake" },
      ]);
      return c.json({
        candidates,
        hops: [url, pl.url],
        error: candidates.length
          ? undefined
          : "vixsrc's stream refused this player.",
      });
    }

    /* nxsha likewise builds its playlist URL inside an encrypted handshake, and
       its CDN only answers requests carrying *its* referer — which a browser on
       our site cannot send. So its sources come back piped through our own byte
       pipe with every URI in the manifest rewritten to the same pipe: the viewer
       gets plain HLS it can decode (dubs and all) while only we talk to it. */
    const nxsha = nxshaTitleOf(url);
    if (nxsha) {
      /* Reached by IMDb id (a VidSrc link, an admin row with no TMDB id): its
         API needs the number, so read it back off the page it just rendered. */
      if (!nxsha.tmdbId && nxsha.imdbId)
        nxsha.tmdbId = await nxshaTmdbOf(url, fetchPage);
      /* Settle on a scraper only if its CDN answers *us*: in production some of
         these hosts refuse a Worker's connection outright (a bare 403 with no
         body), so their links would be re-probed and thrown away by the
         candidate step below while another scraper's stream went unasked. */
      /* The walk already fetches a scraper's first links to decide whether to
         keep it; probing those same links again below would double the walk's
         network cost for a verdict this Worker already has. */
      const probed = new Map<string, Promise<StreamProbe>>();
      const probeOnce = (u: string, ref: string) => {
        const key = `${u}\u0000${ref}`;
        let p = probed.get(key);
        if (!p) {
          p = probeStream(u, ref);
          probed.set(key, p);
        }
        return p;
      };
      const sources = await nxshaStreams(nxsha, fetchPage, async (u, ref) => {
        const p = await probeOnce(u, ref);
        return p.ok && p.codec !== "hevc";
      });
      if (!sources.length)
        return c.json({
          candidates: [],
          hops: [url],
          error: "nxsha does not carry a playable stream for this title.",
        });
      const self = `${new URL(c.req.url).origin}/embed/proxy`;
      /* Validate upstream, not our own pipe: a Worker may not call itself back
         (loopback is off-limits locally, and in prod it would spend a second
         subrequest on nothing), while the referer gate means only the real
         upstream URL can prove the stream answers. */
      const candidates = await rankPlayable(
        sources.slice(0, 4).map((s) => ({
          c: {
            url: pipeUrl(s.url, s.referer, self),
            via: `nxsha · ${s.provider}`,
            quality: s.quality,
          },
          p: probeOnce(s.url, s.referer),
        })),
      );
      return c.json({
        candidates: candidates.map((x) => ({ ...x, cors: true })),
        hops: [url, ...sources.map((s) => s.url)],
        error: candidates.length
          ? undefined
          : "nxsha's streams refused this player.",
      });
    }

    /* VidNest answers its scrapers through an encrypted envelope (see
       vidnest.ts) and its upstreams gate on a referer a browser on our site
       cannot claim, so — like nxsha — its sources come back piped through us
       with every URI in the manifest re-pointed at the same pipe. That is what
       lets this server play the provider's picture under our own controls. */
    const vidnest = vidnestTitleOf(url);
    if (vidnest) {
      const sources = (await vidnestSources(vidnest, fetchPage)).slice(0, 4);
      if (!sources.length)
        return c.json({
          candidates: [],
          hops: [url],
          error: "VidNest has no stream for this title.",
        });
      const self = `${new URL(c.req.url).origin}/embed/proxy`;
      const candidates = await rankPlayable(
        sources.map((s) => ({
          c: {
            url: pipeUrl(s.url, s.referer, self),
            via: `vidnest · ${s.provider}`,
            quality: s.quality,
          },
          p: probeStream(s.url, s.referer),
        })),
      );
      return c.json({
        candidates: candidates.map((x) => ({ ...x, cors: true })),
        hops: [url, ...sources.map((s) => s.url)],
        error: candidates.length
          ? undefined
          : "VidNest's streams refused this player.",
      });
    }

    /* vidlink mints its source token inside a WASM module in the viewer's
       browser (see vidlink.ts), so the generic walk only ever watched its shell
       load. We mint that token here and ask for a streaming rendition: when it
       answers H.264 HLS the chip plays under our own controls, piped like
       nxsha's because its CDN gates on a signed CloudFront cookie. When it only
       holds the title as HEVC, the reason comes back and the stage stays with
       the provider's player instead of painting a black rectangle. */
    const vidlink = vidlinkTitleOf(url);
    if (vidlink) {
      /* The viewer's own browser is the only witness for HEVC: the page says
         `?hevc=1` when its media element claims hvc1/hev1 decode, and only then
         does a title vidlink holds as HEVC come back as a stream instead of
         handing the box to the provider's player. */
      const allowHevc = c.req.query("hevc") === "1";
      const { sources, reason } = await vidlinkSources(
        vidlink,
        (u, ref, headers) => fetchPage(u, ref, "", headers),
        { allowHevc },
      );
      if (!sources.length)
        return c.json({
          candidates: [],
          hops: [url],
          error: reason || "vidlink has no stream for this title.",
        });
      const origin = new URL(c.req.url).origin;
      const self = `${origin}/embed/proxy`;
      const dashSelf = `${origin}/embed/dash`;
      const candidates = await rankPlayable(
        sources.map((s) => ({
          c: {
            /* A DASH title cannot ride the query-string pipe: its MPD names its
               segments by relative file name, and a `?url=` cannot act as the
               base those resolve against. It gets the path-shaped pipe instead,
               which the manifest route rewrites the base of. */
            url:
              s.kind === "dash"
                ? `${dashSelf}?url=${encodeURIComponent(s.url)}&ck=${encodeURIComponent(s.cookie)}`
                : pipeUrl(
                    s.url,
                    s.headerless ? "" : s.referer,
                    self,
                    s.cookie,
                    Boolean(s.headerless),
                  ),
            via: "vidlink handshake",
            quality: s.quality,
          },
          /* A file it signed and named is its own proof: probing that CDN from
             here only adds a 429 that writes the stream off, while the viewer
             reads it through our pipe — and the page preflights the pipe itself
             before handing it to the player. The DASH answer is the same kind
             of proof: its MPD and segments were fetched by this Worker with
             that cookie while the handshake was being worked out, and the
             player reads them through the pipe, never from the CDN. */
          p:
            s.kind === "file" || s.kind === "dash"
              ? Promise.resolve<StreamProbe>({
                  ok: true,
                  kind: s.kind,
                  codec:
                    s.codec === "hevc" || s.codec === "h265"
                      ? "hevc"
                      : s.codec === "h264" || s.codec === "avc"
                        ? "h264"
                        : "unknown",
                  cors: false,
                })
              : probeStream(s.url, s.referer, s.cookie),
        })),
        { allowHevc },
      );
      return c.json({
        candidates: candidates.map((x) => ({ ...x, cors: true })),
        hops: [url, ...sources.map((s) => s.url)],
        error: candidates.length
          ? undefined
          : "vidlink's stream refused this player.",
      });
    }

    /* viduki's fourth API hands its iframe to play.xpass.top, a player that only
       looks locked down: its /data answer is an AES-GCM envelope whose key is a
       label, a build stamp, the request path and the token its own page printed
       (see xpass.ts). Open it here and every ladder's playlist.json answers with
       the plain HLS master, so this server plays under our controls too. Its
       CDNs gate on xpass's referer, so like nxsha the stream is piped through us
       with every URI re-pointed at the same pipe. When the envelope will not open
       — they rotated their build stamp, or the title is not there — the honest
       reason comes back and the stage falls to the provider's own player. */
    const xpass = xpassTitleOf(url);
    if (xpass) {
      const { sources, reason } = await xpassSources(xpass, fetchPage);
      if (!sources.length)
        return c.json({
          candidates: [],
          hops: [url],
          error: reason || "viduki has no stream for this title.",
        });
      const self = `${new URL(c.req.url).origin}/embed/proxy`;
      const candidates = await rankPlayable(
        sources.slice(0, 4).map((s) => ({
          c: {
            url: pipeUrl(s.url, s.referer, self),
            via: `viduki · ${s.quality}`,
            quality: s.quality,
          },
          p: probeStream(s.url, s.referer),
        })),
      );
      return c.json({
        candidates: candidates.map((x) => ({ ...x, cors: true })),
        hops: [url, ...sources.map((s) => s.url)],
        error: candidates.length
          ? undefined
          : "viduki's streams refused this player.",
      });
    }

    const r = await resolveEmbedStream(url);    /* A playlist pulled out of the page still has to answer for *us*: token-bound
       links 403 and HEVC-only files paint a black player, and handing those to
       the native element is what makes a working provider look broken. */
    r.candidates = await playableCandidates(r.candidates);
    if (!r.candidates.length && r.error === undefined)
      r.error = "No playable stream found behind this provider.";
    return c.json(r);
  } catch (err) {
    console.error("embed resolve failed", err);
    return c.json({ candidates: [], hops: [], error: "resolver crashed" }, 502);
  }
}

embedResolveRoutes.get("/stream", (c) =>
  cachedAnswer(c.req.raw, () => resolveStreamAnswer(c)),
);

/* ---------------- qualities (per-resolution download links) ---------------- */

interface QualityEntry {
  label: string;
  url: string;
  height?: number;
  bandwidth?: number;
}

function qualityLabel(height: number | undefined, bandwidth: number): string {
  if (height) {
    if (height >= 2160) return "4K";
    return `${height}p`;
  }
  if (bandwidth >= 4_000_000) return "1080p";
  if (bandwidth >= 2_000_000) return "720p";
  if (bandwidth >= 900_000) return "480p";
  return "360p";
}

/** Parse a master playlist into variant entries (best quality first). */
function parseMasterPlaylist(text: string, base: URL): QualityEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: QualityEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:([^\r\n]+)/);
    if (!m) continue;
    const attrs = m[1];
    const bandwidth = Number(
      attrs.match(/BANDWIDTH=(\d+)/)?.[1] ??
        attrs.match(/AVERAGE-BANDWIDTH=(\d+)/)?.[1] ??
        0,
    );
    const res = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
    const height = res ? Number(res[2]) : undefined;
    let uri = "";
    let uriAt = i;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (t.startsWith("#")) break;
      uri = t;
      uriAt = j;
      break;
    }
    if (!uri) continue;
    const abs = safeUrl(new URL(uri, base).href)?.href;
    if (abs)
      entries.push({ label: qualityLabel(height, bandwidth), url: abs, height, bandwidth });
    i = uriAt; // continue scanning after the URI line
  }
  // Highest resolution first; keep only the best entry per label.
  entries.sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
  );
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.label) ? false : (seen.add(e.label), true)));
}

embedResolveRoutes.get("/qualities", async (c) => {
  const raw = c.req.query("url") ?? "";
  /* A stream that reached the browser as one of our own byte-pipe links has to
     be read through that pipe's *upstream*: its CDN answers only the provider's
     referer, so fetching the pipe would mean a Worker calling itself back and
     fetching the provider raw would forget the header. Unwrap both halves —
     but only when the link really is our pipe, so a provider URL that merely
     carries a `url` parameter cannot aim this fetch elsewhere — and hand the
     resolutions back piped, so a download manager needs no headers of its own. */
  let outer: URL | null = null;
  try {
    outer = new URL(raw);
  } catch {
    return c.json({ kind: "empty", entries: [], error: "invalid url" }, 400);
  }
  const ours =
    outer.pathname.endsWith("/embed/proxy") &&
    outer.hostname === new URL(c.req.url).hostname;
  const inner = ours ? safeUrl(outer.searchParams.get("url") ?? "") : null;
  const target = inner?.href ?? safeUrl(raw)?.href;
  if (!target) return c.json({ kind: "empty", entries: [], error: "invalid url" }, 400);
  const referer = inner
    ? outer.searchParams.get("ref") || `${inner.origin}/`
    : `${new URL(target).origin}/`;
  /* The same signed cookie the stream itself was piped with, or the master
     playlist behind that pipe answers 403 and the menu shows no resolutions. */
  const cookie = inner ? outer.searchParams.get("ck") || "" : "";
  const self = `${new URL(c.req.url).origin}/embed/proxy`;
  const wrap = (u: string) => (inner ? pipeUrl(u, referer, self, cookie) : u);
  try {
    const res = await fetchPage(target, referer, cookie);
    const finalUrl = safeUrl(res.url)?.href ?? target;
    const ctype = res.headers.get("content-type") ?? "";
    const text = await res.text();

    if (ctype.includes("mpegurl") || text.trimStart().startsWith("#EXTM3U")) {
      const entries = parseMasterPlaylist(text, new URL(finalUrl)).map((e) => ({
        ...e,
        url: wrap(e.url),
      }));
      if (entries.length) return c.json({ kind: "hls", entries });
      // Media playlist — no variants, but the playlist itself is the stream.
      return c.json({
        kind: "hls",
        entries: [{ label: "Original", url: wrap(finalUrl) }],
      });
    }
    if (
      ctype.startsWith("video/") ||
      /\.(mp4|mkv|webm|mov|m4v)(\?|$)/i.test(target)
    )
      return c.json({
        kind: "direct",
        entries: [{ label: "Original", url: wrap(finalUrl) }],
      });

    const found = extractM3u8(text, new URL(finalUrl));
    return c.json({
      kind: found.length ? "hls" : "empty",
      entries: found.slice(0, 8).map((f) => ({ label: "Stream", url: wrap(f.url) })),
    });
  } catch (err) {
    console.error("quality probe failed", err);
    return c.json({ kind: "empty", entries: [], error: "fetch failed" }, 502);
  }
});

/* ---------------- downloads (per-title, every embed server) ---------------- */

interface TitleRef {
  tmdb: string;
  imdb: string;
  kind: "movie" | "tv";
  season: number;
  episode: number;
}

interface DownloadProvider {
  name: string;
  entries: QualityEntry[];
}

type Extractor = (t: TitleRef) => Promise<QualityEntry[]>;

/** Resolve a provider page with the generic chain-walker, then expand the
 *  best candidate's master playlist into per-resolution entries. */
function pageExtractor(name: string, page: (t: TitleRef) => string): { name: string; extract: Extractor } {
  return {
    name,
    async extract(t) {
      const r = await resolveEmbedStream(page(t));
      for (const cand of r.candidates.slice(0, 2)) {
        try {
          const res = await fetchPage(cand.url, new URL(cand.url).origin);
          const text = await res.text();
          if (!text.trimStart().startsWith("#EXTM3U")) continue;
          const variants = parseMasterPlaylist(text, new URL(safeUrl(res.url)?.href ?? cand.url));
          if (variants.length) return variants;
        } catch {
          /* one bad candidate should not kill the provider */
        }
      }
      return r.candidates.map((cand) => ({ label: "Stream", url: cand.url }));
    },
  };
}

/* Providers whose streams are extractable with plain HTTP (verified against
   TMDB 603 / 119052). New extractors plug in here. */
const downloadExtractors: { name: string; extract: Extractor }[] = [
  /* The direct API is the only one that labels each upstream with its own
     resolution, so it fills the Download menu with real per-quality links. */
  {
    name: "Direct",
    async extract(t) {
      if (!t.tmdb) return [];
      const { sources } = await durbinSources(t.tmdb, t.kind, t.season, t.episode);
      const playable = await playableCandidates(
        sources.map((s) => ({ url: s.url, via: s.via, quality: s.quality }) as Candidate),
      );
      return playable.map((c) => ({
        label: c.quality || (c.kind === "hls" ? "Stream" : "Original"),
        url: c.url,
      }));
    },
  },
  pageExtractor("VidLink", (t) =>
    t.kind === "tv"
      ? `https://vidlink.pro/tv/${t.tmdb}/${t.season}/${t.episode}`
      : `https://vidlink.pro/movie/${t.tmdb}`,
  ),
  /* Its scrapers name every resolution they hold, so this fills the Download
     menu with real per-quality links instead of walking a page shell. */
  {
    name: "VidNest",
    async extract(t) {
      if (!t.tmdb) return [];
      const sources = await vidnestSources(
        { tmdbId: t.tmdb, type: t.kind, season: t.season, episode: t.episode },
        fetchPage,
      );
      return sources.slice(0, 8).map((s) => ({
        label: s.quality || (s.hls ? "Stream" : "Original"),
        url: s.url,
      }));
    },
  },
  pageExtractor("Videasy", (t) =>
    t.kind === "tv"
      ? `https://player.videasy.to/tv/${t.tmdb}/${t.season}/${t.episode}`
      : `https://player.videasy.to/movie/${t.tmdb}`,
  ),
];

embedResolveRoutes.get("/downloads", async (c) => {
  const tmdb = (c.req.query("tmdb") ?? "").replace(/\D/g, "");
  const imdb = /^tt\d{6,9}$/.test(c.req.query("imdb") ?? "") ? c.req.query("imdb")! : "";
  if (!tmdb && !imdb) return c.json({ providers: [], error: "no usable id" }, 400);
  const ref: TitleRef = {
    tmdb,
    imdb,
    kind: c.req.query("kind") === "tv" ? "tv" : "movie",
    season: Math.min(200, Math.max(1, Number(c.req.query("season")) || 1)),
    episode: Math.min(1000, Math.max(1, Number(c.req.query("episode")) || 1)),
  };
  const settled = await Promise.allSettled(
    downloadExtractors.map(async (p) => ({ name: p.name, entries: await p.extract(ref) })),
  );
  const providers: DownloadProvider[] = settled
    .map((r) => (r.status === "fulfilled" && r.value.entries.length ? r.value : null))
    .filter((p): p is DownloadProvider => p !== null);
  return c.json({ providers });
});

/* ---------------- is this provider's page really the title? ---------------- */

/** Per host: does the server-rendered page prove it carries what was asked?
 *
 *  A provider page is only worth framing if it plays something. Several of
 *  them answer a missing title with their own "not available" wall at HTTP 200,
 *  so a status code cannot tell the two apart — but the SSR `<title>` can,
 *  wherever the provider bothers to render one. Only a positive answer counts:
 *  hosts with no usable marker report `false` and the caller keeps whatever it
 *  has instead of guessing. */
function pageCarries(host: string, title: string, body: string): boolean {
  const t = title.trim();
  if (host.endsWith("nxsha.app")) return /^watch\b/i.test(t);
  if (host.endsWith("xpass.top"))
    /* viduki's fourth API prints the show's own name for a title it carries and
       an empty `<title>` for one it does not — both at HTTP 200. */
    return t.length > 1 && !/^(player|loading|error|404)/i.test(t);
  if (host.endsWith("vidlink.pro"))
    /* Its movie pages inline the whole TMDB record (escaped inside the Next.js
       payload, hence the bare key); its TV pages are a bare shell for every id,
       carried or not, so TV can never be confirmed. */
    return body.includes("original_title");
  return false;
}

/** Videasy has no server-rendered answer about a title: its page is the same
 *  200 shell for every TMDB id and the "We couldnt find that" wall is painted
 *  later, in the browser, once its sources back end comes back empty. That back
 *  end (`api.speedracelight.com`) feeds all nine of its providers and answers a
 *  plain per-title seed handshake, so it is the only witness worth asking:
 *  a 5xx there means videasy can play nothing for anybody right now, and a
 *  frame of its page can only show the viewer a dead provider.
 *
 *  Only an unambiguous server error is reported as down. A 4xx is a refusal
 *  aimed at *our* egress (these hosts block datacenter traffic while an
 *  ordinary connection opens their player) and says nothing about the title, so
 *  it comes back `null` and the caller keeps the server as it is. */
async function videasyBackendDown(mediaId: string): Promise<boolean | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.speedracelight.com/seed?mediaId=${encodeURIComponent(mediaId)}`,
      {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: "https://player.videasy.to/",
          Origin: "https://player.videasy.to",
          Accept: "application/json",
        },
      },
    );
    void res.body?.cancel().catch(() => undefined);
    if (res.status >= 500) return true;
    return res.ok ? false : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

embedResolveRoutes.get("/pageinfo", async (c) => {
  const safe = safeUrl(c.req.query("url") ?? "");
  if (!safe) return c.json({ live: false, carried: false, title: "" }, 400);
  try {
    const res = await fetchPage(safe.href, safe.origin + "/");
    /* A 4xx here is the provider refusing *our* connection, not saying its page
       is gone: vixsrc.to answers Cloudflare Worker egress 403 while the same URL
       loads for the viewer's own browser. Calling that dead writes off a server
       that plays, so it comes back live-but-blocked and the caller keeps the
       chip with its own honest reason. A 404 is the one refusal that really
       means "no page". */
    if (res.status >= 400 && res.status < 500 && res.status !== 404)
      return c.json({
        live: true,
        carried: false,
        blocked: true,
        title: "",
        reason: `${safe.hostname} refused our resolver (${res.status})`,
      });
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      return c.json({
        live: false,
        carried: false,
        title: "",
        reason: res.ok ? "" : `${safe.hostname} answered ${res.status}`,
      });
    }
    /* The marker we look for is in the document head/first payload — reading a
       slice keeps a 200KB shell from being pulled through the Worker. */
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (body.length < 48_000) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    void reader.cancel().catch(() => undefined);
    const title = /<title[^>]*>([^<]{1,200})/i.exec(body)?.[1] ?? "";
    let host = safe.hostname;
    try {
      if (res.url) host = new URL(res.url).hostname;
    } catch {
      /* keep the requested host */
    }
    if (host.endsWith("videasy.to")) {
      const mediaId = /\/(?:movie|tv|anime)\/(\d{1,9})/.exec(safe.pathname)?.[1] ?? "";
      if (mediaId && (await videasyBackendDown(mediaId)) === true)
        return c.json({
          live: false,
          carried: false,
          title: title.trim(),
          reason: "videasy's source back end is offline",
        });
    }
    return c.json({
      live: true,
      carried: pageCarries(host, title, body),
      title: title.trim(),
    });
  } catch (err) {
    console.error("page info failed", err);
    return c.json({ live: false, carried: false, title: "" });
  }
});

/* CORS-friendly byte pipe so the browser can fetch provider playlists and
   media segments (their CDNs rarely send Access-Control-Allow-Origin).
   Also the escape hatch for external download managers: the link is plain,
   public and needs no browser headers, so IDM/aria2c/xdownloader can pull it
   directly. Range requests are passed through and the upstream byte metadata
   is echoed back, otherwise multi-connection managers see a length mismatch
   and abort the file. */
const RANGE_HEADERS = ["content-length", "content-range", "last-modified", "etag"];

/* ---------------- DASH pipe (vidlink's HEVC titles) ----------------
 *
 * An MPD names its segments by relative file name, so the query-string pipe is
 * no use here: `?url=` cannot be the base a relative name resolves against, and
 * the provider rewrites its own player URLs the same way. The manifest is served
 * from /embed/dash with a <BaseURL> pointing at the path-shaped pipe below, so
 * `init-stream0.m4s` both resolves and fetches through us exactly as written.
 * The signed cookie its CDN gates on travels inside that path and never reaches
 * the browser as a header it could not send. */

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/** Keep one video rendition in an MPD, leaving audio untouched. The player
 *  asks for this when the viewer pins a resolution: MSE on this platform
 *  cannot swap HEVC renditions inside one source, so the engine is restarted
 *  on a manifest that only carries the chosen rung. */
function onlyVideoRepresentation(mpd: string, rep: string): string {
  return mpd.replace(
    /(<AdaptationSet[^>]*contentType="video"[^>]*>)([\s\S]*?)(<\/AdaptationSet>)/i,
    (_whole, open: string, body: string, close: string) =>
      open +
      body.replace(
        /<Representation[^>]*\/>|<Representation[^>]*>[\s\S]*?<\/Representation>/g,
        (r) => (r.match(/id="([^"]+)"/)?.[1] === rep ? r : ""),
      ) +
      close,
  );
}

/** Manifests are the slowest hop of a start: the player asks for the master,
 *  then the variant it names, and each is a trip to a CDN that may sit half a
 *  world away. They change only when the provider rotates its tokens, so a
 *  minute of edge cache keeps a re-open (and every seek-triggered refetch) off
 *  the upstream path. Segments are never cached here. */
const MANIFEST_TTL_S = 60;

async function manifestCacheGet(key: Request): Promise<Response | null> {
  try {
    return (await caches.default.match(key)) ?? null;
  } catch {
    return null;
  }
}

async function manifestCachePut(key: Request, res: Response): Promise<void> {
  try {
    await caches.default.put(key, res);
  } catch {
    /* Not cached is only slower. */
  }
}

embedResolveRoutes.get("/dash", async (c) => {
  const mpd = safeUrl(c.req.query("url") ?? "");
  if (!mpd) return c.json({ error: "invalid url" }, 400);
  const cookie = c.req.query("ck") ?? "";
  const rep = (c.req.query("rep") ?? "").trim();
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const hit = await manifestCacheGet(cacheKey);
  if (hit) return hit;
  try {
    const res = await fetch(mpd.href, {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: mpd.origin + "/",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return new Response(null, { status: res.status || 502 });
    }
    const text = await res.text();
    if (!/<MPD[\s>]/i.test(text))
      return c.json({ error: "upstream answered something that is not a manifest" }, 502);
    const base = safeUrl(res.url)?.href ?? mpd.href;
    const dir = base.slice(0, base.lastIndexOf("/") + 1);
    const origin = new URL(c.req.url).origin;
    const segBase = `${origin}/embed/dash/s/${b64url(dir)}/${b64url(cookie)}/`;
    /* Segment names stay relative on purpose: dash.js substitutes its own
       `$RepresentationID$` / `$Number$` templates into them, which an encoded
       link would have broken. */
    const narrowed = /^[A-Za-z0-9_-]+$/.test(rep)
      ? onlyVideoRepresentation(text, rep)
      : text;
    const out = narrowed.replace(
      /<Period\b[^>]*>/i,
      (m) => `${m}\n    <BaseURL>${segBase}</BaseURL>`,
    );
    const answer = new Response(out, {
      status: 200,
      headers: {
        "Content-Type": "application/dash+xml",
        "Cache-Control": `public, max-age=${MANIFEST_TTL_S}`,
      },
    });
    await manifestCachePut(cacheKey, answer.clone());
    return answer;
  } catch (err) {
    console.error("dash manifest failed", err);
    return c.json({ error: "fetch failed" }, 502);
  }
});

embedResolveRoutes.get("/dash/s/:dir/:ck/:file", async (c) => {
  const dir = safeUrl(unb64url(c.req.param("dir")));
  const file = c.req.param("file");
  if (!dir || !/^[A-Za-z0-9._-]+$/.test(file)) return c.json({ error: "invalid path" }, 400);
  const cookie = unb64url(c.req.param("ck"));
  const range = c.req.header("range");
  try {
    const res = await fetch(dir.href + file, {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: dir.origin + "/",
        Accept: "*/*",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(range ? { Range: range } : {}),
      },
    });
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      return new Response(null, { status: res.status || 502 });
    }
    const headers: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    for (const h of RANGE_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    console.error("dash segment failed", err);
    return c.json({ error: "fetch failed" }, 502);
  }
});

embedResolveRoutes.get("/proxy", async (c) => {
  const url = c.req.query("url") ?? "";
  const safe = safeUrl(url);
  if (!safe) return c.json({ error: "invalid url" }, 400);
  /* `rewrite=1` turns the pipe into a playable stream: the fetched manifest has
     every URI it names re-pointed at this same endpoint, so a provider whose
     CDN only answers its own referer can still be watched in our player. */
  const rewrite = c.req.query("rewrite") === "1";
  /* `ref=` empty (and a `ua=none` that comes with it) is a headerless hop: some
     CDNs refuse to serve a video at all when the request looks like a browser
     or names the provider — vidlink's mp4 host answers 428 to any browser
     User-Agent and 429 to a vidlink Referer — and answer a bare request with
     the bytes. Omitted, `ref` still defaults to the upstream origin. */
  const refQuery = c.req.query("ref");
  const referer = refQuery === undefined ? safe.origin + "/" : refQuery;
  const headerless = c.req.query("ua") === "none" || referer === "";
  /* A CDN that gates on a signed cookie (CloudFront, on vidlink's pipes) hands
     it to us as a query parameter, and every manifest URI this route rewrites
     carries the same one — so the segments stream through without the browser
     ever seeing a header it cannot send. */
  const cookie = c.req.query("ck") ?? "";
  /* Every byte request is forwarded: a progressive file (vidlink's HEVC mp4s)
     is seeked by Range, and dropping the header would leave our player with a
     movie it can only watch from the top. A manifest never gets seeked, but a
     CDN that dislikes a Range on one answers 4xx — so the ask is retried
     without the header rather than reported as a dead stream. */
  const range = c.req.header("range");
  /* A manifest is the same rewrite every time it is asked for, and the player
     asks twice per start (master, then the variant it named). Byte requests and
     Range probes always go upstream untouched. */
  const manifestKey = rewrite && !range ? new Request(c.req.url, { method: "GET" }) : null;
  if (manifestKey) {
    const hit = await manifestCacheGet(manifestKey);
    if (hit) return hit;
  }
  const ask = (withRange: boolean) =>
    fetch(safe.href, {
      redirect: "follow",
      headers: {
        ...(headerless ? {} : { "User-Agent": BROWSER_UA, Referer: referer, Origin: safe.origin }),
        Accept: "*/*",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(withRange && range ? { Range: range } : {}),
      },
    });
  try {
    let res = await ask(Boolean(range));
    /* A manifest never gets seeked, but a player still probes one with a Range
       now and then, and some CDNs answer that with a range-specific refusal.
       Only those are retried without the header: a 403 or 429 is the CDN's real
       answer, and asking twice only digs the rate limit deeper. */
    if (range && (res.status === 400 || res.status === 406 || res.status === 416)) {
      void res.body?.cancel().catch(() => undefined);
      res = await ask(false);
    }
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (
      rewrite &&
      res.ok &&
      res.body &&
      (ctype.includes("mpegurl") || ctype.includes("mpeg"))
    ) {
      const text = await res.text();
      const base = safeUrl(res.url)?.href ?? safe.href;
      const self = `${new URL(c.req.url).origin}/embed/proxy`;
      const answer = new Response(
        rewritePlaylist(text, new URL(base), referer, self, cookie, headerless),
        {
          status: 200,
          headers: {
            "Content-Type": res.headers.get("content-type") ?? "application/vnd.apple.mpegurl",
            /* Its variant links carry their own short-lived tokens. */
            "Cache-Control": `public, max-age=${MANIFEST_TTL_S}`,
          },
        },
      );
      if (manifestKey) await manifestCachePut(manifestKey, answer.clone());
      return answer;
    }
    if (!res.ok || !res.body)
      return new Response(null, { status: res.status || 502 });
    const headers: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    for (const h of RANGE_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    /* A filename makes managers save instead of stream, and names the file. */
    const name = (c.req.query("name") ?? "").replace(/["\r\n\t\\]/g, "").slice(0, 80);
    if (name) headers["Content-Disposition"] = `attachment; filename="${name}"`;
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    console.error("proxy fetch failed", err);
    return c.json({ error: "fetch failed" }, 502);
  }
});
