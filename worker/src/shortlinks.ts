/** Same short-host list as the Convex version. */
const SHORT_HOSTS = [
  "tinyurl.com", "is.gd", "bit.ly", "bit.do", "cutt.ly", "rb.gy", "t.co",
  "goo.gl", "shorturl.at", "rebrand.ly", "tiny.cc", "ow.ly", "buff.ly",
  "s.id", "urlz.fr", "v.gd",
];

export function isShortLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SHORT_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

/** Follow redirects to the real destination (HEAD, ranged-GET fallback). */
export async function resolveRedirect(url: string): Promise<string> {
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!res.ok || !res.redirected) {
      res = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1" },
        redirect: "follow",
      });
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    return res.url || url;
  } catch {
    return url;
  }
}
