/**
 * Maps an admin-pasted movie URL to the app's HTTPS streaming proxy.
 *
 * Admins can register plain `http://` links (e.g. a LAN FTP server's HTTP
 * directory). Browsers block `http://` media on an HTTPS page (mixed
 * content) and some networks cannot reach the origin directly, so the
 * player always plays through the proxy when the source is not HTTPS.
 * Native `https://` sources pass through untouched (no proxy overhead).
 */
export function playableVideoUrl(
  raw: string | null | undefined,
  siteUrl: string,
  /** Optional movie row — lets us keep the movie's own subtitle tracks
   *  unproxied: .vtt files are fetched as plain text by the browser, not
   *  played by the video element. */
  movie?: { subtitles?: { url: string }[] } | null,
): string {
  const url = (raw ?? "").trim();
  if (!url) return "";
  const isOwnSubtitle = movie?.subtitles?.some((s) => s.url === url) ?? false;
  if (isOwnSubtitle) return url;
  // HLS playlists (token-signed or plain) must go straight to hls.js —
  // see isHlsUrl. Everything else keeps the mixed-content proxy rules.
  const needsProxy =
    (!url.startsWith("https://") || isForceProxyUrl(url)) && !isHlsUrl(url);
  if (!needsProxy) return url;
  return `${siteUrl.replace(/\/+$/, "")}/video-proxy?url=${encodeURIComponent(url)}`;
}

/**
 * Builds a link that starts a file download the moment it is clicked.
 *
 * Direct links never download: the movie CDNs serve `video/mp4` with no
 * `Content-Disposition`, and the browser ignores `download` on cross-origin
 * URLs — so the click opens a new tab and *plays* the movie instead. Routing
 * through the proxy with `&download=1` makes it answer `attachment`, which
 * browsers honour on any origin: one click, save dialog / download starts,
 * current page stays put (see videoProxy.ts).
 *
 * `filename` (movie title + quality) is optional — the proxy falls back to
 * the upstream file name.
 */
export function downloadFileUrl(
  raw: string | null | undefined,
  siteUrl: string,
  filename?: string,
): string {
  const url = (raw ?? "").trim();
  if (!url) return "";
  const base = siteUrl.replace(/\/+$/, "");
  // Without a configured HTTP endpoint there is nothing to attach the
  // download headers — hand back the raw link rather than a broken URL.
  if (!base) return url;
  const params = new URLSearchParams({ url });
  params.set("download", "1");
  if (filename?.trim()) params.set("filename", filename.trim());
  return `${base}/video-proxy?${params.toString()}`;
}

/**
 * True if the URL is an HLS playlist (.m3u8, optionally signed with a
 * `?token=` query — tokenized playlists still contain ".m3u8"). HLS is
 * played in-browser by hls.js and must NOT be routed through the proxy:
 * these streams chain signed, IP-bound token URLs (playlist → variants →
 * segments), which a proxy would break out of range and 403.
 */
export function isHlsUrl(raw: string | null | undefined): boolean {
  return (raw ?? "").trim().toLowerCase().includes(".m3u8");
}

/**
 * Hosts that never serve raw video bytes to hotlinking players — they
 * redirect to expiring download pages or browser checks. Even on https they
 * are routed through the proxy so it can respond with a clear "this link
 * serves a web page, not a video" error instead of a silent decode failure.
 */
const FORCE_PROXY_HOST_SUFFIXES = ["gofile.io", "katfile.com", "rapidgator.net", "mega.nz"];

export function isForceProxyUrl(raw: string | null | undefined): boolean {
  const url = (raw ?? "").trim();
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return FORCE_PROXY_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  } catch {
    return false;
  }
}

/** The Convex HTTP endpoint base for the current environment. */
export function convexSiteUrl(): string {
  return (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined) ?? "";
}
