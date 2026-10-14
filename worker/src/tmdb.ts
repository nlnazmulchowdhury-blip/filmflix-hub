import { Hono } from "hono";
import type { Env } from "./index";
import { vaplayerEmbedUrl } from "../../src/lib/vaplayer";

/**
 * TMDB browse ("All Movies" section on the landing page).
 *
 * TMDB is the catalog source — it has a paginated browse API (vaplayer/vidapi
 * only embed by id). Every returned card carries a vaplayer embed URL so any
 * title on the site plays through the player's embed server, ad-free where the
 * Worker can resolve the stream and via the provider iframe otherwise.
 *
 * The landing page wants 10 cards per batch with a "Load More" button, while
 * TMDB only ever returns 20 per page — so `page` here is a 1-based *batch*
 * number and the Worker does the offset math (batch 1 → TMDB page 1 rows 0-9,
 * batch 2 → page 1 rows 10-19, batch 3 → page 2 rows 0-9, …).
 */

export const tmdbRoutes = new Hono<Env>();

const BATCH_SIZE = 60;
const TMDB_PAGE_SIZE = 20;
const IMG = "https://image.tmdb.org/t/p";

interface TmdbResult {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  release_date?: string | null;
  first_air_date?: string | null;
}

interface BrowseItem {
  tmdbId: string;
  kind: "movie" | "series";
  title: string;
  year?: number;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string;
  rating?: number;
  embedUrl: string;
}

const img = (path: string | null | undefined, size: string) =>
  path ? `${IMG}/${size}${path}` : null;

function toCard(r: TmdbResult): BrowseItem | null {
  const kind: "movie" | "series" = r.media_type === "tv" ? "series" : "movie";
  const title = (r.title ?? r.name ?? "").trim();
  if (!title) return null;
  const yearRaw = r.release_date ?? r.first_air_date ?? "";
  const year = Number(yearRaw.slice(0, 4)) || undefined;
  return {
    tmdbId: String(r.id),
    kind,
    title,
    year,
    posterUrl: img(r.poster_path, "w500"),
    backdropUrl: img(r.backdrop_path, "w780"),
    overview: r.overview ?? "",
    rating: r.vote_average,
    embedUrl: vaplayerEmbedUrl({ tmdbId: String(r.id), kind }),
  };
}

/** TMDB "all" section filter → trending endpoint media type. */
function sectionToMediaType(section: string) {
  return section === "movies" ? "movie" : section === "tv" ? "tv" : "all";
}

/* ------------------------------------------------------------------ */
/* Keyless fallback: scrape an embed provider's own home grid.         */
/*                                                                     */
/* vidbox.wtf (one of the supported embed hosts) server-renders a      */
/* trending grid where every poster <img alt="Title"> sits next to its */
/* /movie/{tmdbId} play link — so title + poster + id can be paired    */
/* without any API key. Used only when TMDB_API_KEY is absent, so the  */
/* "All Movies" grid still shows real movies + banners. Cached ~1h.    */
/* ------------------------------------------------------------------ */

const VIDBOX_HOME = "https://vidbox.wtf/home";
const VIDBOX_DISCOVER = "https://vidbox.wtf/api/search/discover";
const PROVIDER_PAGE_SIZE = 20;
const SCRAPE_CACHE_MS = 60 * 60 * 1000;
let scrapeCache: { at: number; items: BrowseItem[] } | null = null;
let homeCache: { at: number; html: string } | null = null;

const VIDBOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** The SSR home page backs both the keyless grid and the provider list. */
async function fetchVidboxHome(): Promise<string> {
  if (homeCache && Date.now() - homeCache.at < SCRAPE_CACHE_MS) return homeCache.html;
  const res = await fetch(VIDBOX_HOME, {
    headers: {
      "user-agent": VIDBOX_UA,
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) return homeCache?.html ?? "";
  const html = await res.text();
  if (html) homeCache = { at: Date.now(), html };
  return html;
}

/** wsrv.nl proxy URL → the underlying public image.tmdb.org poster path. */
function decodePoster(wsrv: string): string | null {
  const m = wsrv.match(/url=(https%3A%2F%2Fimage\.tmdb\.org[^&"]+)/);
  if (!m) return null;
  try {
    const decoded = decodeURIComponent(m[1]);
    // Normalise thumbnail sizes to a consistent w500 for card grids.
    return decoded.replace(/\/(w185|w300|w342|original)\//, "/w500/");
  } catch {
    return null;
  }
}

async function scrapeVidbox(): Promise<BrowseItem[]> {
  if (scrapeCache && Date.now() - scrapeCache.at < SCRAPE_CACHE_MS) {
    return scrapeCache.items;
  }
  const html = await fetchVidboxHome();
  if (!html) return scrapeCache?.items ?? [];

  const seen = new Set<string>();
  const items: BrowseItem[] = [];
  const imgRe = /<img[^>]*wsrv\.nl[^>]*alt="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) {
    const title = m[1].trim();
    const srcMatch = m[0].match(/src="([^"]+)"/);
    if (!title || !srcMatch) continue;
    const window_ = html.slice(m.index, m.index + 2500);
    const idMatch = window_.match(/href="\/movie\/(\d+)"/);
    if (!idMatch) continue;
    const tmdbId = idMatch[1];
    /* Dedup by title too: the home grid sometimes lists the same title under
       two ids (e.g. a film and its related cut), which would show twice. */
    const tkey = normTitle(title);
    if (seen.has(tmdbId) || seen.has(tkey)) continue;
    seen.add(tmdbId);
    seen.add(tkey);
    const poster = decodePoster(srcMatch[1]);
    if (!poster) continue;
    items.push({
      tmdbId,
      kind: "movie",
      title,
      posterUrl: poster,
      backdropUrl: null,
      overview: "",
      embedUrl: vaplayerEmbedUrl({ tmdbId, kind: "movie" }),
    });
  }
  if (items.length > 0) scrapeCache = { at: Date.now(), items };
  return items;
}

/* Keyless provider list: the same SSR home page renders a row of streaming
   service chips (Netflix, Prime Video, …) — each an anchor carrying the
   provider id, its logo (wsrv.nl → image.tmdb.org) and its name in alt.
   Powers the landing page "Providers" band; movies per provider come from
   vidbox's own discover API (see the provider branch in /browse). */

export interface ProviderInfo {
  id: string;
  name: string;
  logoUrl: string;
}

const PROVIDER_CAP = 400;
let providerCache: { at: number; list: ProviderInfo[] } | null = null;

/** wsrv.nl proxy URL → the underlying public image.tmdb.org logo path. */
function decodeLogo(wsrv: string): string | null {
  const m = wsrv.match(/url=(https%3A%2F%2Fimage\.tmdb\.org[^&"]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

async function scrapeProviders(): Promise<ProviderInfo[]> {
  if (providerCache && Date.now() - providerCache.at < SCRAPE_CACHE_MS) {
    return providerCache.list;
  }
  const html = await fetchVidboxHome();
  if (!html) return providerCache?.list ?? [];
  const list: ProviderInfo[] = [];
  const seen = new Set<string>();
  const chipRe = /href="\/search\?page=1&amp;watch_provider=(\d+)">/g;
  let m: RegExpExecArray | null;
  while ((m = chipRe.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    const seg = html.slice(m.index, m.index + 1200);
    const logoMatch = seg.match(/background-image:url\((https:\/\/wsrv\.nl\/[^)]+)\)/);
    const nameMatch = seg.match(/alt="([^"]+)"/);
    const logo = logoMatch ? decodeLogo(logoMatch[1]) : null;
    const name = nameMatch?.[1]?.trim();
    if (!logo || !name) continue;
    seen.add(id);
    list.push({ id, name, logoUrl: logo });
    if (list.length >= PROVIDER_CAP) break;
  }
  if (list.length > 0) providerCache = { at: Date.now(), list };
  return list;
}

tmdbRoutes.get("/providers", async (c) => {
  try {
    const providers = await scrapeProviders();
    return c.json({ providers });
  } catch (err) {
    console.error("provider scrape failed", err);
    return c.json({ providers: [] }, 502);
  }
});

/* Keyless category list: vidbox's search meta endpoint exposes the embed
   catalog's own movie genres (TMDB ids + names), so the landing chips are
   auto-populated from the embed source and /browse can filter by the same
   ids. Cached ~6h — the genre set rarely changes. */

export interface CategoryInfo {
  id: number;
  name: string;
}

const VIDBOX_META = "https://vidbox.wtf/api/search/meta?country=all";
const META_CACHE_MS = 6 * 60 * 60 * 1000;
let metaCache: { at: number; categories: CategoryInfo[] } | null = null;

async function fetchVidboxCategories(): Promise<CategoryInfo[]> {
  if (metaCache && Date.now() - metaCache.at < META_CACHE_MS) {
    return metaCache.categories;
  }
  const res = await fetch(VIDBOX_META, {
    headers: {
      accept: "application/json",
      "user-agent": VIDBOX_UA,
      referer: "https://vidbox.wtf/search",
    },
  });
  if (!res.ok) return metaCache?.categories ?? [];
  const data = (await res.json()) as {
    movieGenres?: { id: number; name: string }[];
  };
  const list = (data.movieGenres ?? [])
    .filter((g) => g?.name && typeof g?.id === "number")
    .map((g) => ({ id: g.id, name: g.name }));
  if (list.length > 0) metaCache = { at: Date.now(), categories: list };
  return list;
}

tmdbRoutes.get("/categories", async (c) => {
  try {
    const categories = await fetchVidboxCategories();
    return c.json({ categories });
  } catch (err) {
    console.error("category fetch failed", err);
    return c.json({ categories: [] }, 502);
  }
});

/* "More videos" for the player page: vidbox's movie watch page is SSR-
   rendered with a "You may also like" grid — each card pairs an
   /movie/{tmdbId} link with its wsrv.nl poster (title in alt, year in the
   subtitle), so related titles can be scraped keyless. Cached ~1h per title. */

const relatedCache = new Map<string, { at: number; items: BrowseItem[] }>();

async function scrapeRelated(tmdbId: string): Promise<BrowseItem[]> {
  const hit = relatedCache.get(tmdbId);
  if (hit && Date.now() - hit.at < SCRAPE_CACHE_MS) return hit.items;
  const res = await fetch(`https://vidbox.wtf/movie/${encodeURIComponent(tmdbId)}`, {
    headers: {
      "user-agent": VIDBOX_UA,
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) return hit?.items ?? [];
  const html = await res.text();
  const start = html.indexOf("You may also like");
  if (start < 0) return hit?.items ?? [];
  const window_ = html.slice(start, start + 60_000);
  const items: BrowseItem[] = [];
  const seen = new Set<string>([tmdbId]);
  const cardRe = /<a href="\/movie\/(\d+)">([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(window_)) && items.length < 18) {
    const id = m[1];
    const body = m[2];
    const title = body.match(/alt="([^"]+)"/)?.[1]?.trim();
    const src = body.match(/src="(https:\/\/wsrv\.nl[^"]+)"/)?.[1];
    if (!title || !src) continue;
    const tkey = normTitle(title);
    if (seen.has(id) || seen.has(tkey)) continue;
    const poster = decodePoster(src);
    if (!poster) continue;
    const year = Number(body.match(/(\d{4})\s*<\/p>/)?.[1]) || undefined;
    seen.add(id);
    seen.add(tkey);
    items.push({
      tmdbId: id,
      kind: "movie",
      title,
      year,
      posterUrl: poster,
      backdropUrl: null,
      overview: "",
      embedUrl: vaplayerEmbedUrl({ tmdbId: id, kind: "movie" }),
    });
  }
  if (items.length > 0) {
    if (relatedCache.size > 60) relatedCache.clear();
    relatedCache.set(tmdbId, { at: Date.now(), items });
  }
  return items;
}

tmdbRoutes.get("/related", async (c) => {
  const tmdbId = (c.req.query("tmdbId") ?? "").trim();
  if (!/^\d{1,10}$/.test(tmdbId))
    return c.json({ items: [], error: "Invalid tmdbId" }, 400);
  try {
    return c.json({ items: await scrapeRelated(tmdbId) });
  } catch (err) {
    console.error("related scrape failed", err);
    return c.json({ items: [] }, 502);
  }
});

/** vidbox discover API — keyless paginated catalog (20 rows per page).
    `genre` is a TMDB genre id ("all" = unfiltered). */
async function fetchDiscoverPage(watchProvider: string, p: number, genre = "all") {
  const url =
    `${VIDBOX_DISCOVER}?type=movie&page=${p}&sort=popularity` +
    `&genre=${encodeURIComponent(genre)}&year=all&watch_provider=${encodeURIComponent(watchProvider)}` +
    `&country=all&rating=all&now_playing=false&trending=false`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": VIDBOX_UA,
      referer: "https://vidbox.wtf/search",
    },
  });
  if (!res.ok) {
    console.error("discover page", p, "status", res.status);
    return null;
  }
  return (await res.json()) as { results?: TmdbResult[]; total_pages?: number };
}

/** One 60-item batch from discover; null when the source is unreachable. */
async function discoverBatch(
  watchProvider: string,
  batch: number,
  genre = "all",
): Promise<{ items: BrowseItem[]; page: number; hasMore: boolean } | null> {
  const offset = (batch - 1) * BATCH_SIZE;
  const firstPage = Math.floor(offset / PROVIDER_PAGE_SIZE) + 1;
  const rowInPage = offset % PROVIDER_PAGE_SIZE;
  const pagesNeeded = Math.ceil((rowInPage + BATCH_SIZE) / PROVIDER_PAGE_SIZE);
  /* Sequential: vidbox throttles parallel requests from one IP, which would
     silently drop the second page of the batch. */
  const pages: Awaited<ReturnType<typeof fetchDiscoverPage>>[] = [];
  for (let i = 0; i < pagesNeeded; i++) {
    pages.push(await fetchDiscoverPage(watchProvider, firstPage + i, genre));
  }
  const first = pages[0];
  if (!first?.results) return null;
  const rows: TmdbResult[] = [];
  for (const d of pages) if (d?.results) rows.push(...d.results);
  const items = rows
    .slice(rowInPage, rowInPage + BATCH_SIZE)
    .map(toCard)
    .filter((x): x is BrowseItem => x !== null);
  const totalPages = first.total_pages ?? 1;
  const hasMore =
    rows.length > rowInPage + BATCH_SIZE || firstPage + pagesNeeded - 1 < totalPages;
  return { items, page: batch, hasMore };
}

/* Keyless pad: iTunes top-movies RSS (JSON). The primary keyless scraper
   (vidbox) sometimes has fewer than a full batch; iTunes reliably returns
   current popular titles so the homepage still fills 60 cards without any
   API key. Merged after the primary source, deduped by title. */
const ITUNES_RSS = "https://itunes.apple.com/us/rss/topmovies/limit=100/json";

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

async function fetchItunesPad(): Promise<{ title: string; poster: string }[]> {
  try {
    const res = await fetch(ITUNES_RSS, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      feed?: { entry?: { title?: { label?: string }; "im:image"?: { label?: string }[] }[] };
    };
    const entries = data.feed?.entry ?? [];
    return entries
      .map((e) => {
        /* iTunes labels are "Title - Director"; keep just the title so pad
           cards don't duplicate the primary source's entries. */
        const title = (e.title?.label ?? "").split(" - ")[0].trim();
        const imgs = e["im:image"] ?? [];
        const poster = imgs[imgs.length - 1]?.label ?? imgs[0]?.label ?? "";
        return { title, poster };
      })
      .filter((x) => x.title);
  } catch {
    return [];
  }
}

tmdbRoutes.get("/browse", async (c) => {
  const batch = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1);
  const key = c.env.TMDB_API_KEY;
  const provider = (c.req.query("provider") ?? "").trim();
  const genre = (c.req.query("genre") ?? "").trim();

  /* Provider channel (Netflix, Prime Video, …): vidbox's own discover API
     filters by watch_provider keyless and returns TMDB-shaped rows, 40 per
     page with total_pages — same batch/offset math as the TMDB path. */
  if (provider) {
    try {
      const disc = await discoverBatch(provider, batch, genre || "all");
      if (!disc) {
        return c.json(
          { items: [], page: batch, hasMore: false, error: "Provider catalog unavailable" },
          502,
        );
      }
      return c.json(disc);
    } catch (err) {
      console.error("provider browse failed", err);
      return c.json({ items: [], page: batch, hasMore: false, error: "Provider fetch failed" }, 502);
    }
  }

  /* No TMDB key → keyless paginated catalog from vidbox discover so Load
     More keeps working; falls back to the home-grid scrape + iTunes pad
     when discover is unreachable (unfiltered batches only — the scrape
     carries no genre info). */
  if (!key) {
    try {
      const disc = await discoverBatch("all", batch, genre || "all");
      if (disc) return c.json(disc);
    } catch (err) {
      console.error("keyless discover failed", err);
    }
    if (genre) {
      return c.json(
        { items: [], page: batch, hasMore: false, error: "Category catalog unavailable" },
        502,
      );
    }
    try {
      let all = await scrapeVidbox();
      /* Pad to a full batch from iTunes when the primary source runs short. */
      if (all.length < BATCH_SIZE) {
        const have = new Set(all.map((x) => normTitle(x.title)));
        const pad = await fetchItunesPad();
        for (const p of pad) {
          if (all.length >= BATCH_SIZE * 2) break;
          const n = normTitle(p.title);
          if (have.has(n)) continue;
          have.add(n);
          all = [
            ...all,
            {
              tmdbId: `itunes-${n}`,
              kind: "movie",
              title: p.title,
              posterUrl: p.poster || null,
              backdropUrl: null,
              overview: "",
              /* No TMDB id → resolve the title to an embed via search at play
                 time is out of scope; reuse vaplayer by title is unreliable,
                 so these pad cards link to a vidsrc-style search embed. */
              embedUrl: "",
            },
          ];
        }
      }
      const offset = (batch - 1) * BATCH_SIZE;
      const items = all.slice(offset, offset + BATCH_SIZE);
      return c.json({ items, page: batch, hasMore: offset + BATCH_SIZE < all.length });
    } catch (err) {
      console.error("vidbox fallback failed", err);
      return c.json({ items: [], page: batch, hasMore: false, error: "Catalog unavailable" }, 502);
    }
  }

  const section = (c.req.query("section") ?? "all").toLowerCase();
  const mediaType = sectionToMediaType(section);

  const offset = (batch - 1) * BATCH_SIZE;
  const firstPage = Math.floor(offset / TMDB_PAGE_SIZE) + 1;
  const rowInPage = offset % TMDB_PAGE_SIZE;
  /* A 60-item batch spans several 20-row TMDB pages — fetch them in parallel. */
  const pagesNeeded = Math.ceil((rowInPage + BATCH_SIZE) / TMDB_PAGE_SIZE);

  const fetchPage = async (p: number) => {
    /* Trending has no genre filter — a selected category switches to the
       discover endpoint sorted by popularity instead. */
    const url = genre
      ? `https://api.themoviedb.org/3/discover/movie?api_key=${encodeURIComponent(key)}` +
        `&sort_by=popularity.desc&with_genres=${encodeURIComponent(genre)}&page=${p}`
      : `https://api.themoviedb.org/3/trending/${mediaType}/week` +
        `?api_key=${encodeURIComponent(key)}&page=${p}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as {
      results?: TmdbResult[];
      page?: number;
      total_pages?: number;
    };
  };

  try {
    const pages = await Promise.all(
      Array.from({ length: pagesNeeded }, (_, i) => fetchPage(firstPage + i)),
    );
    const first = pages[0];
    if (!first) {
      return c.json(
        { items: [], page: batch, hasMore: false, error: "TMDB responded error" },
        502,
      );
    }
    const rows: TmdbResult[] = [];
    for (const d of pages) if (d?.results) rows.push(...d.results);
    const items = rows
      .slice(rowInPage, rowInPage + BATCH_SIZE)
      .map(toCard)
      .filter((x): x is BrowseItem => x !== null);

    const totalPages = first.total_pages ?? 500;
    const lastPageFetched = firstPage + pagesNeeded - 1;
    const hasMore =
      rows.length > rowInPage + BATCH_SIZE || lastPageFetched < totalPages;

    return c.json({ items, page: batch, hasMore });
  } catch (err) {
    console.error("tmdb browse failed", err);
    return c.json({ items: [], page: batch, hasMore: false, error: "TMDB fetch failed" }, 502);
  }
});
