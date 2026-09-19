/**
 * Hosts of known URL shorteners. A stored/pasted link on one of these hosts
 * cannot stream video (the player can't send range requests through the
 * redirect chain), so it is resolved back to its real destination before
 * being saved. Shared by the browser (admin form) and the Convex backend.
 */
const SHORT_HOSTS = [
  "tinyurl.com",
  "is.gd",
  "bit.ly",
  "bit.do",
  "cutt.ly",
  "rb.gy",
  "t.co",
  "goo.gl",
  "shorturl.at",
  "rebrand.ly",
  "tiny.cc",
  "ow.ly",
  "buff.ly",
  "s.id",
  "urlz.fr",
  "v.gd",
];

export function isShortLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SHORT_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}
