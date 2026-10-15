/** Catalog embed source URLs — the two ad-free "Server 2" provider chains.
 *
 *  Formerly vaplayer.ru, which moved its player behind a Cloudflare Turnstile
 *  challenge (nextgencloudfabric.com) that cannot pass inside a cross-origin
 *  iframe — every embed showed a blank player.
 *
 *  Two distinct providers are now offered as separate playback servers:
 *
 *   • vidbox  → vidlink.pro. One of the servers vidbox.wtf itself drives:
 *              plain iframe-embeddable, no frame blocking, and its player
 *              resolves to a direct signed file, so the Worker can pull raw
 *              HLS server-side (ad-free).
 *   • vidapi  → vidapi.ru. Redirects into vaplayer.ru → nextgencloudfabric.com,
 *              a Cloudflare-Turnstile chain the server-side resolver cannot
 *              follow; it falls back to the provider iframe.
 *
 *  Both endpoints accept TMDB numeric ids for movies and TV. */

const VIDBOX_BASE = "https://vidlink.pro";
const VIDAPI_BASE = "https://vidapi.ru";

export interface EmbedTarget {
  id?: string | null;
  tmdbId?: string | number | null;
  imdbId?: string | null;
  kind?: "movie" | "series" | null;
  season?: number;
  episode?: number;
}

function providerUrl(base: string, { id, tmdbId, imdbId, kind, season = 1, episode = 1 }: EmbedTarget): string {
  const target = id ?? tmdbId ?? imdbId;
  if (!target) return "";
  return kind === "series"
    ? `${base}/tv/${target}/${season}/${episode}`
    : `${base}/movie/${target}`;
}

/** vidbox server — resolvable vidlink.pro chain. */
export function vidboxEmbedUrl(target: EmbedTarget): string {
  return providerUrl(VIDBOX_BASE, target);
}

/** vidapi server — vaplayer/nextgencloudfabric chain (iframe fallback). */
export function vidapiEmbedUrl(target: EmbedTarget): string {
  const t = target.id ?? target.tmdbId ?? target.imdbId;
  if (!t) return "";
  return target.kind === "series"
    ? `${VIDAPI_BASE}/embed/tv/${t}/${target.season ?? 1}/${target.episode ?? 1}`
    : `${VIDAPI_BASE}/embed/movie/${t}`;
}

/** Back-compat alias: catalog cards still carry a vidlink.pro (vidbox) URL. */
export const vaplayerEmbedUrl = vidboxEmbedUrl;
