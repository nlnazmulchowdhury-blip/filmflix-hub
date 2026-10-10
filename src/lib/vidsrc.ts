/**
 * VidSrc (https://vidsrc.to/) embed URL builder.
 *
 * VidSrc serves an HTML5 player over an iframe. The embed path is:
 *   movie: https://vidsrc.to/embed/movie/{id}
 *   tv:    https://vidsrc.to/embed/tv/{id}/{season}/{episode}
 *
 * `{id}` accepts an IMDb id (`tt0133093`) or a TMDB id (`603`). We prefer the
 * IMDb id when both are present because it is stable across regions.
 *
 * VidSrc's own listing/search API is retired (its documented `vapi` endpoints
 * now 404), so we never resolve titles against VidSrc — the caller supplies an
 * id that is stored on the movie document. When no id is available we return
 * null and the player hides the Server 1 option.
 */

const VIDSRC_BASE = "https://vidsrc.to/embed";

export interface VidSrcTarget {
  /** IMDb id, e.g. "tt1375666". */
  imdbId?: string | null;
  /** TMDB id, e.g. "27205". */
  tmdbId?: string | null;
  /** "movie" (default) or "series". */
  kind?: "movie" | "series" | null;
  /** Season number for series (default 1). */
  season?: number;
  /** Episode number for series (default 1). */
  episode?: number;
}

/** Prefer IMDb, fall back to TMDB. Returns null when neither exists. */
export function pickVidSrcId(t: VidSrcTarget): string | null {
  const imdb = (t.imdbId ?? "").trim();
  if (imdb) return imdb;
  const tmdb = (t.tmdbId ?? "").trim();
  if (tmdb) return tmdb;
  return null;
}

/**
 * Build the iframe src for VidSrc, or null when the movie has no usable id.
 * Series always include a season/episode pair (VidSrc requires it).
 */
export function vidsrcEmbedUrl(t: VidSrcTarget): string | null {
  const id = pickVidSrcId(t);
  if (!id) return null;

  if (t.kind === "series") {
    const season = Math.max(1, Math.floor(t.season ?? 1));
    const episode = Math.max(1, Math.floor(t.episode ?? 1));
    return `${VIDSRC_BASE}/tv/${encodeURIComponent(id)}/${season}/${episode}`;
  }
  return `${VIDSRC_BASE}/movie/${encodeURIComponent(id)}`;
}
