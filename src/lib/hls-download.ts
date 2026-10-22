/**
 * In-browser HLS → MP4 downloader.
 *
 * Provider CDNs rarely allow cross-origin reads, so every byte goes through
 * the Worker's /embed/proxy pipe. MPEG-TS playlists are remuxed with mux.js;
 * fMP4 playlists are stitched (init segment + media segments) straight into
 * an .mp4 container.
 *
 * Robustness rules (the reason downloads used to fail):
 *  - the Referer the player succeeded with is replayed on every request,
 *  - a segment gets 3 attempts before it is skipped, and one missing segment
 *    never aborts the whole file,
 *  - every request carries a deadline, because a CDN socket that opens and
 *    then stays silent used to freeze a download part-way through the film,
 *  - segments are muxed in windows, because a feature film is over a gigabyte
 *    and its raw bytes must not be held next to their own muxed output,
 *  - a playlist is recognised by its first bytes, not by its file name, since
 *    several providers name their manifests without `.m3u8`,
 *  - AES-128 encrypted playlists are decrypted with WebCrypto, because most
 *    provider CDNs serve `#EXT-X-KEY` streams, and a stream whose key will not
 *    load reports failure rather than saving ciphertext.
 */
import { Transmuxer } from "mux.js/lib/mp4/transmuxer";
import { apiBase } from "@/lib/apiConfig";

/** ArrayBuffer-backed view — WebCrypto and Blob both reject the generic
 *  `Uint8Array<ArrayBufferLike>` in this TS lib configuration. */
type Bytes = Uint8Array<ArrayBuffer>;

/** One link of our own byte pipe → the upstream URL it carries, or "".
 *  A resolver can hand back a stream that is already piped (its CDN only answers
 *  the provider's referer), and every helper below has to see through that
 *  wrapper instead of wrapping it a second time. */
export function pipedTarget(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    if (!u.pathname.endsWith("/embed/proxy")) return "";
    return u.searchParams.get("url") ?? "";
  } catch {
    return "";
  }
}

/** Direct, header-free link: usable by the browser, by IDM, or by curl. */
export function proxyUrl(url: string, referer?: string, name?: string): string {
  const inner = pipedTarget(url);
  if (inner) {
    /* Already piped — it knows its own referer, and pointing the pipe at itself
       would send the Worker to fetch its own hostname. */
    if (!name) return url;
    const u = new URL(url, window.location.href);
    u.searchParams.set("name", name);
    return u.toString();
  }
  const q = new URLSearchParams({ url });
  if (referer) q.set("ref", referer);
  if (name) q.set("name", name);
  return `${apiBase()}/embed/proxy?${q.toString()}`;
}

interface FetchOpts {
  referer?: string;
  attempts?: number;
}

/** Generous for a real segment (a few seconds through the pipe), short enough
 *  that a socket which stops answering cannot hold a whole window open. */
const TIMEOUT_MS = 25000;

