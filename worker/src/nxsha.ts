/**
 * nxsha (web.nxsha.app) — server-side stream extraction.
 *
 * Its player page is a Next.js shell, and the two API calls behind it accept
 * their whole query string as a single `q` parameter encrypted with AES-256-CBC
 * in CryptoJS' passphrase mode — the OpenSSL "Salted__" envelope, whose key and
 * IV come from MD5-based EVP_BytesToKey. Workers' WebCrypto has no MD5, so the
 * digest is implemented here; AES itself comes from `crypto.subtle`.
 *
 * What it buys: `nitro` answers with ordinary multilingual HLS (H.264 video +
 * separate dub renditions), which plays in our own player instead of the
 * provider's iframe. The catch is that its CDN is referer-gated — every request
 * has to carry `Referer: https://web.nxsha.app/`, which a browser cannot forge —
 * so the caller pipes the playlist through our own byte pipe and rewrites the
 * URIs inside it.
 */

export const NXSHA_HOST = "web.nxsha.app";
export const NXSHA_BASE = `https://${NXSHA_HOST}`;

/** The passphrase its bundled player ships (the same literal since the scrape
 *  was found; a rotation only costs us the fallback to its iframe). */
const NXSHA_PASSPHRASE =
  "f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3";

/** Scrapers to ask first, best first: `nitro` is the one verified to answer with
 *  plain multilingual HLS across several resolutions. The rest of its list is
 *  still walked after these (see `nxshaStreams`) because titles do live on them
 *  alone — `castle`, `purstream`, `vixolity` and `ophim` all answered with a
 *  real `#EXTM3U` — while `mbox`/`imovr`/`yomovies` and the other
 *  `web_support: false` entries are cookie-bound and answer empty. */
const PREFERRED = ["nitro", "watchout", "stvv", "em-8"];

/** Its list carries ~15 web-usable scrapers. Walking all of them for a title
 *  nobody has would spend 15 round trips on a request the viewer is waiting on,
 *  so the walk stops at this many asks (each one costs ~100-300 ms). */
const MAX_SCRAPER_ASKS = 10;

export interface NxshaTitle {
  tmdbId: string;
  imdbId: string;
  type: "movie" | "tv";
  season?: number;
  episode?: number;
}

export interface NxshaSource {
  url: string;
  quality: string;
  provider: string;
  /** Some scrapers name the referer their CDN wants to see. */
  referer: string;
}

/** One fetch that may follow redirects and must respect a deadline — the same
 *  helper the rest of the resolver uses, injected to keep this module free of
 *  the route file's internals. */
type PageGetter = (url: string, referer: string) => Promise<Response>;

/* --------------------------- MD5 --------------------------- */

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

const MD5_K = (() => {
  const k = new Int32Array(64);
  for (let i = 0; i < 64; i++)
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  return k;
})();

/** The one hash WebCrypto refuses to give us — nxsha's KDF is MD5 all the way
 *  down, so it lives here (~30 lines, standard RFC 1321 word order). */
function md5(input: Uint8Array): Uint8Array {
  const size = (Math.floor((input.length + 8) / 64) + 1) * 64;
  const msg = new Uint8Array(size);
  msg.set(input);
  msg[input.length] = 0x80;
  const view = new DataView(msg.buffer);
  const bits = input.length * 8;
  view.setUint32(size - 8, bits >>> 0, true);
  view.setUint32(size - 4, Math.floor(bits / 4294967296), true);

  let a = 0x67452301 | 0;
  let b = 0xefcdab89 | 0;
  let c = 0x98badcfe | 0;
  let d = 0x10325476 | 0;
  const words = new Int32Array(16);

  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(off + i * 4, true);
    let fa = a;
    let fb = b;
    let fc = c;
    let fd = d;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (fb & fc) | (~fb & fd);
        g = i;
      } else if (i < 32) {
        f = (fd & fb) | (~fd & fc);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = fb ^ fc ^ fd;
        g = (3 * i + 5) & 15;
      } else {
        f = fc ^ (fb | ~fd);
        g = (7 * i) & 15;
      }
      f = (f + fa + MD5_K[i] + words[g]) | 0;
      fa = fd;
      fd = fc;
      fc = fb;
      const s = MD5_SHIFT[i];
      fb = (fb + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a = (a + fa) | 0;
    b = (b + fb) | 0;
    c = (c + fc) | 0;
    d = (d + fd) | 0;
  }

  const out = new Uint8Array(16);
  const o = new DataView(out.buffer);
  o.setUint32(0, a >>> 0, true);
  o.setUint32(4, b >>> 0, true);
  o.setUint32(8, c >>> 0, true);
  o.setUint32(12, d >>> 0, true);
  return out;
}

