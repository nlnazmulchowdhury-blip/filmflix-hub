/**
 * viduki.net — server-side stream extraction for its fourth API.
 *
 * The site's own four "APIs" are four back ends. Two of them (its /1 and /2
 * pages) mint their stream inside a WASM module after an ALTCHA proof-of-work
 * handshake, which no resolver can reproduce. The fourth one is different: its
 * page hands our iframe to `play.xpass.top`, and that player only *appears*
 * locked down. Its `/data/...` answer is an AES-256-GCM envelope, but the key
 * is SHA-256 over a label, a build stamp, the request path and the token the
 * page itself printed — all of it readable without running their code. Once the
 * envelope opens it lists the ladders, and each ladder's `playlist.json` answers
 * as **plain JSON** with the real HLS master.
 *
 * The upstream CDNs (`…1x2.space`, `…4pa.top`) gate on a referer a browser on
 * our site cannot claim, so the sources go back piped through `/embed/proxy`
 * with every URI re-pointed at the same pipe — the same bargain as nxsha,
 * VidNest and vidlink. That is what lets this server run the provider's picture
 * under our own play button, volume and progress bar.
 *
 * Known gap: the build stamp is a constant its bundler writes. When they
 * redeploy, decryption fails, the reason comes back and this chip falls to the
 * provider's own player — a worse picture, never a black one.
 */

export const XPASS_HOST = "play.xpass.top";
export const VIDUKI_HOST = "viduki.net";

const XPASS_BASE = `https://${XPASS_HOST}`;
/** The CDN's gate: its segments 403 for any other referer. */
const PLAYBACK_REFERER = `${XPASS_BASE}/`;

const CIPHER_LABEL = "spv3-data-response";
const CIPHER_BUILD = "spv3-build-1787821613-50e5fc97c9dce367";

/** Its list runs to 40+ entries for a popular show; asking for all of them
 *  would spend the Worker's subrequest budget on ladders we never play. */
const MAX_LADDERS = 6;

export interface XpassTitle {
  tmdbId: string;
  type: "movie" | "tv";
  season: number;
  episode: number;
}

export interface XpassSource {
  url: string;
  /** The name its own quality menu shows ("VIP 1", "TIK 2"). */
  quality: string;
  referer: string;
}

type PageGetter = (url: string, referer: string) => Promise<Response>;

/** Its API picker numbers (viduki.net/1..4) and its own player route ("e") both
 *  precede the media path, so they are skipped rather than matched. */
export function xpassTitleOf(raw: string): XpassTitle | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const mine = (base: string) => host === base || host.endsWith("." + base);
  if (!mine(VIDUKI_HOST) && !mine(XPASS_HOST)) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  while (seg.length && !["movie", "tv", "series", "episode"].includes(seg[0])) seg.shift();
  const kind = seg.shift();
  const id = (seg.shift() ?? "").trim();
  /* Its routes only understand the TMDB number; an IMDb `tt…` id has no lookup
     here, so this server simply is not offered for those titles. */
  if (!kind || !/^\d{1,9}$/.test(id)) return null;
  const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : 1);
  return kind === "tv" || kind === "series" || kind === "episode"
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

/** key = SHA-256("label|build|/data/movie/550|<token>"), iv = the blob's first
 *  12 bytes — the exact recipe its bundled player runs, minus its obfuscation. */
async function openEnvelope(encoded: string, dataPath: string, token: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${CIPHER_LABEL}|${CIPHER_BUILD}|${dataPath}|${token}`),
    );
    const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
    const blob = fromBase64Url(encoded.trim());
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

/** Its answers are short; `get` already puts a deadline on every ask, so this
 *  only adds the referer its pages expect and turns the body into text. */
async function ask(url: string, get: PageGetter, referer: string): Promise<string> {
  const res = await get(url, referer);
  return await res.text();
}

/** Its own menu puts VIP on top and WIS near the bottom; keep that order so the
 *  best ladder is also the first one the player is handed. */
const RANK: [RegExp, number][] = [
  [/^vip/i, 0],
  [/^tik/i, 1],
  [/^fil/i, 2],
  [/^sbp/i, 3],
  [/^wis/i, 4],
];

function rankOf(name: string): number {
  for (const [re, n] of RANK) if (re.test(name)) return n;
  return 9;
}

export interface XpassResult {
  sources: XpassSource[];
  reason: string;
}

/** Page → signed data URL → decrypted ladder list → one HLS master each. */
export async function xpassSources(title: XpassTitle, get: PageGetter): Promise<XpassResult> {
  const path =
    title.type === "tv"
      ? `tv/${title.tmdbId}/${title.season}/${title.episode}`
      : `movie/${title.tmdbId}`;
  const pageUrl = `${XPASS_BASE}/e/${path}?autostart=true`;

  const page = await ask(pageUrl, get, `https://${VIDUKI_HOST}/`).catch(() => "");
  const dataUrl = (page.match(/dataUrl="([^"]+)"/) || [])[1];
  if (!dataUrl)
    return { sources: [], reason: "viduki does not carry this title or episode." };

  let target: URL;
  try {
    target = new URL(`${XPASS_BASE}${dataUrl}`);
  } catch {
    return { sources: [], reason: "viduki's player page is malformed." };
  }
  const token = target.searchParams.get("token") ?? "";
  const plain = await openEnvelope(
    await ask(target.href, get, pageUrl).catch(() => ""),
    target.pathname,
    token,
  );
  if (!plain)
    return {
      sources: [],
      reason: "viduki changed its build key, so its answer would not open.",
    };

  let list: any[];
  try {
    list = JSON.parse(plain);
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || !list.length)
    /* An id it does not hold still gets a signed data URL — its player opens
       the envelope and finds an empty ladder list. That is "not here", and the
       only reason worth showing the viewer. */
    return { sources: [], reason: "viduki does not carry this title or episode." };

  const ranked = list
    .filter((e) => typeof e?.url === "string" && e.url.startsWith("/"))
    .sort((a, b) => rankOf(String(a?.name)) - rankOf(String(b?.name)))
    .slice(0, MAX_LADDERS);

  const settled = await Promise.allSettled(
    ranked.map(async (entry) => {
      const text = await ask(`${XPASS_BASE}${entry.url}`, get, pageUrl);
      const file = JSON.parse(text)?.playlist?.[0]?.sources?.[0]?.file;
      if (typeof file !== "string" || !/^https?:\/\//.test(file)) throw Error("no file");
      return { url: file, quality: String(entry.name ?? "viduki"), referer: PLAYBACK_REFERER } as XpassSource;
    }),
  );

  const sources: XpassSource[] = [];
  const seen = new Set<string>();
  for (const r of settled) {
    if (r.status !== "fulfilled" || seen.has(r.value.url)) continue;
    seen.add(r.value.url);
    sources.push(r.value);
  }
  return sources.length
    ? { sources, reason: "" }
    : { sources: [], reason: "viduki's ladders are all empty for this title." };
}