async function raw(url: string, referer?: string): Promise<Response> {
  /* fetch never gives up on its own. One CDN socket that opens and then says
     nothing used to freeze a download at a third of the film forever — the
     window it sat in could not finish, so nothing behind it could start. A
     deadline turns that into a retry, and a dead segment into a skip. */
  return fetch(proxyUrl(url, referer), { signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function fetchBytes(url: string, opts: FetchOpts = {}): Promise<Bytes> {
  const attempts = opts.attempts ?? 3;
  let last = "network error";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await raw(url, opts.referer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      last = String(err);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`fetch failed: ${last}`);
}

async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const attempts = opts.attempts ?? 3;
  let last = "network error";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await raw(url, opts.referer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      last = String(err);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`fetch failed: ${last}`);
}

interface Segment {
  url: string;
  /** AES-128 key URI + IV for this segment, when the playlist encrypts it. */
  keyUri: string | null;
  iv: Bytes | null;
}

interface MediaPlaylist {
  segments: Segment[];
  initSegment: string | null;
  initKeyUri: string | null;
  initIv: Bytes | null;
  isTs: boolean;
  /** Present for methods we cannot decrypt (SAMPLE-AES, FairPlay). */
  unsupportedEncryption: boolean;
}

function absolutize(uri: string, base: string): string {
  return new URL(uri, base).href;
}

function hexToBytes(hex: string): Bytes {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Segment IV defaults to the media sequence number, big-endian (RFC 8216). */
function seqIv(seq: number): Bytes {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(seq));
  return iv;
}

function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let initSegment: string | null = null;
  let keyUri: string | null = null;
  let keyIv: Bytes | null = null;
  let unsupportedEncryption = false;
  let seq = 0;
  const init = { seq: 0 };
  for (const line of lines) {
    const t = line.trim();
    const map = t.match(/^#EXT-X-MAP:URI="([^"]+)"/i);
    if (map) initSegment = absolutize(map[1], baseUrl);
    const mediaSeq = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
    if (mediaSeq) init.seq = Number(mediaSeq[1]);
    const key = t.match(/^#EXT-X-KEY:(.*)$/i);
    if (key) {
      const attrs = key[1];
      const method = (attrs.match(/METHOD=([^,\s]+)/)?.[1] ?? "NONE").toUpperCase();
      const uri = attrs.match(/URI="([^"]+)"/)?.[1];
      const iv = attrs.match(/IV=0x([0-9a-fA-F]+)/)?.[1];
      keyIv = iv ? hexToBytes(iv) : null;
      if (method === "NONE" || !uri) keyUri = null;
      else if (method === "AES-128") keyUri = absolutize(uri, baseUrl);
      else {
        /* SAMPLE-AES / FairPlay need a full DRM stack — grab the raw bytes
           (still a valid file for VLC/IDM) and let the caller decide. */
        keyUri = null;
        unsupportedEncryption = true;
      }
      seq = init.seq;
    }
    if (!t || t.startsWith("#")) continue;
    segments.push({
      url: absolutize(t, baseUrl),
      keyUri,
      iv: keyIv ?? seqIv(seq),
    });
    seq++;
  }
  const first = segments[0]?.url ?? "";
  const isTs =
    !initSegment &&
    (segments.length === 0 || /\.ts(\?|$)/i.test(first) || !/\.(m4s|mp4)(\?|$)/i.test(first));
  return {
    segments,
    initSegment,
    initKeyUri: keyUri,
    initIv: keyIv,
    isTs,
    unsupportedEncryption,
  };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(uri: string, referer?: string): Promise<CryptoKey> {
  let cached = keyCache.get(uri);
  if (!cached) {
    cached = (async () => {
      const bytes = await fetchBytes(uri, { referer });
      return crypto.subtle.importKey("raw", bytes.slice(0, 16), { name: "AES-CBC" }, false, [
        "decrypt",
      ]);
    })();
    keyCache.set(uri, cached);
    /* A failed key must not poison every later attempt of this film. */
    cached.catch(() => {
      if (keyCache.get(uri) === cached) keyCache.delete(uri);
    });
  }
  return cached;
}

async function decrypt(bytes: Bytes, seg: { keyUri: string | null; iv: Bytes | null }, referer?: string): Promise<Bytes> {
  if (!seg.keyUri || !seg.iv) return bytes;
  /* Never hand back the encrypted bytes. A stream that silently arrives as
     ciphertext saves a file that plays nothing, and the viewer has no way to
     tell that from a good download — so a dead key fails like one. */
  const key = await aesKey(seg.keyUri, referer);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: seg.iv }, key, bytes));
}

/** If the playlist is a master, follow its first (highest) variant. */
async function resolveToMedia(
  playlistUrl: string,
  referer?: string,
): Promise<{ text: string; url: string }> {
  let url = playlistUrl;
  for (let hop = 0; hop < 3; hop++) {
    const text = await fetchText(url, { referer });
    if (!text.includes("#EXT-X-STREAM-INF")) return { text, url };
    const lines = text.split(/\r?\n/);
    let best: { bw: number; uri: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#EXT-X-STREAM-INF:([^\r\n]+)/);
      if (!m) continue;
      const bw = Number(m[1].match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t || t.startsWith("#")) continue;
        if (!best || bw > best.bw) best = { bw, uri: absolutize(t, url) };
        break;
      }
    }
    if (!best) throw new Error("master playlist without variants");
    url = best.uri;
  }
  throw new Error("too many playlist hops");
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null; /* a dead segment must not sink the whole movie */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** One transmuxer for the whole film, fed window by window. The header it
 *  produces is emitted once, and every window hands back its own pieces so the
 *  raw transport stream can be released as soon as it is muxed. */
function createTsRemuxer() {
  const transmuxer = new Transmuxer();
  const pieces: Bytes[] = [];
  let initPushed = false;
  transmuxer.on("data", (seg: { initSegment?: Uint8Array; data: Uint8Array }) => {
    if (seg.initSegment && !initPushed) {
      pieces.push(seg.initSegment as Bytes);
      initPushed = true;
    }
    if (seg.data?.byteLength) pieces.push(seg.data as Bytes);
  });
  return {
    /** Muxes this window and hands back its pieces, so the caller can drop the
     *  raw transport stream bytes it just consumed. */
    remux(segments: Bytes[]): Bytes[] {
      for (const seg of segments) {
        transmuxer.push(seg);
        transmuxer.flush();
      }
      return pieces.splice(0, pieces.length);
    },
  };
}

