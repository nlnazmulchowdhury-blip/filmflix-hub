/** vaplayer.ru ("PlayBox") embed URLs.
 *
 *  The endpoint accepts BOTH IMDb (tt…) and TMDB numeric ids, so a TMDB
 *  browse result can be played without an id mapping round-trip. Shared by
 *  the Worker (TMDB browse cards) and the frontend (synthetic play route). */

const VAPLAYER_BASE = "https://vaplayer.ru";

export function vaplayerEmbedUrl({
  id,
  tmdbId,
  imdbId,
  kind,
  season = 1,
  episode = 1,
}: {
  id?: string | null;
  tmdbId?: string | number | null;
  imdbId?: string | null;
  kind?: "movie" | "series" | null;
  season?: number;
  episode?: number;
}): string {
  const target = id ?? tmdbId ?? imdbId;
  if (!target) return "";
  const isSeries = kind === "series";
  return isSeries
    ? `${VAPLAYER_BASE}/embed/tv/${target}/${season}/${episode}`
    : `${VAPLAYER_BASE}/embed/movie/${target}`;
}
