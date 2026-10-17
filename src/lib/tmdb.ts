/**
 * TMDB browse client for the landing "All Movies" grid.
 *
 * The Worker (`GET /tmdb/browse?page=N`) is the only piece that talks to TMDB
 * (it keeps the API key server-side) and slices results into 10-item batches.
 * Each card carries a vaplayer embed URL, so clicking one opens the site's own
 * player through the embed server built in PlayerStage — no TMDB key leaks to
 * the browser, and no separate id-mapping hop is needed (vaplayer takes TMDB
 * numeric ids directly).
 */
import { api } from "@/lib/api";

export interface TmdbItem {
  tmdbId: string;
  kind: "movie" | "series";
  title: string;
  year?: number;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string;
  rating?: number;
  /** vaplayer embed page URL — fed straight into the player's embed server. */
  embedUrl: string;
}

export interface TmdbPage {
  items: TmdbItem[];
  page: number;
  hasMore: boolean;
  error?: string;
}

/** A streaming service channel (Netflix, Prime Video, …) for the Providers row. */
export interface ProviderInfo {
  id: string;
  name: string;
  logoUrl: string;
}

/** A movie category (genre) offered by the embed catalog, for the chip row. */
export interface CategoryInfo {
  id: number;
  name: string;
}

/** Fetch one 60-item batch (page is a 1-based batch number, not a TMDB page).
    `provider` filters the batch to one streaming channel's catalog and
    `genre` to one category (TMDB genre id). */
export async function browseTmdb(
  page = 1,
  section = "all",
  provider?: string | null,
  genre?: number | null,
): Promise<TmdbPage> {
  const q = provider ? `&provider=${encodeURIComponent(provider)}` : "";
  const g = genre ? `&genre=${encodeURIComponent(genre)}` : "";
  return api.get<TmdbPage>(
    `/tmdb/browse?page=${page}&section=${encodeURIComponent(section)}${q}${g}`,
  );
}

/** The streaming channels shown in the landing "Providers" band. */
export async function listProviders(): Promise<ProviderInfo[]> {
  const r = await api.get<{ providers: ProviderInfo[] }>(`/tmdb/providers`);
  return r.providers ?? [];
}

/** The category chips on the landing page — auto-populated from the embed
    catalog's own genre list so every chip has movies behind it. */
export async function listCategories(): Promise<CategoryInfo[]> {
  const r = await api.get<{ categories: CategoryInfo[] }>(`/tmdb/categories`);
  return r.categories ?? [];
}

/** "More videos" for the player page — titles related to one TMDB movie,
    scraped keyless from the embed source's own watch page. */
export async function listRelated(tmdbId: string): Promise<TmdbItem[]> {
  const r = await api.get<{ items: TmdbItem[] }>(
    `/tmdb/related?tmdbId=${encodeURIComponent(tmdbId)}`,
  );
  return r.items ?? [];
}

/* ------------------- series seasons + episodes ------------------------- */

export interface TvSeasonOption {
  season: number;
  name: string;
  episodeCount: number;
  posterUrl?: string | null;
}

export interface TvEpisode {
  episode: number;
  name: string;
  overview: string;
  stillUrl?: string | null;
  runtimeSec?: number | null;
  airDate?: string | null;
}

export interface TvSeasonPayload {
  tmdbId: string;
  /** The show's other id, when the guide could name it: an IMDb-only title
      reaches the ad-free providers through this, and a TMDB-only one through
      `tmdbId`. */
  imdbId?: string | null;
  title: string;
  season: number;
  seasonName: string;
  seasons: TvSeasonOption[];
  episodes: TvEpisode[];
  source?: "tmdb" | "tvmaze";
  error?: string;
}

/** One season's episode guide for the list under the player. The Worker uses
    TMDB when it has a key and TVMaze otherwise, so this works keyless.
    `title` is what the keyless tier searches on, so always send it. */
export async function listSeason(opts: {
  tmdbId?: string | null;
  title?: string | null;
  imdbId?: string | null;
  season?: number;
}): Promise<TvSeasonPayload> {
  const q = new URLSearchParams();
  if (opts.tmdbId) q.set("tmdbId", String(opts.tmdbId));
  if (opts.title) q.set("title", opts.title);
  if (opts.imdbId) q.set("imdbId", opts.imdbId);
  q.set("season", String(opts.season ?? 1));
  return api.get<TvSeasonPayload>(`/tmdb/tv?${q.toString()}`);
}
