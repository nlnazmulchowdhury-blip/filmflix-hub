/**
 * Movie API integration — admin only.
 *
 * Lets the admin plug ANY movie-metadata API into FilmFlix without code
 * changes: the base URL + API key live as Convex env vars
 * (MOVIE_API_BASE / MOVIE_API_KEY) and the "probe" action below figures out
 * what kind of API is behind them (TMDB, OMDb, or a generic provider), so
 * the admin panel can search titles and import them into the catalog.
 *
 * The key is NEVER sent to the browser and NEVER committed — it is read
 * from process.env inside these actions only.
 */
import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

/** Role of a user, fetched via runQuery so this works in actions too
 *  (actions have no ctx.db). */
export const userRoleById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => (await ctx.db.get(userId))?.role ?? null,
});

async function requireAdminId(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const role = await ctx.runQuery(internal.movieApi.userRoleById, { userId });
  if (role !== "admin") throw new Error("Admin access required");
}

/** How the provider expects the key on each request. */
export type KeyStyle = "query" | "bearer" | "header" | "none";

const KEY_HEADERS = ["x-api-key", "api-key"];

function authHeaders(key: string, keyStyle: KeyStyle, keyHeader: string): Record<string, string> {
  if (keyStyle === "bearer") return { authorization: `Bearer ${key}` };
  if (keyStyle === "header") return { [keyHeader]: key };
  return {};
}

export interface ProbeResult {
  ok: boolean;
  kind: "tmdb" | "omdb" | "unknown";
  base: string;
  keyStyle: KeyStyle;
  keyHeader: string;
  detail: string;
}

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

/** Build candidate bases: as-given, plus a /v3 variant (TMDB-style). */
function candidateBases(base: string): string[] {
  const b = normalizeBase(base);
  return !/\/v\d+$/.test(b) ? [b, `${b}/v3`] : [b];
}

/** Try several auth styles / paths and identify the API type. */
async function detectProvider(base: string, key: string): Promise<ProbeResult> {
  const keyStyles: KeyStyle[] = key ? ["query", "bearer", "header"] : ["none"];
  let lastErr = "";
  for (const b of candidateBases(base)) {
    for (const style of keyStyles) {
      const headers = style === "header" ? KEY_HEADERS : [""];
      for (const header of headers) {
        for (const path of ["/movie/550", "/configuration"]) {
          try {
            const url = new URL(`${b}${path}`);
            if (style === "query") url.searchParams.set("api_key", key);
            const res = await fetch(url.toString(), {
              headers: authHeaders(key, style, header || "x-api-key"),
            });
            if (!res.ok) {
              lastErr = `${res.status} ${res.statusText} — ${b}${path} (${style}${header ? ":" + header : ""})`;
              continue;
            }
            const text = await res.text();
            let data: any;
            try {
              data = JSON.parse(text);
            } catch {
              lastErr = `non-JSON response from ${b}${path}`;
              continue;
            }
            // TMDB: /movie/550 is "Fight Club"; /configuration returns images.
            if (path === "/movie/550" && data?.title === "Fight Club" && data?.id === 550) {
              return {
                ok: true, kind: "tmdb", base: b, keyStyle: style, keyHeader: header,
                detail: `TMDB চেনা গেছে (${b}${path}, key style: ${style})`,
              };
            }
            if (data?.images?.secure_base_url || data?.change_keys) {
              return {
                ok: true, kind: "tmdb", base: b, keyStyle: style, keyHeader: header,
                detail: `TMDB চেনা গেছে (/configuration @ ${b}, key style: ${style})`,
              };
            }
            // OMDb-flavored responses.
            if (data?.Response === "False" || data?.Title || data?.Search) {
              return {
                ok: true, kind: "omdb", base: b, keyStyle: style, keyHeader: header,
                detail: `OMDb-স্টাইল API চেনা গেছে (${b}, key style: ${style})`,
              };
            }
            lastErr = `unrecognized JSON from ${b}${path}: ${text.slice(0, 120)}`;
          } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err);
          }
        }
      }
    }
  }
  return {
    ok: false,
    kind: "unknown",
    base: normalizeBase(base),
    keyStyle: key ? "query" : "none",
    keyHeader: "x-api-key",
    detail: lastErr || "কোনো এন্ডপয়েন্টে সাড়া পাওয়া যায়নি",
  };
}

