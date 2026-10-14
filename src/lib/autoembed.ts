/**
 * "Server 3" (Anime) and "Server 4" (Drama) episode players.
 *
 * These were originally the AutoEmbed title-slug endpoints
 * (`anime.autoembed.cc/embed/{title}-episode-{n}` /
 * `drama.autoembed.cc/embed/{title}-episode-{n}?server={n}`), but the whole
 * `*.autoembed.cc` zone is now NXDOMAIN (checked via Google + Cloudflare DoH),
 * so those embeds were always blank. Rewired to live TMDB-id providers that
 * vidbox.wtf itself rotates through — both accept a TMDB id for a movie or a
 * `tv/{id}/{season}/{episode}` path for a series, and neither sits behind a
 * Cloudflare challenge, so they render inside our cross-origin iframe.
 *
 *   Server 3 → VidNest   (markets anime + movie + TV)
 *   Server 4 → Videasy   (movie + TV, 4K rotation)
 */

export interface AutoEmbedTarget {
  tmdbId: string | number | null | undefined;
  kind?: "movie" | "series" | null;
  season?: number;
  episode?: number;
}

/** Server 3 — VidNest. */
export function animeEmbedUrl({
  tmdbId,
  kind,
  season = 1,
  episode = 1,
}: AutoEmbedTarget): string {
  if (!tmdbId) return "";
  return kind === "series"
    ? `https://vidnest.fun/tv/${tmdbId}/${season}/${episode}`
    : `https://vidnest.fun/movie/${tmdbId}`;
}

/** Server 4 — Videasy. */
export function dramaEmbedUrl({
  tmdbId,
  kind,
  season = 1,
  episode = 1,
}: AutoEmbedTarget): string {
  if (!tmdbId) return "";
  return kind === "series"
    ? `https://player.videasy.to/tv/${tmdbId}/${season}/${episode}`
    : `https://player.videasy.to/movie/${tmdbId}`;
}
