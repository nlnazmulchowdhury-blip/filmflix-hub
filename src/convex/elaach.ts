/**
 * Elaach (elaach.com) provider integration — admin only.
 *
 * The site is plain server-rendered HTML: no API key, no signing. Two pages
 * are all we need:
 *   search  GET https://www.elaach.com/search?q=<query>
 *           -> a grid of `.card` blocks, each linking to
 *              /movies/<imdbId> | /tv-series/<imdbId> | /movie-series/<imdbId>
 *   detail  GET https://www.elaach.com/movies/<imdbId>
 *           -> .details__title, .card__cover img, .card__rate,
 *              .card__meta (genre + release year), .card__description,
 *              quality in .card__list, and a DIRECT mp4 on
 *              content.elaach.com (both the download link and
 *              <video><source>).
 *
 * Parsing lives inside this action so the browser only ever sees the parsed
 * fields, imports go through internal.movies.addInternal (the same path the
 * MovieBox import uses), and both actions are gated by the admin role check.
 *
 * ID NOTE (verified against the live site): search results only ever link
 * `/movies/<imdbId>` — the separate TV catalog uses NUMERIC ids
 * (`/tv-series/247168`) and is not returned by /search, so imports are
 * IMDb-id based. A non-tt id is rejected by the guard in importMovie rather
 * than silently imported.
 */
import { v } from "convex/values";
import { action, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

const BASE = "https://www.elaach.com";

/** Desktop UA — the site serves the full card grid to browsers. */
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

/** Detail page paths that carry a single title, and the catalog kind each
 *  maps to. */
const SECTION_KIND: Record<string, "movie" | "series"> = {
  movies: "movie",
  "tv-series": "series",
  "movie-series": "series",
};

/** Role gate — reuses movieApi.userRoleById (queries can't live next to a
 *  "use node" file, and actions have no ctx.db of their own). */
async function requireAdminId(ctx: ActionCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const role = await ctx.runQuery(internal.movieApi.userRoleById, { userId });
  if (role !== "admin") throw new Error("Admin access required");
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) {
    throw new Error(`elaach responded ${res.status} ${res.statusText} — ${url}`);
  }
  return await res.text();
}

