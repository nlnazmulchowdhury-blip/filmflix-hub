/** Shared IMDb-suggestion resolver — the single source of truth used by
 *  the Worker's /vidsrc/search route (and previously by the Convex action.
 *  Convex production is gone; the Worker hosts the only implementation now. */

export interface VidSrcSearchHit {
  imdbId: string;
  title: string;
  year?: number;
  /** "movie" → /embed/movie/{id}; "series" → /embed/tv/{id}/{season}/{episode}. */
  kind: "movie" | "series";
  posterUrl?: string;
  cast?: string;
}

const SUGGESTION_BASE = "https://v3.sg.media-imdb.com/suggestion";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** IMDb ids for films/series start with "tt"; "in…"/"nm…" rows are people,
 *  franchises and games and are filtered out. Only these two qids play on
 *  VidSrc's movie/tv embed paths. */
const PLAYABLE_QIDS = new Set(["movie", "tvSeries"]);

export async function vidSrcSearch(query: string): Promise<VidSrcSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const firstChar = (q.toLowerCase()[0] ?? "a").toLowerCase();
  const url = `${SUGGESTION_BASE}/${encodeURIComponent(firstChar)}/${encodeURIComponent(q)}.json`;

  let data: {
    d?: Array<{
      id?: string;
      l?: string;
      qid?: string;
      y?: number;
      s?: string;
      i?: { imageUrl?: string };
    }>;
  };
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch {
    return [];
  }

  const hits: VidSrcSearchHit[] = [];
  for (const r of data?.d ?? []) {
    const qid = r?.qid ?? "";
    const imdbId = r?.id ?? "";
    if (!PLAYABLE_QIDS.has(qid)) continue;
    if (!/^tt/i.test(imdbId)) continue;
    hits.push({
      imdbId,
      title: r?.l ?? "",
      year: typeof r?.y === "number" ? r.y : undefined,
      kind: qid === "tvSeries" ? "series" : "movie",
      posterUrl: r?.i?.imageUrl,
      cast: r?.s || undefined,
    });
    if (hits.length >= 12) break;
  }
  return hits;
}
