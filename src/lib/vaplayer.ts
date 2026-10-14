/** Catalog embed source URLs — vidlink.pro ("Server 2").
 *
 *  Formerly vaplayer.ru, which moved its player behind a Cloudflare Turnstile
 *  challenge (nextgencloudfabric.com) that cannot pass inside a cross-origin
 *  iframe — every embed showed a blank player. vidlink.pro is one of the
 *  servers vidbox.wtf itself drives: plain iframe-embeddable, no frame
 *  blocking, and its player resolves to a direct signed file.
 *  The endpoint accepts TMDB numeric ids for both movies and TV. */

const EMBED_BASE = "https://vidlink.pro";

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
    ? `${EMBED_BASE}/tv/${target}/${season}/${episode}`
    : `${EMBED_BASE}/movie/${target}`;
}
