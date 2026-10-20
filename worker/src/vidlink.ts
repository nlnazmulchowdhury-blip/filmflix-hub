/**
 * vidlink.pro (the "VidBox" chip) — server-side stream extraction.
 *
 * Its player page looks unresolvable from the outside: the source API is
 * `/api/b/{movie|tv}/{token}` and that token is minted inside the viewer's
 * browser by a Go-to-WASM module (`fu.wasm`) calling libsodium's
 * `crypto_secretbox_easy`, so the generic page-walk only ever watched a shell
 * load and the chip could only ever frame the provider's own screen.
 *
 * The handshake is not actually a session: the key is a constant inside that
 * WASM, the nonce the client always sends is 24 zero bytes, and the plaintext
 * is `<TMDB id in ASCII> · 4 zero bytes · unix time as 4 big-endian bytes`.
 * So the token can be minted here — which is what `secretbox` below does, with
 * XSalsa20-Poly1305 vendored in (Workers' WebCrypto has no secretbox, and this
 * keeps the deploy free of a new dependency).
 *
 * What the answer contains is decided by one request header, `X-Playback-
 * Environment`, whose value its own client picks from what the browser can
 * decode: `webkit`/`hls` ask for a streaming rendition, and the provider then
 * answers either HLS H.264 (which plays in our player) or DASH/MP4 HEVC
 * (which most browsers cannot). We ask for `hls` and keep only the H.264
 * answer: on the titles where vidlink holds nothing but HEVC, the chip stays
 * with the provider's own player rather than painting a black rectangle.
 *
 * The playlist and its segments sit behind a signed CloudFront cookie
 * (`requiresProxy: true` in its own words), so they are piped through
 * /embed/proxy with that cookie, exactly like nxsha's and VidNest's sources.
 */

export const VIDLINK_HOST = "vidlink.pro";
const VIDLINK_API = `https://${VIDLINK_HOST}`;

/** The constant `fu.wasm` carries as the secretbox key. */
const SECRET_HEX = "c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd";

/** Its client always sends the same all-zero nonce, so the token depends only
 *  on the id and the clock. */
const NONCE = new Uint8Array(24);

const ASK_TIMEOUT_MS = 9_000;

export interface VidlinkTitle {
  tmdbId: string;
  type: "movie" | "tv";
  season: number;
  episode: number;
}

export interface VidlinkSource {
  url: string;
  quality: string;
  /** The referer its CDN expects (its own `playlistHeaders`). */
  referer: string;
  /** The signed CloudFront cookie its CDN gates on. */
  cookie: string;
  /** What the handshake actually served. `"file"` is a progressive mp4 whose
   *  exact codec and URL the provider itself named, so the caller can trust it
   *  without re-probing (whose 429 would kill a stream the browser can play). */
  kind?: "hls" | "file";
  /** The codec the provider declared for this source, lower-cased. */
  codec?: string;
}

/** Its page fetcher, with one extra channel: this API only answers with a
 *  streaming rendition when `X-Playback-Environment` rides along, and the
 *  generic fetcher in embedresolve.ts has no way to say that. */
type PageGetter = (
  url: string,
  referer: string,
  headers?: Record<string, string>,
) => Promise<Response>;

/** Its page URL → the ids its API wants, or null for any other host.
 *  Pages are `/movie/{tmdb}` and `/tv/{tmdb}/{season}/{episode}`. */
export function vidlinkTitleOf(raw: string): VidlinkTitle | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== VIDLINK_HOST) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  const num = (s?: string) => (s && /^\d+$/.test(s) ? s : "");
  if (seg[0] === "movie" && num(seg[1]))
    return { tmdbId: seg[1], type: "movie", season: 1, episode: 1 };
  if (seg[0] === "tv" && num(seg[1]))
    return {
      tmdbId: seg[1],
      type: "tv",
      season: num(seg[2]) ? Number(seg[2]) : 1,
      episode: num(seg[3]) ? Number(seg[3]) : 1,
    };
  return null;
}

/* ---------------- vendored crypto_secretbox (XSalsa20-Poly1305) ------------- */

