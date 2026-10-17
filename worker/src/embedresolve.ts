import { Hono } from "hono";
import type { Env } from "./index";

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
  kind?: "hls" | "file";
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

async function fetchPage(url: string, referer: string): Promise<Response> {
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
  kind: "hls" | "file" | "dead";
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

async function probeStream(rawUrl: string): Promise<StreamProbe> {
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
        Referer: url.origin + "/",
        Origin: url.origin,
        Accept: "*/*",
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

/** Order probed candidates the way the player wants them: H.264 first (the
 *  browser can decode it), CORS-open next (hls.js can fetch it without the
 *  proxy), and never a HEVC-only stream — that is the black rectangle viewers
 *  blame the whole site for. */
async function rankPlayable(
  items: { c: Candidate; p: Promise<StreamProbe> }[],
): Promise<Candidate[]> {
  const checked = await Promise.all(items.map(async (x) => ({ c: x.c, p: await x.p })));
  return checked
    .filter((x) => x.p.ok && x.p.codec !== "hevc")
    .sort((a, b) => {
      const rank = (x: { p: StreamProbe }) =>
        (x.p.codec === "h264" ? 0 : 1) + (x.p.cors ? 0 : 2);
      return rank(a) - rank(b);
    })
    .map((x) => ({
      ...x.c,
      kind: x.p.kind === "hls" ? ("hls" as const) : ("file" as const),
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

embedResolveRoutes.get("/direct", async (c) => {
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
});

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

embedResolveRoutes.get("/stream", async (c) => {
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

    const r = await resolveEmbedStream(url);
    /* A playlist pulled out of the page still has to answer for *us*: token-bound
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
});

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
  const url = c.req.query("url") ?? "";
  if (!safeUrl(url))
    return c.json({ kind: "empty", entries: [], error: "invalid url" }, 400);
  try {
    const res = await fetchPage(url, new URL(url).origin);
    const finalUrl = safeUrl(res.url)?.href ?? url;
    const ctype = res.headers.get("content-type") ?? "";
    const text = await res.text();

    if (ctype.includes("mpegurl") || text.trimStart().startsWith("#EXTM3U")) {
      const entries = parseMasterPlaylist(text, new URL(finalUrl));
      if (entries.length) return c.json({ kind: "hls", entries });
      // Media playlist — no variants, but the playlist itself is the stream.
      return c.json({ kind: "hls", entries: [{ label: "Original", url: finalUrl }] });
    }
    if (
      ctype.startsWith("video/") ||
      /\.(mp4|mkv|webm|mov|m4v)(\?|$)/i.test(url)
    )
      return c.json({ kind: "direct", entries: [{ label: "Original", url: finalUrl }] });

    const found = extractM3u8(text, new URL(finalUrl));
    return c.json({
      kind: found.length ? "hls" : "empty",
      entries: found.slice(0, 8).map((f) => ({ label: "Stream", url: f.url })),
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
  pageExtractor("VidNest", (t) =>
    t.kind === "tv"
      ? `https://vidnest.fun/tv/${t.tmdb}/${t.season}/${t.episode}`
      : `https://vidnest.fun/movie/${t.tmdb}`,
  ),
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
  if (host.endsWith("vidlink.pro"))
    /* Its movie pages inline the whole TMDB record (escaped inside the Next.js
       payload, hence the bare key); its TV pages are a bare shell for every id,
       carried or not, so TV can never be confirmed. */
    return body.includes("original_title");
  return false;
}

embedResolveRoutes.get("/pageinfo", async (c) => {
  const safe = safeUrl(c.req.query("url") ?? "");
  if (!safe) return c.json({ live: false, carried: false, title: "" }, 400);
  try {
    const res = await fetchPage(safe.href, safe.origin + "/");
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      return c.json({ live: false, carried: false, title: "" });
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

embedResolveRoutes.get("/proxy", async (c) => {
  const url = c.req.query("url") ?? "";
  const safe = safeUrl(url);
  if (!safe) return c.json({ error: "invalid url" }, 400);
  const range = c.req.header("range");
  try {
    const res = await fetch(safe.href, {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: c.req.query("ref") ?? safe.origin + "/",
        Origin: safe.origin,
        Accept: "*/*",
        ...(range ? { Range: range } : {}),
      },
    });
    if (!res.ok || !res.body)
      return new Response(null, { status: res.status || 502 });
    const headers: Record<string, string> = {
      "Content-Type":
        res.headers.get("content-type") ?? "application/octet-stream",
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