/* ------------------------------------------------------------------ */
/* Settings + probe (admin UI)                                         */
/* ------------------------------------------------------------------ */

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    await requireAdminId(ctx);
    return {
      base: process.env.MOVIE_API_BASE ?? "",
      hasKey: !!process.env.MOVIE_API_KEY,
    };
  },
});

export const probeAction = action({
  args: { base: v.optional(v.string()) },
  handler: async (ctx, { base }): Promise<ProbeResult> => {
    await requireAdminId(ctx);
    const useBase = normalizeBase(base || process.env.MOVIE_API_BASE || "");
    const key = (process.env.MOVIE_API_KEY ?? "").trim();
    if (!useBase) {
      throw new Error("Base URL নেই — MOVIE_API_BASE সেট করুন বা টেস্ট URL লিখুন");
    }
    return detectProvider(useBase, key);
  },
});

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface ApiSearchHit {
  externalId: string;
  title: string;
  year?: number;
  posterUrl?: string;
  overview?: string;
  rating?: number;
  kind: "movie" | "series";
}

function yearFrom(date?: string): number | undefined {
  const y = date?.slice(0, 4);
  const n = y ? Number(y) : NaN;
  return Number.isFinite(n) && n > 1800 ? n : undefined;
}

async function searchTmdb(
  base: string, key: string, style: KeyStyle, header: string, q: string,
): Promise<ApiSearchHit[]> {
  const hits: ApiSearchHit[] = [];
  let imgBase = "https://image.tmdb.org/t/p";
  try {
    const cfgUrl = new URL(`${base}/configuration`);
    if (style === "query") cfgUrl.searchParams.set("api_key", key);
    const cfgRes = await fetch(cfgUrl.toString(), { headers: authHeaders(key, style, header) });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      imgBase = (cfg?.images?.secure_base_url ?? imgBase).replace(/\/+$/, "");
    }
  } catch { /* default image base */ }

  for (const kind of ["movie", "tv"] as const) {
    const url = new URL(`${base}/search/${kind}`);
    url.searchParams.set("query", q);
    url.searchParams.set("include_adult", "false");
    if (style === "query") url.searchParams.set("api_key", key);
    const res = await fetch(url.toString(), { headers: authHeaders(key, style, header) });
    if (!res.ok) continue;
    const data = await res.json();
    for (const r of data?.results ?? []) {
      const title = r.title ?? r.name;
      if (!title) continue;
      hits.push({
        externalId: `tmdb:${kind}:${r.id}`,
        title,
        year: yearFrom(r.release_date ?? r.first_air_date),
        posterUrl: r.poster_path ? `${imgBase}/w500${r.poster_path}` : undefined,
        overview: r.overview || undefined,
        rating: typeof r.vote_average === "number" && r.vote_average > 0 ? r.vote_average : undefined,
        kind: kind === "tv" ? "series" : "movie",
      });
    }
  }
  return hits.slice(0, 20);
}

