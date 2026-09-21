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
): string {
  const url = (raw ?? "").trim();
  if (!url) return "";
  if (url.startsWith("https://")) return url;
  return `${siteUrl.replace(/\/+$/, "")}/video-proxy?url=${encodeURIComponent(url)}`;
}

/** The Convex HTTP endpoint base for the current environment. */
export function convexSiteUrl(): string {
  return (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined) ?? "";
}
