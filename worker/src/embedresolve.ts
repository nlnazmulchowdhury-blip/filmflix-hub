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

interface Candidate {
  url: string;
  via: string;
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

embedResolveRoutes.get("/stream", async (c) => {
  const url = c.req.query("url") ?? "";
  if (!safeUrl(url))
    return c.json({ candidates: [], hops: [], error: "invalid url" }, 400);
  try {
    return c.json(await resolveEmbedStream(url));
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

/* CORS-friendly byte pipe so the browser can fetch provider playlists and
   media segments (their CDNs rarely send Access-Control-Allow-Origin). */
embedResolveRoutes.get("/proxy", async (c) => {
  const url = c.req.query("url") ?? "";
  const safe = safeUrl(url);
  if (!safe) return c.json({ error: "invalid url" }, 400);
  try {
    const res = await fetch(safe.href, {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: c.req.query("ref") ?? safe.origin + "/",
        Origin: safe.origin,
        Accept: "*/*",
      },
    });
    if (!res.ok || !res.body)
      return new Response(null, { status: res.status || 502 });
    return new Response(res.body, {
      headers: {
        "Content-Type":
          res.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("proxy fetch failed", err);
    return c.json({ error: "fetch failed" }, 502);
  }
});