/* "expa", "nd 3", "2-by", "te k" read as little-endian words. */
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function le32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function putLe32(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 255;
  b[i + 1] = (v >>> 8) & 255;
  b[i + 2] = (v >>> 16) & 255;
  b[i + 3] = (v >>> 24) & 255;
}

/** The 20-round Salsa20 mixing step, in place over the 16 state words. */
function salsaMix(x: Int32Array): void {
  for (let r = 0; r < 10; r++) {
    x[4] ^= rotl((x[0] + x[12]) | 0, 7);
    x[8] ^= rotl((x[4] + x[0]) | 0, 9);
    x[12] ^= rotl((x[8] + x[4]) | 0, 13);
    x[0] ^= rotl((x[12] + x[8]) | 0, 18);
    x[9] ^= rotl((x[5] + x[1]) | 0, 7);
    x[13] ^= rotl((x[9] + x[5]) | 0, 9);
    x[1] ^= rotl((x[13] + x[9]) | 0, 13);
    x[5] ^= rotl((x[1] + x[13]) | 0, 18);
    x[14] ^= rotl((x[10] + x[6]) | 0, 7);
    x[2] ^= rotl((x[14] + x[10]) | 0, 9);
    x[6] ^= rotl((x[2] + x[14]) | 0, 13);
    x[10] ^= rotl((x[6] + x[2]) | 0, 18);
    x[3] ^= rotl((x[15] + x[11]) | 0, 7);
    x[7] ^= rotl((x[3] + x[15]) | 0, 9);
    x[11] ^= rotl((x[7] + x[3]) | 0, 13);
    x[15] ^= rotl((x[11] + x[7]) | 0, 18);
    x[1] ^= rotl((x[0] + x[3]) | 0, 7);
    x[2] ^= rotl((x[1] + x[0]) | 0, 9);
    x[3] ^= rotl((x[2] + x[1]) | 0, 13);
    x[0] ^= rotl((x[3] + x[2]) | 0, 18);
    x[6] ^= rotl((x[5] + x[4]) | 0, 7);
    x[7] ^= rotl((x[6] + x[5]) | 0, 9);
    x[4] ^= rotl((x[7] + x[6]) | 0, 13);
    x[5] ^= rotl((x[4] + x[7]) | 0, 18);
    x[11] ^= rotl((x[10] + x[9]) | 0, 7);
    x[8] ^= rotl((x[11] + x[10]) | 0, 9);
    x[9] ^= rotl((x[8] + x[11]) | 0, 13);
    x[10] ^= rotl((x[9] + x[8]) | 0, 18);
    x[12] ^= rotl((x[15] + x[14]) | 0, 7);
    x[13] ^= rotl((x[12] + x[15]) | 0, 9);
    x[14] ^= rotl((x[13] + x[12]) | 0, 13);
    x[15] ^= rotl((x[14] + x[13]) | 0, 18);
  }
}

/** HSalsa20: hash the key together with the first 16 nonce bytes into the
 *  sub-key XSalsa20 then runs with. Returns the 8 output words. */
function hsalsa20(key: Uint8Array, nonce: Uint8Array): number[] {
  const x = Int32Array.from([
    SIGMA[0], le32(key, 0), le32(key, 4), le32(key, 8),
    le32(key, 12), SIGMA[1], le32(nonce, 0), le32(nonce, 4),
    le32(nonce, 8), le32(nonce, 12), SIGMA[2], le32(key, 16),
    le32(key, 20), le32(key, 24), le32(key, 28), SIGMA[3],
  ]);
  salsaMix(x);
  return [x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]];
}

/** One 64-byte Salsa20 block for the sub-key, the last 8 nonce bytes and a
 *  64-bit little-endian counter. */
function salsa20Block(subKey: number[], nonceTail: Uint8Array, counter: number, out: Uint8Array): void {
  const y = [
    SIGMA[0], subKey[0], subKey[1], subKey[2],
    subKey[3], SIGMA[1], le32(nonceTail, 0), le32(nonceTail, 4),
    counter, 0, SIGMA[2], subKey[4],
    subKey[5], subKey[6], subKey[7], SIGMA[3],
  ];
  const x = Int32Array.from(y);
  salsaMix(x);
  for (let i = 0; i < 16; i++) putLe32(out, i * 4, (x[i] + y[i]) | 0);
}

