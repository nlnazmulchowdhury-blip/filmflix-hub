import { action } from "./_generated/server";
import { v } from "convex/values";

/**
 * Home-page search that reaches beyond the local catalog.
 *
 * VidSrc's own listing/search API is retired (documented `vapi` endpoints now
 * 404), so we cannot ask vidsrc.to for titles directly. Instead we resolve a
 * title to an IMDb id via IMDb's public suggestion endpoint — this runs inside
 * a Convex action (server-side), so there is no CORS restriction and no API key
 * is required. The resulting id feeds `vidsrcEmbedUrl()` on the client, which
 * builds the "Server 1" embed.
 *
 * The suggestion endpoint is a prefix match: `/suggestion/{firstLetter}/{query}`
 * where `{firstLetter}` is the lowercased first character of the query.
 */
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

export const search = action({
  args: { q: v.string() },
  handler: async (_ctx, { q }): Promise<VidSrcSearchHit[]> => {
    const query = q.trim();
    if (query.length < 2) return [];

    const firstChar = (query.toLowerCase()[0] ?? "a").toLowerCase();
    const url = `${SUGGESTION_BASE}/${encodeURIComponent(firstChar)}/${encodeURIComponent(query)}.json`;

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
  },
});
