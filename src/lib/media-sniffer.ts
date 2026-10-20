/**
 * IDM-style media sniffer.
 *
 * IDM's browser grabber is reliable for one reason: it never guesses where a
 * stream lives, it watches the requests the player *already* made and grabs
 * those exact URLs. Same idea, page-side — hls.js and the `<video>` element
 * pull playlists and segments through `fetch`/`XMLHttpRequest`, so wrapping
 * those two entry points captures every stream URL that is proven to work at
 * this moment, plus the resolution the player settled on.
 *
 * The Download menu reads this list instead of only probing provider
 * endpoints, which is what makes downloads survive token-expiring, rotating
 * and hotlink-protected CDNs.
 */
import { useSyncExternalStore } from "react";

export interface SniffedStream {
  url: string;
  kind: "hls" | "file";
  /** 1080p / 720p / 2 Mbps / Stream */
  label: string;
  height: number;
  bitrate: number;
  referer: string;
  host: string;
  at: number;
}

const MAX_ENTRIES = 40;
const HLS_RE = /\.m3u8(\?|#|$)/i;
const FILE_RE = /\.(mp4|mkv|webm|mov|m4v|avi)(\?|#|$)/i;
/** Media segments — never offered on their own, they are pieces of a playlist. */
const SEGMENT_RE = /\.(ts|m4s|m2ts|mp2t|sc2ts|init)(\?|#|$)/i;
/** fMP4 init sections wear an .mp4 name and are worthless as a "movie". */
const INIT_RE = /\/init[-_.]/i;
const NOISE_RE = /\.(vtt|srt|ttml|js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|map)(\?|#|$)/i;

/* A CDN's referer gate is per host, and a download menu lists sources the
 * viewer may not be playing right now — so the Referer that made playback work
 * is remembered by host and replayed for that host's files, on this viewing
 * and the next. Without it a VidNest row asks zenoak.top with vidnest.fun and
 * the CDN answers 403 while the same film streams fine two centimetres away. */
const REF_STORE = "ff-cdn-referers";
const referrers = new Map<string, string>(readStore());

function readStore(): [string, string][] {
  try {
    const raw = localStorage.getItem(REF_STORE);
    return raw ? (JSON.parse(raw) as [string, string][]) : [];
  } catch {
    return [];
  }
}

function rememberReferer(host: string, referer: string): void {
  if (!host || !referer || referrers.get(host) === referer) return;
  referrers.set(host, referer);
  try {
    localStorage.setItem(REF_STORE, JSON.stringify([...referrers].slice(-80)));
  } catch {
    /* private mode: the in-memory map still serves this viewing */
  }
}

/** The Referer this URL's host last accepted, or "" if we have never played it. */
export function refererFor(url: string): string {
  try {
    return referrers.get(new URL(url, location.href).hostname) ?? "";
  } catch {
    return "";
  }
}

let streams: SniffedStream[] = [];
let snapshot: SniffedStream[] = [];
const listeners = new Set<() => void>();
let defaultReferer = "";

function emit() {
  snapshot = [...streams].sort(
    (a, b) => b.height - a.height || b.bitrate - a.bitrate || a.at - b.at,
  );
  for (const l of listeners) l();
}

function labelFor(height: number, bitrate: number, url: string): string {
  const fromUrl =
    /(\d{3,4})p/i.exec(url)?.[1] ??
    /(?:height|h|res)[=/](\d{3,4})\b/i.exec(url)?.[1];
  const h = height || Number(fromUrl ?? 0);
  if (h >= 2160) return "4K";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h >= 360) return "360p";
  if (h) return `${h}p`;
  if (bitrate >= 4_000_000) return "4 Mbps";
  if (bitrate >= 2_000_000) return "2 Mbps";
  if (bitrate >= 900_000) return "0.9 Mbps";
  if (bitrate) return `${Math.round(bitrate / 1000)} kbps`;
  return "Stream";
}

/** Resolve to a real stream URL, unwrapping our own proxy and dropping noise. */
function normalize(raw: string): string | null {
  if (!raw || raw.startsWith("blob:") || raw.startsWith("data:")) return null;
  let u: URL;
  try {
    u = new URL(raw, location.href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  /* The byte pipe wraps the upstream URL — record what it proxies, and keep
     the Referer that pipe was called with. */
  const inner = u.searchParams.get("url");
  if (inner && u.pathname.endsWith("/embed/proxy")) {
    const ref = u.searchParams.get("ref");
    if (ref) {
      defaultReferer = ref;
      try {
        rememberReferer(new URL(inner).hostname, ref);
      } catch {
        /* not a real URL — nothing to remember */
      }
    }
    return normalize(inner);
  }
  /* Resolver/JSON endpoints are not media; the API host serves both. */
  if (u.pathname.includes("/embed/") && !HLS_RE.test(u.pathname) && !FILE_RE.test(u.pathname))
    return null;
  if (NOISE_RE.test(u.pathname) || SEGMENT_RE.test(u.pathname) || INIT_RE.test(u.pathname))
    return null;
  if (!HLS_RE.test(u.pathname) && !FILE_RE.test(u.pathname)) return null;
  return u.href;
}

export function noteMediaUrl(
  raw: string,
  info?: { height?: number; bitrate?: number; referer?: string },
): void {
  const url = normalize(raw);
  if (!url) return;
  const referer = info?.referer || defaultReferer || document.referrer || "";
  const existing = streams.find((s) => s.url === url);
  if (existing) {
    const height = Math.max(existing.height, info?.height ?? 0);
    const bitrate = Math.max(existing.bitrate, info?.bitrate ?? 0);
    if (height === existing.height && bitrate === existing.bitrate) return;
    existing.height = height;
    existing.bitrate = bitrate;
    existing.label = labelFor(height, bitrate, url);
    emit();
    return;
  }
  const height = info?.height ?? 0;
  const bitrate = info?.bitrate ?? 0;
  streams.push({
    url,
    kind: HLS_RE.test(new URL(url).pathname) ? "hls" : "file",
    label: labelFor(height, bitrate, url),
    height,
    bitrate,
    referer,
    host: new URL(url).hostname,
    at: Date.now(),
  });
  if (streams.length > MAX_ENTRIES) streams.splice(0, streams.length - MAX_ENTRIES);
  emit();
}

/**
 * Feed the level list hls.js parsed for the source currently playing.
 * This is the full IDM-style menu: every resolution the CDN offers, whether
 * or not the player has visited it yet.
 */
export function reportHlsLevels(
  src: string,
  levels: {
    /** hls.js keeps redundant fallback URLs per level, so this can be a list. */
    url?: string | string[];
    height?: number;
    width?: number;
    bitrate?: number;
  }[],
): void {
  noteMediaUrl(src);
  for (const l of levels) {
    const url = Array.isArray(l.url) ? l.url[0] : l.url;
    if (!url) continue;
    const height = l.height || (l.width ? Math.round((l.width * 9) / 16) : 0);
    noteMediaUrl(url, { height, bitrate: l.bitrate, referer: src });
  }
}

/** Remember which embed page the streams were played from (hotlink checks). */
export function setSnifferReferer(url: string): void {
  if (url) try { defaultReferer = new URL(url).href; } catch { /* ignore */ }
}

let installed = false;

export function startMediaSniffer(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      noteMediaUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    } catch { /* never break playback for a sniffer bug */ }
    return origFetch(input, init);
  }) as typeof window.fetch;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __ffUrl?: string },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__ffUrl = typeof url === "string" ? url : url.href;
    return (origOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const self = this as XMLHttpRequest & { __ffUrl?: string };
      if (self.__ffUrl) noteMediaUrl(self.__ffUrl);
    } catch { /* ignore */ }
    return (origSend as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.send;

  /* Progressive <video> sources (MP4 egress, trailers, Safari's native HLS):
     the element reports the real frame height, which is the true resolution. */
  const poll = () => {
    for (const el of Array.from(document.querySelectorAll("video"))) {
      const src = el.currentSrc || el.src || "";
      if (!src || src.startsWith("blob:")) continue;
      noteMediaUrl(src, { height: el.videoHeight || 0 });
    }
  };
  poll();
  window.setInterval(poll, 2000);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function sniffedStreams(): SniffedStream[] {
  return snapshot;
}

export function useSniffedStreams(): SniffedStream[] {
  return useSyncExternalStore(subscribe, sniffedStreams, sniffedStreams);
}