async function searchOmdb(
  base: string, key: string, style: KeyStyle, header: string, q: string,
): Promise<ApiSearchHit[]> {
  // OMDb root: https://www.omdbapi.com/ with ?apikey=…&s=query
  const u = new URL(base);
  u.searchParams.set("s", q);
  if (style === "query") u.searchParams.set("apikey", key);
  const res = await fetch(u.toString(), { headers: authHeaders(key, style, header) });
  if (!res.ok) return [];
  const data = await res.json();
  const hits: ApiSearchHit[] = [];
  for (const r of data?.Search ?? []) {
    hits.push({
      externalId: `omdb:${r.Type === "series" ? "series" : "movie"}:${r.imdbID}`,
      title: r.Title,
      year: yearFrom(r.Year),
      posterUrl: r.Poster && r.Poster !== "N/A" ? r.Poster : undefined,
      kind: r.Type === "series" ? "series" : "movie",
    });
  }
  return hits.slice(0, 20);
}

async function searchGeneric(
  base: string, key: string, style: KeyStyle, header: string, q: string,
): Promise<ApiSearchHit[]> {
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("query", q);
  if (style === "query") url.searchParams.set("api_key", key);
  const res = await fetch(url.toString(), { headers: authHeaders(key, style, header) });
  if (!res.ok) {
    throw new Error(`API search failed (${res.status}) — প্রোভাইডারের search এন্ডপয়েন্ট চেনা যায়নি`);
  }
  const data = await res.json();
  const list: any[] = Array.isArray(data)
    ? data
    : (data?.results ?? data?.movies ?? data?.data ?? []);
  const hits: ApiSearchHit[] = [];
  for (const r of list) {
    const title = r.title ?? r.name;
    if (!title) continue;
    hits.push({
      externalId: String(r.id ?? r.tmdbId ?? r.imdbId ?? title),
      title,
      year: yearFrom(r.release_date ?? r.year ?? r.first_air_date),
      posterUrl: r.poster_path ?? r.posterUrl ?? undefined,
      overview: r.overview ?? r.description ?? undefined,
      rating: typeof r.rating === "number" ? r.rating
        : typeof r.vote_average === "number" ? r.vote_average : undefined,
      kind: r.type === "series" || r.media_type === "tv" || !!r.first_air_date ? "series" : "movie",
    });
  }
  return hits.slice(0, 20);
}

export const searchAction = action({
  args: { q: v.string() },
  handler: async (ctx, { q }): Promise<{ kind: string; hits: ApiSearchHit[] }> => {
    await requireAdminId(ctx);
    const base = normalizeBase(process.env.MOVIE_API_BASE ?? "");
    const key = (process.env.MOVIE_API_KEY ?? "").trim();
    if (!base) throw new Error("MOVIE_API_BASE সেট করা নেই — আগে প্রোভাইডারের base URL জানিয়ে নিন");
    if (!key) throw new Error("MOVIE_API_KEY সেট করা নেই");

    const guess = await detectProvider(base, key);
    if (guess.kind === "tmdb") {
      return { kind: "tmdb", hits: await searchTmdb(guess.base, key, guess.keyStyle, guess.keyHeader, q) };
    }
    if (guess.kind === "omdb") {
      return { kind: "omdb", hits: await searchOmdb(guess.base, key, guess.keyStyle, guess.keyHeader, q) };
    }
    return { kind: "generic", hits: await searchGeneric(guess.base, key, guess.keyStyle, guess.keyHeader, q) };
  },
});

/* ------------------------------------------------------------------ */
/* Import a picked hit into the catalog                                */
/* ------------------------------------------------------------------ */

export const importMovie = mutation({
  args: {
    title: v.string(),
    year: v.optional(v.number()),
    posterUrl: v.optional(v.string()),
    description: v.optional(v.string()),
    rating: v.optional(v.number()),
    kind: v.optional(v.union(v.literal("movie"), v.literal("series"))),
    videoUrl: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdminId(ctx);
    const order = (await ctx.db.query("movies").withIndex("order").collect()).length;
    const names = [...new Set([args.category ?? ""].map((c) => c.trim()).filter(Boolean))];
    const { category, ...rest } = args;
    return await ctx.db.insert("movies", {
      ...rest,
      categories: names.length > 0 ? names : undefined,
      category: names[0],
      order,
    });
  },
});
