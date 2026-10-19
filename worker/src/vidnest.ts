/**
 * VidNest (vidnest.fun) — server-side stream extraction.
 *
 * Its player is a Next.js app and the scraper back end behind it
 * (`new.vidnest.fun`) answers every ask with an AES-256-GCM envelope: the key is
 * SHA-256("<per-response nonce>|<secret its bundle ships>"), the IV is the first
 * 12 bytes of the base64url blob and the rest decrypts to the provider's JSON.
 * The request itself has to carry a random 16-byte `_n` query nonce, or the edge
 * answers 403 — which is why the generic page-walking resolver only ever saw an
 * empty shell on this server.
 *
 * Most of its scraper entries name a `…/hls/{token}/…` pipe on one of the
 * provider's own Workers. That token is the real upstream URL plus the headers
 * its CDN gates on, so unwrapping it here yields the same per-resolution sources
 * its own player picks from.
 *
 * Known gap: only the movie scrapers answer today. Every
 * `{path}/tv/{id}/{season}/{episode}` request 502s at the origin — for its own
 * site as much as for us — so a series keeps falling back to framing its
 * iframe, or to another server that does carry it.
 */

export const VIDNEST_PAGE_HOST = "vidnest.fun";
const VIDNEST_API = "https://new.vidnest.fun";

/** The literal its bundled player ships; a rotation costs us nothing worse than
 *  the iframe fallback (the same bargain as nxsha's passphrase). */
const CIPHER_SECRET = "F9k2mR8vL4qP7wY1zN0fG3bS6tH5jC8d_x4R7vN2mP9qL1";

/** Scrapers to ask, best first, all sharing one path shape. `vidlink` is left
 *  out: it 502s at the origin for every title we tried. */
const PROVIDERS: { path: string; name: string }[] = [
  { path: "flixhq", name: "Beta" },
  { path: "onehd", name: "Alfa" },
  { path: "rpmvid", name: "Prime" },
  { path: "ophim", name: "Lamda" },
  { path: "nextgencloudfabric", name: "Zeta" },
  { path: "yflix", name: "Catflix" },
  { path: "klikxxi", name: "Ophim" },
  { path: "vidzee", name: "Gama" },
];

const ASK_TIMEOUT_MS = 9_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export interface VidnestTitle {
  tmdbId: string;
  type: "movie" | "tv";
  season: number;
  episode: number;
}

export interface VidnestSource {
  url: string;
  /** Resolution and dub language when the scraper names them ("1080p Hindi"). */
  quality: string;
  provider: string;
  /** The referer the upstream CDN expects to see. */
  referer: string;
  /** False for a plain file (`.mkv`, `.mp4`): the browser can usually take an
   *  HLS playlist and often cannot take a container, so HLS sorts first. */
  hls: boolean;
}

type PageGetter = (url: string, referer: string) => Promise<Response>;

/** Its page URL → the ids its API wants, or null for any other host. */
export function vidnestTitleOf(raw: string): VidnestTitle | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== VIDNEST_PAGE_HOST && !host.endsWith("." + VIDNEST_PAGE_HOST)) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  while (seg.length && seg[0] !== "movie" && seg[0] !== "tv" && seg[0] !== "series") seg.shift();
  const kind = seg.shift();
  const id = (seg.shift() ?? "").trim();
  if (!/^\d{1,8}$/.test(id) || !kind) return null;
  const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : 1);
  return kind === "tv" || kind === "series"
    ? { tmdbId: id, type: "tv", season: num(seg[0]), episode: num(seg[1]) }
    : { tmdbId: id, type: "movie", season: 1, episode: 1 };
}

