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

/** Fetch one 60-item batch (page is a 1-based batch number, not a TMDB page).
    `provider` filters the batch to one streaming channel's catalog. */
export async function browseTmdb(
  page = 1,
  section = "all",
  provider?: string | null,
): Promise<TmdbPage> {
  const q = provider ? `&provider=${encodeURIComponent(provider)}` : "";
  return api.get<TmdbPage>(
    `/tmdb/browse?page=${page}&section=${encodeURIComponent(section)}${q}`,
  );
}

/** The streaming channels shown in the landing "Providers" band. */
export async function listProviders(): Promise<ProviderInfo[]> {
  const r = await api.get<{ providers: ProviderInfo[] }>(`/tmdb/providers`);
  return r.providers ?? [];
}