/* --------------------- base64 + KDF + envelope --------------------- */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i] << 16) |
      ((bytes[i + 1] ?? 0) << 8) |
      (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, p);
}

/** OpenSSL EVP_BytesToKey (MD5, one round per block) → 32-byte key + 16-byte IV. */
function evpBytesToKey(salt: Uint8Array): { key: Uint8Array; iv: Uint8Array } {
  const pass = new TextEncoder().encode(NXSHA_PASSPHRASE);
  const material: Uint8Array[] = [];
  let filled = 0;
  let prev: Uint8Array = new Uint8Array(0);
  while (filled < 48) {
    const block = new Uint8Array(prev.length + pass.length + salt.length);
    block.set(prev);
    block.set(pass, prev.length);
    block.set(salt, prev.length + pass.length);
    prev = md5(block);
    material.push(prev);
    filled += prev.length;
  }
  const joined = new Uint8Array(48);
  let at = 0;
  for (const m of material) {
    joined.set(m.subarray(0, Math.min(m.length, 48 - at)), at);
    at += m.length;
  }
  return { key: joined.subarray(0, 32), iv: joined.subarray(32, 48) };
}

const aesKey = (bytes: Uint8Array, usage: "encrypt" | "decrypt") =>
  crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, [usage]);

/** CryptoJS' request envelope: the payload plus the two fields its client adds,
 *  AES-CBC over an MD5-derived key, wrapped as `Salted__` + salt, base64 in the
 *  URL-safe alphabet its router expects. */
async function encryptQuery(payload: object): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const { key, iv } = evpBytesToKey(salt);
  const body = JSON.stringify({
    ...payload,
    _req_ts: Date.now(),
    _req_salt: Math.random().toString(36).slice(2, 12),
  });
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    await aesKey(key, "encrypt"),
    new TextEncoder().encode(body),
  );
  const cipherBytes = new Uint8Array(cipher);
  const envelope = new Uint8Array(16 + cipherBytes.length);
  envelope.set(new TextEncoder().encode("Salted__"), 0);
  envelope.set(salt, 8);
  envelope.set(cipherBytes, 16);
  return toBase64(envelope)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Its answers come back the same way, under a single `_hash` field. */
async function decryptAnswer(text: string): Promise<Record<string, unknown> | null> {
  let hash = text;
  try {
    const json = JSON.parse(text) as { _hash?: string };
    hash = json._hash ?? "";
  } catch {
    return null;
  }
  if (!hash) return null;
  const raw = fromBase64(hash);
  if (raw.length < 32) return null;
  const { key, iv } = evpBytesToKey(raw.subarray(8, 16));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      await aesKey(key, "decrypt"),
      raw.subarray(16),
    );
    const value = JSON.parse(new TextDecoder().decode(plain));
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/* --------------------------- the API walk --------------------------- */

async function ask(
  path: string,
  payload: object,
  referer: string,
  get: PageGetter,
): Promise<Record<string, unknown> | null> {
  try {
    const q = await encryptQuery(payload);
    const res = await get(`${NXSHA_BASE}${path}?q=${encodeURIComponent(q)}`, referer);
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const answer = await decryptAnswer(await res.text());
    if (!answer) return null;
    delete answer._req_ts;
    delete answer._req_salt;
    return answer;
  } catch {
    return null;
  }
}

/** The numeric TMDB id nxsha inlines into its own embed page.
 *
 *  Its routes accept an IMDb id — and its player resolves the title from that —
 *  but its *API* is keyed on the TMDB number: `imdb_id` alone answers an empty
 *  server list. So an `tt…` link has to be turned into the number before
 *  `/api/servers` can be asked, and the page it already rendered for that id
 *  carries the answer (`tmdbId":2734` inside its escaped JSON payload). */