function fromBase64Url(text: string): Uint8Array {
  let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The `_n` its client generates: 16 random bytes, base64url, unpadded. */
function streamNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function decryptPayload(encoded: string, nonce: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${nonce}|${CIPHER_SECRET}`),
    );
    const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
    const blob = fromBase64Url(encoded);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12) },
      key,
      blob.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Read a scraper's answer, encrypted or plain. */
async function jsonOfResponse(res: Response): Promise<any | null> {
  const text = await res.text();
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (obj && typeof obj.d === "string" && typeof obj.n === "string") {
    const plain = await decryptPayload(obj.d, obj.n);
    if (!plain) return null;
    try {
      return JSON.parse(plain);
    } catch {
      return null;
    }
  }
  return obj;
}

interface Unwrapped {
  url: string;
  quality: string;
  referer: string;
}

function refererOf(headers: Record<string, unknown>, fallback: string): string {
  const ref = headers?.Referer ?? headers?.referer;
  return typeof ref === "string" && /^https?:\/\//.test(ref) ? ref : fallback;
}

/** Unwrap one of its `/hls/{token}` pipes: the token is base64url JSON naming
 *  either `{v:[{u,q}],h}` (every resolution at once) or a single `{u,h}`. Both
 *  are the *upstream* URL, so the provider's own proxy drops out of the chain. */
function unwrapPipe(raw: string): Unwrapped[] {
  const token = raw.match(/\/hls\/([A-Za-z0-9_-]{16,})/)?.[1];
  if (!token) return [];
  let obj: any;
  try {
    obj = JSON.parse(new TextDecoder().decode(fromBase64Url(token)));
  } catch {
    return [];
  }
  const headers = (obj?.h ?? {}) as Record<string, unknown>;
  const items: any[] = Array.isArray(obj?.v) ? obj.v : obj?.u ? [obj] : [];
  return items
    .map((item) => ({
      url: typeof item?.u === "string" ? item.u.trim() : "",
      quality: typeof item?.q === "string" ? item.q : "",
      referer: refererOf(headers, originOf(String(item?.u ?? ""))),
    }))
    .filter((i) => /^https?:\/\//.test(i.url));
}

function labelOf(quality: unknown, language: unknown): string {
  const q = String(quality ?? "").trim();
  const lang = String(language ?? "").trim();
  const parts: string[] = [];
  if (q && !/^auto$/i.test(q)) parts.push(q);
  if (lang && !/^(original|default|auto)$/i.test(lang)) parts.push(lang);
  return parts.join(" · ").slice(0, 40);
}

/** One scraper's decrypted answer → playable sources, whatever shape it came in.
 *  The providers disagree on the container: `{streams:[…]}`, `{sources:[…]}` and
 *  a bare `{url}` all appear, and each names its own header gate. */
function entriesOf(obj: any, provider: string): VidnestSource[] {
  const list: any[] = Array.isArray(obj?.streams)
    ? obj.streams
    : Array.isArray(obj?.sources)
      ? obj.sources
      : obj?.url
        ? [obj]
        : [];
  const out: VidnestSource[] = [];
  for (const item of list) {
    const raw = typeof item?.url === "string" ? item.url.trim() : "";
    if (!raw) continue;
    const headers = (item?.headers ?? {}) as Record<string, unknown>;
    const unwrapped = unwrapPipe(raw);
    if (unwrapped.length) {
      for (const u of unwrapped) {
        out.push({
          url: u.url,
          quality: u.quality || labelOf(item?.quality, item?.language),
          provider,
          referer: u.referer || refererOf(headers, originOf(u.url)),
          hls: !/\.(mp4|m4v|mov|mkv|webm)(\?|$)/i.test(new URL(u.url).pathname),
        });
      }
      continue;
    }
    if (!/^https?:\/\//.test(raw)) continue;
    out.push({
      url: raw,
      quality: labelOf(item?.quality, item?.language),
      provider,
      referer: refererOf(headers, originOf(raw)),
      hls: !/\.(mp4|m4v|mov|mkv|webm)(\?|$)/i.test(new URL(raw).pathname),
    });
  }
  return out;
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin + "/";
  } catch {
    return `https://${VIDNEST_PAGE_HOST}/`;
  }
}

/** Ask every scraper at once and return their sources, best first.
 *
 *  Concurrent rather than in turn: this feeds the provider race, where the first
 *  answer wins and one slow scraper must not hold up the seven others. A scraper
 *  that 502s or answers empty is simply absent from the list. */
export async function vidnestSources(
  title: VidnestTitle,
  get: PageGetter,
): Promise<VidnestSource[]> {
  const tail = title.type === "tv" ? `/${title.season}/${title.episode}` : "";
  const settled = await Promise.allSettled(
    PROVIDERS.map(async (p) => {
      const url = `${VIDNEST_API}/${p.path}/${title.type}/${title.tmdbId}${tail}?_n=${streamNonce()}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            "User-Agent": BROWSER_UA,
            Referer: `https://${VIDNEST_PAGE_HOST}/`,
            Accept: "application/json",
          },
        });
        const obj = await jsonOfResponse(res);
        if (!res.ok || !obj) throw Error(`${p.name} answered ${res.status}`);
        return entriesOf(obj, p.name);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const seen = new Set<string>();
  const all: VidnestSource[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const s of r.value) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      all.push(s);
    }
  }
  /* A named resolution is worth more to the player and the Download menu than
     an "auto" master, and a container the browser may not decode is worth least
     of all. */
  return all.sort((a, b) => {
    const score = (s: VidnestSource) =>
      (s.hls ? 0 : 2) + (/\d{3,4}p|4K/i.test(s.quality) ? 0 : 1);
    return score(a) - score(b);
  });
}
