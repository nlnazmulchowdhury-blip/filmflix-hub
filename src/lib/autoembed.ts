/**
 * AutoEmbed episode players — "Server 3" (anime) and "Server 4" (drama).
 *
 * URL formats (as specified):
 *   https://anime.autoembed.cc/embed/{title}-episode-{number}
 *   https://drama.autoembed.cc/embed/{title}-episode-{no}?server={no}
 *
 * The title is slugified into `{title}`. Note: `*.autoembed.cc` currently
 * returns NXDOMAIN (checked 2026-10-14 via Google + Cloudflare DoH); if the
 * service moved to a new domain, change the two host constants below and the
 * servers work again with no other edits.
 */

export const AUTOEMBED_ANIME_HOST = "anime.autoembed.cc";
export const AUTOEMBED_DRAMA_HOST = "drama.autoembed.cc";

/** "Frieren: Beyond Journey's End" → "frieren-beyond-journey-s-end" */
export function autoembedSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function animeEmbedUrl(title: string, episode: number): string {
  return `https://${AUTOEMBED_ANIME_HOST}/embed/${autoembedSlug(title)}-episode-${episode}`;
}

export function dramaEmbedUrl(
  title: string,
  episode: number,
  server = 1,
): string {
  return `https://${AUTOEMBED_DRAMA_HOST}/embed/${autoembedSlug(title)}-episode-${episode}?server=${server}`;
}