export async function nxshaTmdbOf(
  pageUrl: string,
  get: PageGetter,
): Promise<string> {
  try {
    const res = await get(pageUrl, `${NXSHA_BASE}/`);
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return "";
    }
    const reader = res.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let head = "";
    while (head.length < 200_000) {
      const { value, done } = await reader.read();
      head += decoder.decode(value, { stream: true });
      const hit = head.match(/tmdbId\\?["']?\s*:\s*\\?["']?(\d{1,8})/);
      if (hit) {
        void reader.cancel().catch(() => undefined);
        return hit[1];
      }
      if (done) break;
    }
    void reader.cancel().catch(() => undefined);
    return "";
  } catch {
    return "";
  }
}

/** One stream as its API describes it, cleaned for a viewer.
 *  Several entries arrive as `"<internal-name> | 1080P | Hindi"`; the leading
 *  lowercase slug is that scraper's own key, not something about the picture,
 *  so it is dropped — while a real label like "Hindi | English | 1080P" is left
 *  alone (its words are capitalised). */
function sourceLabel(raw: unknown, scraper: string): string {
  const text = String(raw ?? scraper).replace(/\s+/g, " ").trim();
  const stripped = text.replace(/^[a-z][a-z0-9_-]*\s*\|\s*/, "");
  return (stripped || text).slice(0, 40);
}

/** Ask nxsha which upstream hosts carry this title, then pull the playlists.
 *
 *  The server list is only a routing table (and the guard against scraping one
 *  that needs a cookie), so a title with no usable entry simply returns an
 *  empty list — the caller then falls back to framing its iframe. */
export async function nxshaStreams(
  title: NxshaTitle,
  get: PageGetter,
): Promise<NxshaSource[]> {
  const core = {
    tmdbId: title.tmdbId,
    imdb_id: title.imdbId,
    type: title.type,
    ...(title.type === "tv"
      ? { season: String(title.season ?? 1), episode: String(title.episode ?? 1) }
      : {}),
  };

  const list = await ask("/api/servers", core, `${NXSHA_BASE}/`, get);
  const servers = Array.isArray(list?.servers)
    ? (list!.servers as { scraper?: string; web_support?: boolean }[])
    : [];
  /* A scraper the list marks `web_support: false` is cookie-bound and answers
     empty, so it is dropped. Favourites go first — they carry several dubs and
     several resolutions — but the walk does not STOP at them: a title can live
     on exactly one of the others (Dovlatov was only on `vixolity`, an episode
     of a talk show only on `castle`/`purstream`/`ophim`), and asking only the
     favourites made nxsha look empty for those while its own player streamed
     them. The list call itself can fail, and an empty source list is
     indistinguishable from a title this provider does not carry, so the caller
     still falls back to framing its iframe. */
  const usable = servers
    .filter(
      (s) => typeof s.scraper === "string" && s.web_support !== false,
    )
    .map((s) => s.scraper as string);
  const order = [
    ...(servers.length
      ? [
          ...PREFERRED.filter((p) => usable.includes(p)),
          ...usable.filter((p) => !PREFERRED.includes(p)),
        ]
      : PREFERRED),
  ].slice(0, MAX_SCRAPER_ASKS);

  const found: NxshaSource[] = [];
  for (const scraper of order) {
    const answer = await ask(
      "/api/sources",
      { ex_lang: false, provider: scraper, ...core },
      `${NXSHA_BASE}/`,
      get,
    );
    const sources = Array.isArray(answer?.sources)
      ? (answer!.sources as Record<string, unknown>[])
      : [];
    const playable = sources
      .filter(
        (s) =>
          !s.isEmbed &&
          s.type === "m3u8" &&
          typeof s.url === "string" &&
          /^https?:\/\//.test(s.url as string),
      )
      .map((s) => {
        const headers = (s.headers ?? {}) as Record<string, string>;
        return {
          url: s.url as string,
          quality: sourceLabel(s.quality ?? s.label, scraper),
          provider: scraper,
          /* Some scrapers name the referer their CDN wants to see. */
          referer: headers.referer || headers.Referer || `${NXSHA_BASE}/`,
        };
      });
    /* Two scrapers often hand back the same CDN link under different names, and
       the player cannot use a duplicate twice. */
    for (const s of playable.slice(0, 4))
      if (!found.some((f) => f.url === s.url)) found.push(s);
    /* One scraper that really carries the title is enough to stop on — its own
       list already spans the resolutions and the dubs. */
    if (found.length >= 3) break;
  }
  return found.slice(0, 6);
}
