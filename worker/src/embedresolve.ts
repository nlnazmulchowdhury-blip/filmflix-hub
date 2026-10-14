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
