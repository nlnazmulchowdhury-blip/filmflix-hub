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
 *  - AES-128 encrypted playlists are decrypted with WebCrypto, because most
 *    provider CDNs serve `#EXT-X-KEY` streams.
 */
import { Transmuxer } from "mux.js/lib/mp4/transmuxer";
import { API_BASE } from "@/lib/api";

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
  return `${API_BASE}/embed/proxy?${q.toString()}`;
}

interface FetchOpts {
  referer?: string;
  attempts?: number;
}

async function raw(url: string, referer?: string): Promise<Response> {
  return fetch(proxyUrl(url, referer));
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
  }
  return cached;
}

async function decrypt(bytes: Bytes, seg: { keyUri: string | null; iv: Bytes | null }, referer?: string): Promise<Bytes> {
  if (!seg.keyUri || !seg.iv) return bytes;
  try {
    const key = await aesKey(seg.keyUri, referer);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: seg.iv }, key, bytes));
  } catch {
    return bytes;
  }
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

function remuxTs(segments: Bytes[]): Bytes {
  const transmuxer = new Transmuxer();
  const parts: Uint8Array[] = [];
  let initPushed = false;
  transmuxer.on("data", (seg: { initSegment?: Uint8Array; data: Uint8Array }) => {
    if (seg.initSegment && !initPushed) {
      parts.push(seg.initSegment);
      initPushed = true;
    }
    parts.push(seg.data);
  });
  for (const seg of segments) {
    transmuxer.push(seg);
    transmuxer.flush();
  }
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
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

  const init = initSegment
    ? await decrypt(await fetchBytes(initSegment, { referer }), { keyUri: initKeyUri, iv: initIv }, referer)
    : null;
  let done = 0;
  const bodies = await mapLimit(segments, 4, async (seg) => {
    const bytes = await fetchBytes(seg.url, { referer });
    done++;
    onProgress?.(done / segments.length);
    return decrypt(bytes, seg, referer);
  });
  const ok = bodies.filter((b): b is Bytes => b !== null);
  if (!ok.length) throw new Error("every segment failed");
  /* MPEG-TS demuxers resync on 0x47, so dropped segments stay playable. */
  return {
    blob: isTs
      ? new Blob([remuxTs(ok)], { type: "video/mp4" })
      : new Blob([init ?? new Uint8Array(), ...ok], { type: "video/mp4" }),
    skipped: segments.length - ok.length,
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
  return /\.m3u8(\?|#|$)/i.test(pipedTarget(url) || url);
}