function xsalsa20Keystream(key: Uint8Array, nonce: Uint8Array, length: number): Uint8Array {
  const sub = hsalsa20(key, nonce.subarray(0, 16));
  const tail = nonce.subarray(16, 24);
  const out = new Uint8Array(length);
  const block = new Uint8Array(64);
  for (let off = 0; off < length; off += 64) {
    salsa20Block(sub, tail, off / 64, block);
    out.set(block.subarray(0, Math.min(64, length - off)), off);
  }
  return out;
}

const POLY_P = (1n << 130n) - 5n;
const POLY_R_MASK = 0x0ffffffc0ffffffc0ffffffc0fffffffn;
const TAG_128 = (1n << 128n) - 1n;

function leBytes(b: Uint8Array, from: number, len: number): bigint {
  let v = 0n;
  for (let i = from + len - 1; i >= from; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

/** Poly1305 over `msg` with the 32-byte one-time key `key`. */
function poly1305(msg: Uint8Array, key: Uint8Array): Uint8Array {
  const r = leBytes(key, 0, 16) & POLY_R_MASK;
  const s = leBytes(key, 16, 16);
  let acc = 0n;
  for (let off = 0; off < msg.length; off += 16) {
    const len = Math.min(16, msg.length - off);
    /* The high bit added past the bytes is the padding Poly1305 requires. */
    const n = leBytes(msg, off, len) | (1n << BigInt(8 * len));
    acc = ((acc + n) * r) % POLY_P;
  }
  const tag = (acc + s) & TAG_128;
  const out = new Uint8Array(16);
  let v = tag;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** libsodium's `crypto_secretbox_easy(msg, nonce, key)` → `tag ‖ ciphertext`. */
function secretbox(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  /* NaCl's padded form: 32 leading zero bytes ride through the cipher, the
     first 32 keystream bytes come back as the Poly1305 key and the rest XORs
     the message. */
  const padded = new Uint8Array(32 + msg.length);
  padded.set(msg, 32);
  const stream = xsalsa20Keystream(key, nonce, padded.length);
  for (let i = 0; i < padded.length; i++) padded[i] ^= stream[i];
  const authKey = padded.subarray(0, 32);
  const ct = padded.subarray(32);
  const tag = poly1305(ct, authKey);
  const out = new Uint8Array(16 + ct.length);
  out.set(tag, 0);
  out.set(ct, 16);
  return out;
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function secretKey(): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = parseInt(SECRET_HEX.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The token its API accepts for one title: nonce ‖ secretbox(id · pad · time). */
export function vidlinkToken(id: string, at = Math.floor(Date.now() / 1000)): string {
  /* Four pad bytes then the unix time big-endian — the layout its own WASM
     builds, and the clock is what the tag binds. */
  const msg = new Uint8Array(id.length + 8);
  for (let i = 0; i < id.length; i++) msg[i] = id.charCodeAt(i);
  msg[id.length + 4] = (at >>> 24) & 255;
  msg[id.length + 5] = (at >>> 16) & 255;
  msg[id.length + 6] = (at >>> 8) & 255;
  msg[id.length + 7] = at & 255;
  const box = secretbox(msg, NONCE, secretKey());
  const all = new Uint8Array(NONCE.length + box.length);
  all.set(NONCE, 0);
  all.set(box, NONCE.length);
  return base64Url(all);
}

/* ---------------- the handshake ---------------- */

function headerOf(headers: Record<string, unknown> | undefined, name: string): string {
  if (!headers) return "";
  for (const [k, v] of Object.entries(headers))
    if (k.toLowerCase() === name.toLowerCase() && typeof v === "string") return v.trim();
  return "";
}

/** Its `qualities` map is keyed by height and every entry names its own codec:
 *  one title can be H.264 at 480 and HEVC at 1080. Take the tallest rendition
 *  *this* player can decode, and never an HEVC file unless the viewer's own
 *  browser said it decodes HEVC (`?hevc=1`, from `browserDecodesHevc()`). */
function pickFileQuality(
  qualities: Record<string, any> | undefined,
  allowHevc: boolean,
): { url: string; quality: string; codec: string } | null {
  const rows = Object.entries(qualities ?? {})
    .filter(([, q]) => q?.type === "mp4" && typeof q?.url === "string" && /^https?:\/\//.test(q.url))
    .map(([h, q]) => ({
      height: Number(h) || 0,
      url: q.url as string,
      codec: String(q.codecName ?? "").toLowerCase(),
    }))
    .sort((a, b) => b.height - a.height);
  const best = rows.find((r) => allowHevc || (r.codec && r.codec !== "hevc"));
  if (!best) return null;
  return {
    url: best.url,
    quality: best.height === 2160 ? "4K" : best.height ? `${best.height}p` : "File",
    codec: best.codec,
  };
}

/** Ask its API for one title and keep the answer our player can actually use.
 *
 *  Empty means "vidlink has nothing we can play here" — the title is not in its
 *  catalog, or it only holds it as HEVC and this viewer cannot decode HEVC,
 *  which paints a black rectangle. The caller then leaves the chip on the
 *  provider's own player instead of handing over a dead stream. */
export async function vidlinkSources(
  title: VidlinkTitle,
  get: PageGetter,
  opts: { allowHevc?: boolean } = {},
): Promise<{ sources: VidlinkSource[]; reason: string }> {
  const tail = title.type === "tv" ? `/${title.season}/${title.episode}` : "";
  const page = `https://${VIDLINK_HOST}/${title.type}/${title.tmdbId}${tail}`;
  const api = `${VIDLINK_API}/api/b/${title.type}/${vidlinkToken(title.tmdbId)}${tail}?multiLang=0`;
  let obj: any;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ASK_TIMEOUT_MS);
    let res: Response;
    try {
      /* The one header that decides the container. Without it the API answers
         its default — a single HEVC MP4 that our player can only paint black
         for — and with it a client that reports HLS support gets H.264. */
      res = await get(api, page, { "X-Playback-Environment": "hls" });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    /* A wall page or a bare `null` both mean it will not serve this title. */
    if (!res.ok || !text.trim() || text.trim() === "null")
      return { sources: [], reason: "vidlink does not carry this title" };
    try {
      obj = JSON.parse(text);
    } catch {
      return { sources: [], reason: "vidlink answered something that was not a stream" };
    }
  } catch (err) {
    return { sources: [], reason: `vidlink API failed: ${String(err)}` };
  }

  const s = obj?.stream ?? {};
  const codec = String(s?.playbackMetadata?.codecName ?? "").toLowerCase();
  const playlist = typeof s.playlist === "string" ? s.playlist.trim() : "";
  if (s.type !== "hls" || !playlist) {
    /* Its progressive answer. `requiresProxy` is its own flag for "our CDN only
       answers a proxied request", so this goes through `/embed/proxy` with the
       provider's referer exactly like its HLS does. */
    const file = pickFileQuality(s.qualities, Boolean(opts.allowHevc));
    if (!file)
      return {
        sources: [],
        reason: opts.allowHevc
          ? `vidlink only has this title as ${String(s.type ?? "nothing").toUpperCase()}`
          : `vidlink holds this title only as HEVC, which this player cannot decode.`,
      };
    return {
      sources: [
        {
          url: file.url,
          quality: file.quality,
          kind: "file" as const,
          codec: file.codec,
          referer: headerOf(s.fileHeaders, "Referer") || `https://${VIDLINK_HOST}/`,
          cookie: headerOf(s.fileHeaders, "Cookie"),
        },
      ],
      reason: "",
    };
  }
  if (codec && codec !== "h264" && codec !== "avc")
    return { sources: [], reason: `vidlink's stream for this title is ${codec.toUpperCase()}-only` };
  const url = /^https?:\/\//.test(playlist) ? playlist : "";
  if (!url) return { sources: [], reason: "vidlink gave a playlist we cannot fetch" };
  const heights = (s.playbackMetadata?.resolutions ?? []) as unknown[];
  const quality = heights.length ? `${String(heights[0]) === "2160" ? "4K" : `${heights[0]}p`}` : "";
  return {
    sources: [
      {
        url,
        quality,
        referer: headerOf(s.playlistHeaders, "Referer") || new URL(url).origin + "/",
        cookie: headerOf(s.playlistHeaders, "Cookie"),
      },
    ],
    reason: "",
  };
}
