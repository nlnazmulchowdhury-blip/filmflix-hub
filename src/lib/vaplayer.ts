/** Catalog embed source URLs — the provider player pages behind the embed
 *  servers, each of which also gets an ad-free resolve attempt first.
 *
 *   • vidbox  → vidlink.pro: its own sources API answers with HEVC-only files
 *              (probed through its real token handshake), so this player
 *              paints a black rectangle for every browser without hardware
 *              HEVC. Kept last in the lineup for the viewers that do decode it.
 *   • vixsrc  → vixsrc.to. Took over the slot vidapi.ru left behind when that
 *              provider moved its player behind a Cloudflare Turnstile
 *              challenge (nextgencloudfabric.com), which cannot pass inside a
 *              cross-origin iframe and showed a blank player for everyone.
 *              vixsrc mints its playlist token server-side, embeds with no
 *              frame blocking, and plays HLS through its own JWPlayer.
 *   • nxsha   → web.nxsha.app: a multi-source player that picks between
 *              several upstream hosts by itself. Iframe-only.
 *
 *  All three accept TMDB numeric ids for movies and TV. */

import { vidsrcEmbedUrl } from "./vidsrc";

const VIDBOX_BASE = "https://vidlink.pro";
const VIXSRC_BASE = "https://vixsrc.to";
const NXSHA_BASE = "https://web.nxsha.app";

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

/** vidbox server — resolvable vidlink.pro chain.
 *
 *  vidlink.pro only understands TMDB numeric ids: an IMDb `tt…` id — or a
 *  number it does not carry — makes its Next.js app answer 500, and that
 *  "Application error" wall then renders full-size inside our iframe. Never
 *  build a vidbox URL for those targets; the other servers take over. */
export function vidboxEmbedUrl(target: EmbedTarget): string {
  const t = target.id ?? target.tmdbId ?? target.imdbId;
  if (!t || !/^\d+$/.test(String(t))) return "";
  return providerUrl(VIDBOX_BASE, target);
}

/** vixsrc server — the provider that replaced the Turnstile-gated one.
 *
 *  The server key stays `vidapi` in the player and in the database (admins
 *  switched servers off by that key), only the provider behind it changed. */
export function vixsrcEmbedUrl(target: EmbedTarget): string {
  const t = target.id ?? target.tmdbId ?? target.imdbId;
  if (!t || !/^\d+$/.test(String(t))) return "";
  return providerUrl(VIXSRC_BASE, target);
}

/** Back-compat alias: catalog cards still carry a vidlink.pro (vidbox) URL. */
export const vaplayerEmbedUrl = vidboxEmbedUrl;

/** The provider page for one episode, built from whichever id this title has.
 *
 *  vidlink.pro and vixsrc refuse an IMDb `tt…` page outright, so they only come
 *  first when the numeric TMDB id is actually known; nxsha's tv route takes
 *  either (the Worker reads the number back off its page), and VidSrc is the
 *  last page that still plays the episode — ad-supported, but the alternative
 *  is the episode pick doing nothing at all. */
export function episodeEmbedUrl(target: EmbedTarget): string {
  return (
    vidboxEmbedUrl(target) ||
    nxshaEmbedUrl(target) ||
    vidsrcEmbedUrl({
      imdbId: target.imdbId ?? null,
      tmdbId: target.tmdbId == null ? null : String(target.tmdbId),
      kind: target.kind,
      season: target.season,
      episode: target.episode,
    }) ||
    ""
  );
}

/** nxsha server — web.nxsha.app, a multi-source player (it picks between
 *  several upstream hosts itself and embeds without frame blocking).
 *
 *  Its movie route only understands TMDB numeric ids (an IMDb `tt…` id 404s),
 *  while its tv route takes either, so movies follow the same numeric-only
 *  rule as vidbox. */
export function nxshaEmbedUrl(target: EmbedTarget): string {
  const t = target.id ?? target.tmdbId ?? target.imdbId;
  if (!t) return "";
  if (target.kind !== "series" && !/^\d+$/.test(String(t))) return "";
  return target.kind === "series"
    ? `${NXSHA_BASE}/embed/tv/${t}/${target.season ?? 1}/${target.episode ?? 1}`
    : `${NXSHA_BASE}/embed/movie/${t}`;
}

/* ---------------- stateless provider deep links ---------------- */

/** What the card that opened this player knew about its title.
 *
 *  Router state disappears on refresh, and `/movie/vaplayer-<id>` is then left
 *  guessing: it falls back to the movie path — where providers have no such
 *  episode and answer with their "not available" wall — shows "External" as the
 *  title, and hides the episode guide. Keeping the card's own payload for the
 *  tab means reloading a series plays the same show it opened. */
export interface ExternalHint {
  kind?: "movie" | "series";
  title?: string;
  posterUrl?: string;
  backdropUrl?: string;
  overview?: string;
}

const hintKey = (id: string) => `filmflix:external:${id}`;

/* This module is also compiled by the Worker tsconfig, which has no DOM lib,
   so the tab store is reached through globalThis rather than the global name. */
const hintStore = () =>
  (
    globalThis as {
      sessionStorage?: {
        setItem(key: string, value: string): void;
        getItem(key: string): string | null;
      };
    }
  ).sessionStorage;

export function rememberExternalHint(
  id: string | number | null | undefined,
  hint: ExternalHint,
) {
  if (id === null || id === undefined) return;
  try {
    hintStore()?.setItem(
      hintKey(String(id)),
      JSON.stringify({ ...hint, overview: hint.overview?.slice(0, 800) }),
    );
  } catch {
    /* private mode or a full store — the click itself still carries its state */
  }
}

export function recallExternalHint(
  id: string | null | undefined,
): ExternalHint | null {
  if (!id) return null;
  try {
    const raw = hintStore()?.getItem(hintKey(id));
    return raw ? (JSON.parse(raw) as ExternalHint) : null;
  } catch {
    return null;
  }
}