/** Decode the entities the site actually emits (&#039;, &#8217;, …). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const n = Number(d);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Tag-stripped, whitespace-collapsed text from an HTML fragment. */
function text(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Absolute URL for the site's relative / protocol-relative asset paths
 *  (search cards use `uploads/…`, detail pages use `/uploads/…`). */
function absUrl(src: string): string {
  const s = (src ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  return `${BASE}/${s.replace(/^\/+/, "")}`;
}

function firstMatch(re: RegExp, html: string): string | undefined {
  const m = re.exec(html);
  return m?.[1]?.trim() || undefined;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

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

export const searchAction = action({
  args: { q: v.string() },
  handler: async (ctx, { q }): Promise<ElaachSearchHit[]> => {
    await requireAdminId(ctx);
    const query = q.trim();
    if (!query) return [];

    const html = await fetchHtml(
      `${BASE}/search?q=${encodeURIComponent(query)}`,
    );

    const hits: ElaachSearchHit[] = [];
    const seen = new Set<string>();
    // Every result is its own `<div class="card">` block; splitting on that
    // literal keeps the per-field regexes from bleeding across cards.
    for (const card of html.split('<div class="card">').slice(1)) {
      const link = /href="\/([a-z-]+)\/(tt[0-9a-zA-Z]+)"/.exec(card);
      const section = link?.[1] ?? "";
      const imdbId = link?.[2] ?? "";
      if (!imdbId || !(section in SECTION_KIND)) continue;

      const title = firstMatch(
        /class="card__title">\s*<a[^>]*>([\s\S]*?)<\/a>/,
        card,
      );
      if (!title) continue;

      const key = `${section}/${imdbId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const poster = firstMatch(/<img[^>]+src="([^"]+)"/, card);
      const rate = firstMatch(
        /class="card__rate">[\s\S]*?<\/i>\s*([\d.]+)/,
        card,
      );
      const genre = firstMatch(
        /class="card__category">\s*<a[^>]*>([^<]*)<\/a>/,
        card,
      );
      const rating = rate ? Number(rate) : NaN;

      hits.push({
        imdbId,
        section,
        kind: SECTION_KIND[section],
        title: text(title),
        posterUrl: poster ? absUrl(poster) : undefined,
        rating: Number.isFinite(rating) ? rating : undefined,
        genre: genre?.trim() || undefined,
        url: `${BASE}/${section}/${imdbId}`,
      });
      if (hits.length >= 20) break;
    }
    return hits;
  },
});

/* ------------------------------------------------------------------ */
/* Import a picked hit into the catalog                                */
/* ------------------------------------------------------------------ */

export interface ElaachImportResult {
  movieId: string;
  title: string;
  videoKind: "movie" | "none";
  quality?: string;
  detailError?: string;
}

export const importMovie = action({
  args: {
    imdbId: v.string(),
    section: v.optional(v.string()),
    fallback: v.optional(
      v.object({
        title: v.string(),
        posterUrl: v.optional(v.string()),
        rating: v.optional(v.number()),
        genre: v.optional(v.string()),
        kind: v.optional(v.union(v.literal("movie"), v.literal("series"))),
      }),
    ),
  },
  handler: async (ctx, { imdbId, section, fallback }): Promise<ElaachImportResult> => {
    await requireAdminId(ctx);
    // The id is interpolated into the request URL — keep it to an IMDb id.
    if (!/^tt[0-9a-zA-Z]{4,12}$/.test(imdbId)) {
      throw new Error(`অবৈধ IMDb id: ${imdbId}`);
    }
    const sec = section && section in SECTION_KIND ? section : "movies";

    let html = "";
    let detailError: string | undefined;
    try {
      html = await fetchHtml(`${BASE}/${sec}/${imdbId}`);
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    }

    const rawTitle = firstMatch(
      /<h1 class="details__title">([\s\S]*?)<\/h1>/,
      html,
    );
    const title = (rawTitle && text(rawTitle)) || fallback?.title || "Untitled";

    // Detail pages use a site-relative path (`/uploads/…`) — absolutize it
    // or the catalog would render broken images.
    const poster =
      absUrl(firstMatch(/<img[^>]+src="([^"]*\/uploads\/movies\/[^"]+)"/, html) ?? "") ||
      fallback?.posterUrl;

    const rate = firstMatch(
      /class="card__rate">[\s\S]*?<\/i>\s*([\d.]+)/,
      html,
    );
    const parsedRating = rate ? Number(rate) : NaN;
    const rating = Number.isFinite(parsedRating)
      ? parsedRating
      : fallback?.rating;

    const meta = /class="card__meta">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
    const genreLinks = [...meta.matchAll(/<a[^>]*>([^<]*)<\/a>/g)]
      .map((m) => text(m[1]))
      .filter(Boolean);
    const genre =
      genreLinks.length > 0 ? genreLinks.join(", ") : fallback?.genre;

    const rawYear = firstMatch(
      /<span>Release year:<\/span>\s*([0-9]{1,2}\/[A-Za-z]{3}\/[0-9]{4})/,
      html,
    );
    const year = rawYear ? Number(rawYear.split("/").pop()) : undefined;

    const description = firstMatch(
      /<div class="card__description card__description--details">([\s\S]*?)<\/div>/,
      html,
    );

    const quality = firstMatch(
      /<ul class="card__list">\s*<li>([^<]*)<\/li>/,
      html,
    );

    // Direct file: the <video> source, else the download link that sits next
    // to `id="count_play_download"`.
    let videoUrl = firstMatch(/<source[^>]+src="([^"]+)"/, html);
    if (!videoUrl) {
      const idx = html.indexOf('id="count_play_download"');
      if (idx > -1) {
        const before = html.slice(Math.max(0, idx - 500), idx);
        const hrefs = [...before.matchAll(/href="([^"]+)"/g)];
        videoUrl = hrefs[hrefs.length - 1]?.[1];
      }
    }
    videoUrl =
      videoUrl && /^https?:\/\//i.test(videoUrl) ? videoUrl : undefined;

    const backdrop = firstMatch(/<video[^>]+poster="([^"]+)"/, html);
    const kind = SECTION_KIND[sec];

    const movieId = await ctx.runMutation(internal.movies.addInternal, {
      title: year ? `${title} (${year})` : title,
      description,
      posterUrl: poster,
      backdropUrl: backdrop,
      videoUrl,
      genre,
      year,
      rating,
      kind,
      downloads:
        videoUrl && quality
          ? [{ label: quality, url: videoUrl }]
          : videoUrl
            ? [{ label: "HD", url: videoUrl }]
            : undefined,
    });

    return {
      movieId,
      title,
      videoKind: videoUrl ? "movie" : "none",
      quality,
      detailError,
    };
  },
});
