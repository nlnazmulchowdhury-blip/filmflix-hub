/** Catalog embed source URLs — the provider player pages behind the embed
 *  servers. Most of them are read server-side, so their film runs in our own
 *  player; the rest can only ever run on the provider's own screen.
 *
 *   • nxsha   → web.nxsha.app: a multi-source player that picks between
 *              several upstream hosts by itself. Its stream is extracted
 *              server-side and pulled through our proxy, so it plays under
 *              our controls.
 *   • vixsrc  → vixsrc.to. Took over the slot vidapi.ru left behind when that
 *              provider moved its player behind a Cloudflare Turnstile
 *              challenge (nextgencloudfabric.com), which cannot pass inside a
 *              cross-origin iframe and showed a blank player for everyone.
 *              vixsrc mints its playlist token server-side, embeds with no
 *              frame blocking, and plays HLS through its own JWPlayer.
 *   • vidbox  → vidlink.pro: the token for its sources API looked like it could
 *              only be minted in the viewer's browser (a libsodium/WASM
 *              handshake), but that handshake is a constant key, a fixed nonce
 *              and the TMDB id, so the Worker mints it itself now — see
 *              worker/src/vidlink.ts. Its catch is the file, not the token:
 *              vidlink keeps most titles HEVC-only, which paints a black
 *              rectangle for every browser without hardware HEVC, so those
 *              titles still run on its own player. Where it has H.264 HLS, the
 *              film plays under our controls like the servers above.
 *   • viduki  → play.xpass.top, the player viduki.net's fourth API frames. Its
 *              `/data` answer is an AES-GCM envelope, but the key is built from
 *              the request path and the token printed in that page's own HTML,
 *              so the Worker opens it without running their code — see
 *              worker/src/xpass.ts — and its ladders are plain H.264 HLS.
 *
 *  All of them accept TMDB numeric ids for movies and TV. */

const VIDBOX_BASE = "https://vidlink.pro";
const VIXSRC_BASE = "https://vixsrc.to";
const NXSHA_BASE = "https://web.nxsha.app";
const XPASS_BASE = "https://play.xpass.top";

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

/** vidbox server — vidlink.pro, ours when it holds an H.264 stream and the
 *  provider's own player for everything else.
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
 *  nxsha leads: its tv route takes a TMDB *or* an IMDb id (the Worker reads the
 *  number back off its page), and it is the chain this site resolves most
 *  reliably, so the episode runs under our own controls. vidlink.pro refuses an
 *  IMDb `tt…` page outright, so it only appears when a numeric TMDB id is
 *  actually known — where it is a chain the Worker can ask directly. */
export function episodeEmbedUrl(target: EmbedTarget): string {
  return nxshaEmbedUrl(target) || vidboxEmbedUrl(target) || "";
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

/** viduki server — the player page behind that site's fourth API.
 *
 *  viduki.net's own /1 and /2 pages mint their stream inside a WASM module
 *  after an ALTCHA proof-of-work, which no resolver can follow, while /3 and /4
 *  only frame another provider. /4 frames `play.xpass.top`, and *that* page is
 *  readable server-side: its `/data/…` answer opens with a key built from the
 *  path and the token printed in the HTML (see worker/src/xpass.ts), and the
 *  ladder list it holds names plain HLS masters. So this URL is asked directly:
 *  when the Worker opens it, the film runs under our own controls, and when it
 *  cannot, the same page is what the framed fallback shows.
 *
 *  Its routes only understand TMDB numeric ids, so an IMDb-only title simply
 *  does not get this chip. */
export function vidukiEmbedUrl(target: EmbedTarget): string {
  const t = target.id ?? target.tmdbId ?? target.imdbId;
  if (!t || !/^\d+$/.test(String(t))) return "";
  return target.kind === "series"
    ? `${XPASS_BASE}/e/tv/${t}/${target.season ?? 1}/${target.episode ?? 1}`
    : `${XPASS_BASE}/e/movie/${t}`;
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