export interface HlsDownloadResult {
  blob: Blob;
  /** Segments that could not be fetched even after retries. */
  skipped: number;
  total: number;
}

/**
 * Download an HLS playlist (master or media) and return a ready-to-save MP4.
 * `onProgress` reports 0..1 as segments arrive.
 */
export async function downloadHlsAsMp4(
  playlistUrl: string,
  onProgress?: (fraction: number) => void,
  opts: { referer?: string } = {},
): Promise<Blob> {
  const { blob } = await downloadHls(playlistUrl, onProgress, opts);
  return blob;
}

/** Segments pulled per window. A feature film is ~1 200 segments and over a
 *  gigabyte, so the raw bytes are muxed and dropped in batches instead of all
 *  at once — holding them and their muxed output together is what used to make
 *  the tab die halfway through a download. */
const WINDOW = 40;

export async function downloadHls(
  playlistUrl: string,
  onProgress?: (fraction: number) => void,
  opts: { referer?: string } = {},
): Promise<HlsDownloadResult> {
  const referer = opts.referer;
  const { text, url } = await resolveToMedia(playlistUrl, referer);
  const { segments, initSegment, initKeyUri, initIv, isTs } = parseMediaPlaylist(text, url);
  if (!segments.length) throw new Error("playlist has no segments");
  onProgress?.(0);

  const parts: BlobPart[] = [];
  if (initSegment) {
    parts.push(
      await decrypt(await fetchBytes(initSegment, { referer }), { keyUri: initKeyUri, iv: initIv }, referer),
    );
  }
  const ts = isTs ? createTsRemuxer() : null;
  let got = 0;
  for (let start = 0; start < segments.length; start += WINDOW) {
    const window = segments.slice(start, start + WINDOW);
    let done = 0;
    const bodies = await mapLimit(window, 4, async (seg) => {
      const bytes = await fetchBytes(seg.url, { referer });
      onProgress?.(Math.min(0.999, (start + ++done) / segments.length));
      return decrypt(bytes, seg, referer);
    });
    const ok = bodies.filter((b): b is Bytes => b !== null);
    got += ok.length;
    /* A window's raw bytes are released here; only the muxed pieces are kept. */
    parts.push(...(ts ? ts.remux(ok) : ok));
    onProgress?.(Math.min(0.999, (start + window.length) / segments.length));
  }
  if (!got)
    throw new Error(
      segments[0].keyUri
        ? "every segment failed — the AES key would not load"
        : "every segment failed",
    );
  /* MPEG-TS demuxers resync on 0x47, so dropped segments stay playable. */
  return {
    blob: new Blob(parts, { type: "video/mp4" }),
    skipped: segments.length - got,
    total: segments.length,
  };
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function isHlsLink(url: string): boolean {
  /* A piped stream's own URL ends in the pipe's path, so ask what it proxies. */
  return HLS_SHAPE.test(pipedTarget(url) || url);
}

/** Which of these links is a playlist. The extension lies in both directions —
 *  vixsrc and viduki name theirs `/playlist/…` with no `.m3u8` at all, while a
 *  VidNest media segment is called `….mp4` — so a row that is handed to the
 *  browser as a plain file saves 200 kB of `#EXTM3U` text wearing an .mp4 name. */
const HLS_SHAPE = /(\/playlist\/|[?&](?:type=video|format=m3u8|m3u8=1)\b|\.m3u8(?:\?|#|$))/i;

const sniffedUrls = new Map<string, Promise<boolean>>();

/** Ask the first bytes what the file name refused to say. */
export function hlsByContent(url: string, referer?: string): Promise<boolean> {
  if (isHlsLink(url)) return Promise.resolve(true);
  let known = sniffedUrls.get(url);
  if (!known) {
    known = readHeader(url, referer);
    sniffedUrls.set(url, known);
  }
  return known;
}

async function readHeader(url: string, referer?: string): Promise<boolean> {
  try {
    const res = await raw(url, referer);
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader();
    const first = await reader.read();
    /* The rest of a feature film is not needed to recognise a manifest. */
    void reader.cancel().catch(() => undefined);
    const head = new TextDecoder().decode(first.value ?? new Uint8Array());
    return head.slice(0, 16).includes("#EXTM3U");
  } catch {
    return false;
  }
}

