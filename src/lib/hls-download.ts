/**
 * In-browser HLS → MP4 downloader.
 *
 * Provider CDNs rarely allow cross-origin reads, so every byte goes through
 * the Worker's /embed/proxy pipe. MPEG-TS playlists are remuxed with mux.js;
 * fMP4 playlists are stitched (init segment + media segments) straight into
 * an .mp4 container.
 */
import { Transmuxer } from "mux.js/lib/mp4/transmuxer";
import { API_BASE } from "@/lib/api";

export function proxyUrl(url: string): string {
  return `${API_BASE}/embed/proxy?url=${encodeURIComponent(url)}`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(proxyUrl(url));
  if (!res.ok) throw new Error(`segment fetch failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(proxyUrl(url));
  if (!res.ok) throw new Error(`playlist fetch failed (${res.status})`);
  return res.text();
}

interface MediaPlaylist {
  segments: string[];
  initSegment?: string;
  isTs: boolean;
}

function absolutize(uri: string, base: string): string {
  return new URL(uri, base).href;
}

function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: string[] = [];
  let initSegment: string | undefined;
  for (const line of lines) {
    const map = line.match(/^#EXT-X-MAP:URI="([^"]+)"/);
    if (map) initSegment = absolutize(map[1], baseUrl);
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    segments.push(absolutize(t, baseUrl));
  }
  const isTs =
    !initSegment &&
    (segments.length === 0 || /\.ts(\?|$)/i.test(segments[0]) || !/\.(m4s|mp4)(\?|$)/i.test(segments[0]));
  return { segments, initSegment, isTs };
}

/** If the playlist is a master, follow its first (highest) variant. */
async function resolveToMedia(playlistUrl: string): Promise<{ text: string; url: string }> {
  let url = playlistUrl;
  for (let hop = 0; hop < 3; hop++) {
    const text = await fetchText(url);
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
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function remuxTs(segments: Uint8Array[]): Uint8Array {
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

/**
 * Download an HLS playlist (master or media) and return a ready-to-save MP4.
 * `onProgress` reports 0..1 as segments arrive.
 */
export async function downloadHlsAsMp4(
  playlistUrl: string,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const { text, url } = await resolveToMedia(playlistUrl);
  const { segments, initSegment, isTs } = parseMediaPlaylist(text, url);
  if (!segments.length) throw new Error("playlist has no segments");
  onProgress?.(0);

  const init = initSegment ? await fetchBytes(initSegment) : null;
  let done = 0;
  const bodies = await mapLimit(segments, 4, async (seg) => {
    const bytes = await fetchBytes(seg);
    done++;
    onProgress?.(done / segments.length);
    return bytes;
  });

  if (!isTs) {
    return new Blob([init ?? new Uint8Array(), ...bodies], { type: "video/mp4" });
  }
  const mp4 = remuxTs(bodies);
  return new Blob([mp4], { type: "video/mp4" });
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
  return /\.m3u8(\?|#|$)/i.test(url);
}
