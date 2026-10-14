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
    // Bump w300/original to a consistent w500 for the card grid.
    return decoded.replace(/\/(w300|original|w185)\//, "/w500/");
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

  /* Provider channel (Netflix, Prime Video, …): vidbox's own discover API
     filters by watch_provider keyless and returns TMDB-shaped rows, 40 per
     page with total_pages — same batch/offset math as the TMDB path. */
  if (provider) {
    const offset = (batch - 1) * BATCH_SIZE;
    const firstPage = Math.floor(offset / PROVIDER_PAGE_SIZE) + 1;
    const rowInPage = offset % PROVIDER_PAGE_SIZE;
    const pagesNeeded = Math.ceil((rowInPage + BATCH_SIZE) / PROVIDER_PAGE_SIZE);

    const fetchPage = async (p: number) => {
      const url =
        `${VIDBOX_DISCOVER}?type=movie&page=${p}&sort=popularity` +
        `&genre=all&year=all&watch_provider=${encodeURIComponent(provider)}` +
        `&country=all&rating=all&now_playing=false&trending=false`;
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": VIDBOX_UA,
          referer: `https://vidbox.wtf/search?page=1&watch_provider=${encodeURIComponent(provider)}`,
        },
      });
      if (!res.ok) {
        console.error("discover page", p, "status", res.status);
        return null;
      }
      return (await res.json()) as { results?: TmdbResult[]; total_pages?: number };
    };

    try {
      /* Sequential: vidbox throttles parallel requests from one IP, which
         would silently drop the second page of the batch. */
      const pages: Awaited<ReturnType<typeof fetchPage>>[] = [];
      for (let i = 0; i < pagesNeeded; i++) pages.push(await fetchPage(firstPage + i));
      const first = pages[0];
      if (!first?.results) {
        return c.json(
          { items: [], page: batch, hasMore: false, error: "Provider catalog unavailable" },
          502,
        );
      }
      const rows: TmdbResult[] = [];
      for (const d of pages) if (d?.results) rows.push(...d.results);
      const items = rows
        .slice(rowInPage, rowInPage + BATCH_SIZE)
        .map(toCard)
        .filter((x): x is BrowseItem => x !== null);
      const totalPages = first.total_pages ?? 1;
      const hasMore =
        rows.length > rowInPage + BATCH_SIZE || firstPage + pagesNeeded - 1 < totalPages;
      return c.json({ items, page: batch, hasMore });
    } catch (err) {
      console.error("provider browse failed", err);
      return c.json({ items: [], page: batch, hasMore: false, error: "Provider fetch failed" }, 502);
    }
  }

  /* No TMDB key → fall back to the embed provider's own home grid so the
     landing still shows real movies + banners (keyless). */
  if (!key) {
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
    const url =
      `https://api.themoviedb.org/3/trending/${mediaType}/week` +
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
