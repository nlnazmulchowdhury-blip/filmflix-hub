/** Shapes the MovieApiPanel needs. Mirrors the legacy Convex action contracts
 *  (found by reading src/convex/_legacy/*), served now by Worker routes. */
export type KeyStyle = "query" | "bearer" | "header" | "none";

export interface ProbeResult {
  ok: boolean;
  kind: "tmdb" | "omdb" | "unknown";
  base: string;
  keyStyle: KeyStyle;
  keyHeader: string;
  detail: string;
}

export interface ApiSearchHit {
  externalId: string;
  title: string;
  year?: number;
  posterUrl?: string;
  overview?: string;
  rating?: number;
  kind: "movie" | "series";
}

export interface ElaachSearchHit {
  imdbId: string;
  section: string;
  kind: "movie" | "series";
  title: string;
  posterUrl?: string;
  rating?: number;
  genre?: string;
  url: string;
}

export interface MbSearchHit {
  subjectId: string;
  title: string;
  kind: "movie" | "series";
  posterUrl?: string;
  year?: number;
  rating?: number;
  genre?: string;
  overview?: string;
  episodes?: { season: number; episode: number; title?: string }[];
  [key: string]: unknown;
}
