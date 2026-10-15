import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import MovieCard from "@/components/MovieCard";
import VidSrcResultCard, { type VidSrcHit } from "@/components/VidSrcResultCard";
import { vidsrcEmbedUrl } from "@/lib/vidsrc";
import {
  browseTmdb,
  listCategories,
  listProviders,
  type CategoryInfo,
  type ProviderInfo,
  type TmdbItem,
} from "@/lib/tmdb";
import ThemeToggle from "@/components/ThemeToggle";
import AdBanner from "@/components/AdBanner";
import AdContainer from "@/components/AdContainer";
import AdRail from "@/components/AdRail";
import { AD_BANNERS } from "@/lib/ad-banners";
import { api } from "@/convex/_generated/api";
import { movieCategoryNames } from "@/lib/categories";
import { useAuth } from "@/hooks/use-auth";
import { useAction, useQuery } from "convex/react";
import { Dices, Film, LogOut, Menu, Play, Search, ShieldCheck, Tv, X, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/** Lowercase, strip punctuation, collapse whitespace — forgiving matching. */
function normalizeText(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Everything a movie can be found by: title, description, categories, year, kind. */
function searchableText(m: {
  title: string;
  description?: string;
  category?: string;
  categories?: string[];
  year?: number;
  kind?: string;
}) {
  return normalizeText(
    [m.title, m.description, ...movieCategoryNames(m), m.year?.toString(), m.kind]
      .filter(Boolean)
      .join(" "),
  );
}

export default function Landing() {
  const { signOut, isAuthenticated } = useAuth();
  const movies = useQuery(api.movies.list);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  /* -------- Category chips (auto-populated from the embed catalog) ------ */
  /* The embed source's own movie genres, so every chip has real movies
     behind it; picking one reloads the browse grid filtered to that genre. */
  const [embedCategories, setEmbedCategories] = useState<CategoryInfo[]>([]);
  const [genre, setGenre] = useState<CategoryInfo | null>(null);

  /* -------- External VidSrc search (titles beyond the local catalog) ---- */
  const searchExternal = useAction(api.vidsrc.search);
  /* Hits are stored with the query they were resolved for, so a slow response
     for a previous query never shows up under the current one. */
  const [external, setExternal] = useState<{ q: string; hits: VidSrcHit[] } | null>(null);
  const [externalLoading, setExternalLoading] = useState(false);

  /* -------- TMDB browse: the full IMDB-wide movie grid ------------------ */
  /* Fetched 60 titles at a time from the Worker; "Load More" appends the next
     batch. Cards play via the vaplayer embed server (Server 2). The grid is
     channel-aware: picking a provider tile reloads it with that channel's
     catalog (`provider` param on /tmdb/browse). */
  const [tmdbItems, setTmdbItems] = useState<TmdbItem[]>([]);
  const [tmdbBatch, setTmdbBatch] = useState(0);
  const [tmdbLoading, setTmdbLoading] = useState(false);
  const [tmdbMore, setTmdbMore] = useState(true);
  const [tmdbError, setTmdbError] = useState("");

  /* -------- Providers band (Netflix, Prime Video, …) -------------------- */
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderInfo | null>(null);
  const [rowExpanded, setRowExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const loadTmdb = useCallback(
    async (batch: number, providerId: string | null, genreId: number | null) => {
      setTmdbLoading(true);
      setTmdbError("");
      try {
        const r = await browseTmdb(batch, "all", providerId, genreId);
        if (r.error) setTmdbError(r.error);
        setTmdbItems((prev) => (batch <= 1 ? r.items : [...prev, ...r.items]));
        setTmdbBatch(batch);
        setTmdbMore(r.hasMore && r.items.length > 0);
      } catch (err) {
        setTmdbError(
          err instanceof Error ? err.message : "Could not load movies right now",
        );
        setTmdbMore(false);
      } finally {
        setTmdbLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    listProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
    listCategories()
      .then(setEmbedCategories)
      .catch(() => setEmbedCategories([]));
  }, []);

  /* Reload batch 1 whenever the selected channel or category changes
     (null = all). */
  useEffect(() => {
    void loadTmdb(1, selectedProvider?.id ?? null, genre?.id ?? null);
  }, [loadTmdb, selectedProvider, genre]);

  /** Clicking a channel tile filters the grid to it; clicking again clears. */
  const selectProvider = (p: ProviderInfo) => {
    setQuery("");
    setSelectedProvider((cur) => {
      const next = cur?.id === p.id ? null : p;
      setTmdbItems([]);
      setTmdbMore(true);
      return next;
    });
  };

  /** Clicking a category chip filters the grid to that genre; again clears. */
  const selectGenre = (cat: CategoryInfo) => {
    setQuery("");
    setTmdbItems([]);
    setTmdbMore(true);
    setGenre((cur) => (cur?.id === cat.id ? null : cat));
  };

  const clearGenre = () => {
    setQuery("");
    setTmdbItems([]);
    setTmdbMore(true);
    setGenre(null);
  };

  const scrollRow = (dir: 1 | -1) => {
    rowRef.current?.scrollBy({ left: dir * 340, behavior: "smooth" });
  };

  /* Open a browse card in the site player: the vaplayer- synthetic route feeds
     its embed URL straight into PlayerStage's ad-free embed server. Cards that
     carry no embed id (keyless pad entries) resolve their title to an IMDb id
     first and play through Server 1 (VidSrc). */
  const playTmdb = async (item: TmdbItem) => {
    if (item.embedUrl) {
      navigate(`/movie/vaplayer-${item.tmdbId}`, {
        state: {
          external: "vaplayer",
          tmdbId: item.tmdbId,
          kind: item.kind,
          title: item.title,
          posterUrl: item.posterUrl ?? undefined,
          backdropUrl: item.backdropUrl ?? undefined,
          overview: item.overview,
          embedUrl: item.embedUrl,
        },
      });
      return;
    }
    try {
      const hits = await searchExternal({ q: item.title });
      const hit = hits?.[0];
      if (hit) {
        navigate(`/movie/vidsrc-${hit.imdbId}`, {
          state: {
            external: true,
            imdbId: hit.imdbId,
            kind: hit.kind,
            title: hit.title,
            posterUrl: hit.posterUrl,
          },
        });
      } else {
        toast?.error?.(`No stream found for “${item.title}”`);
      }
    } catch {
      /* keep the grid usable even if the resolve fails */
    }
  };

  /** Display a TMDB card through the shared poster-card component. */
  const tmdbToHit = (item: TmdbItem): VidSrcHit => ({
    imdbId: `tmdb-${item.tmdbId}`,
    title: item.title,
    year: item.year,
    kind: item.kind,
    posterUrl: item.posterUrl ?? undefined,
  });


  const trimmedQuery = query.trim();
  /* Only surface external hits that match what's in the box right now. */
  const externalHits = external && external.q === trimmedQuery ? external.hits : null;

  /* Debounced: resolve the typed title against IMDb (server-side, keyless)
     so results that aren't in the catalog still play via Server 1. */
  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setExternal(null);
      setExternalLoading(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      setExternalLoading(true);
      searchExternal({ q: trimmedQuery })
        .then((hits) => {
          if (!cancelled) setExternal({ q: trimmedQuery, hits });
        })
        .catch(() => {
          if (!cancelled) setExternal({ q: trimmedQuery, hits: [] });
        })
        .finally(() => {
          if (!cancelled) setExternalLoading(false);
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trimmedQuery, searchExternal]);

  const playExternal = (hit: VidSrcHit) => {
    navigate(`/movie/vidsrc-${hit.imdbId}`, {
      state: {
        external: true,
        imdbId: hit.imdbId,
        kind: hit.kind,
        title: hit.title,
        posterUrl: hit.posterUrl,
      },
    });
  };

  /** Local catalog rows matching the typed query (title, description, …). */
  const filtered = useMemo(() => {
    if (!movies) return null;
    let rows = movies;
    const raw = query.trim();
    if (raw) {
      const tokens = normalizeText(raw).split(" ").filter(Boolean);
      if (tokens.length > 0) {
        rows = rows.filter((m: any) => {
          const hay = searchableText(m);
          // Every word in the query must match somewhere (order doesn't matter).
          return tokens.every((t) => hay.includes(t));
        });
        // Most relevant first: full-phrase title match > word in title > word in category > elsewhere.
        const score = (m: (typeof rows)[number]) => {
          const title = normalizeText(m.title);
          const cats = normalizeText(movieCategoryNames(m).join(" "));
          const phrase = normalizeText(raw);
          if (title.includes(phrase)) return 3;
          if (tokens.some((t) => title.includes(t))) return 2;
          if (tokens.some((t) => cats.includes(t))) return 1;
          return 0;
        };
        rows = [...rows].sort((a, b) => score(b) - score(a));
      }
    }
    return rows;
  }, [movies, query]);

  const localResults = filtered ?? [];
  /* While searching, external VidSrc hits are merged into the same grid as
     ordinary results so a title that isn't in our library still shows up (and
     plays) exactly like a catalog entry — the viewer can't tell the difference. */
  const externalResults = trimmedQuery.length >= 2 ? externalHits ?? [] : [];
  const catalog = [...localResults, ...externalResults];
  /* While a search is active the grid shows those results; otherwise it
     browses the selected category/channel (or the full catalog). */
  const inResultsMode = trimmedQuery.length > 0;

  const surprise = () => {
    if (!movies || movies.length === 0) return;
    const pick = movies[Math.floor(Math.random() * movies.length)];
    navigate(`/movie/${pick._id}`);
  };

  const [menuOpen, setMenuOpen] = useState(false);
  const navLinkClass =
    "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/14 blur-[140px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[380px] w-[520px] rounded-full bg-primary/8 blur-[120px]" />
        <div className="absolute bottom-[10%] left-[-12%] h-[300px] w-[400px] rounded-full bg-chart-2/10 blur-[120px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6">
          <Link to="/" aria-label="FilmFlix home" className="shrink-0">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-6 md:flex">
            <Link to="/" className={navLinkClass}>Home</Link>
            <button type="button" onClick={surprise} className={navLinkClass}>
              Random
            </button>
            <a href="#providers" className={navLinkClass}>Providers</a>
            <Link
              to={isAuthenticated ? "/dashboard" : `/auth?returnTo=%2Fdashboard`}
              className={navLinkClass}
            >
              Library
            </Link>
            <Link to="/tv" className={navLinkClass}>
              TV
            </Link>
            <Link to="/download" className={navLinkClass}>
              Download
            </Link>
          </nav>
          {/* Mobile: hamburger + slide-in menu (desktop keeps the inline nav). */}
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden text-muted-foreground hover:text-foreground"
                aria-label="Open menu"
              >
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle className="font-display">Menu</SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-4 pb-6">
                {[
                  { label: "Home", to: "/" },
                  { label: "Random", action: () => { setMenuOpen(false); surprise(); } },
                  { label: "Providers", href: "#providers" },
                  {
                    label: "Library",
                    to: isAuthenticated ? "/dashboard" : "/auth?returnTo=%2Fdashboard",
                  },
                  { label: "TV", to: "/tv" },
                  { label: "Download", to: "/download" },
                  ...(isAuthenticated
                    ? [
                        {
                          label: "Sign out",
                          action: () => {
                            setMenuOpen(false);
                            void signOut();
                          },
                        },
                      ]
                    : []),
                ].map((item) =>
                  item.action ? (
                    <button
                      key={item.label}
                      type="button"
                      onClick={item.action}
                      className="rounded-lg px-3 py-2.5 text-left text-base font-medium text-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      {item.label}
                    </button>
                  ) : item.href ? (
                    <a
                      key={item.label}
                      href={item.href}
                      onClick={() => setMenuOpen(false)}
                      className="rounded-lg px-3 py-2.5 text-base font-medium text-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      {item.label}
                    </a>
                  ) : (
                    <Link
                      key={item.label}
                      to={item.to ?? "/"}
                      onClick={() => setMenuOpen(false)}
                      className="rounded-lg px-3 py-2.5 text-base font-medium text-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      {item.label}
                    </Link>
                  ),
                )}
              </nav>
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-0.5 sm:gap-2">
            {/* Random pick stays reachable on phones where the nav is hidden. */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden text-muted-foreground hover:text-foreground"
              onClick={surprise}
              aria-label="Random movie"
              title="Random movie"
            >
              <Dices className="size-4" />
            </Button>
            {isAuthenticated ? (
              <Button
                variant="ghost"
                size="icon"
                className="hidden text-muted-foreground md:inline-flex"
                onClick={async () => {
                  await signOut();
                }}
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </Button>
            ) : (
              <Button asChild size="sm" className="gap-2 px-3 sm:px-4">
                <Link to="/auth?returnTo=%2F">
                  <Play className="size-4 fill-current" />
                  <span className="hidden sm:inline">Start watching</span>
                  <span className="sm:hidden">Watch</span>
                </Link>
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 pb-24 sm:px-6">
        {/* Search */}
        <section className="pt-6 sm:pt-14">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mx-auto flex w-full max-w-2xl items-center gap-2"
          >
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by title, category, year…"
                className="h-11 rounded-xl bg-card/80 pl-10 pr-10 text-base"
                aria-label="Search movies"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
            {/* The dice button in the header covers phones, so this big
                companion only shows from sm up. */}
            <Button
              size="lg"
              className="glow-accent hidden h-11 rounded-xl px-5 sm:inline-flex"
              onClick={surprise}
              aria-label="Surprise me"
            >
              <Dices className="size-4" />
            </Button>
          </motion.div>
        </section>

        {/* Top banner: leaderboard on desktop, 320×50 on phones. */}
        <section className="mt-6 flex justify-center">
          <AdBanner {...AD_BANNERS.leaderboard} className="hidden sm:block" />
          <AdBanner {...AD_BANNERS.mobile} className="sm:hidden" />
        </section>

        {/* Category sections — chips come from the embed catalog's genres. */}
        <section className="mt-6 sm:mt-8">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0">
            <button
              type="button"
              onClick={() => clearGenre()}
              className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
                genre === null
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/70 bg-card/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              }`}
            >
              All categories
            </button>
            {embedCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => selectGenre(cat)}
                className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
                  genre?.id === cat.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/70 bg-card/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </section>

        {/* Catalog */}
        {/* Providers band — streaming channels; picking one loads its movies. */}
        <section id="providers" className="scroll-mt-24 pt-10">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-2xl font-bold tracking-tight text-primary sm:text-3xl">
                Providers
              </h2>
              <span aria-hidden className="text-muted-foreground/50">
                |
              </span>
              <button
                type="button"
                onClick={() => setRowExpanded((v) => !v)}
                className="text-sm font-semibold text-primary transition-colors hover:text-primary/80"
              >
                View All
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => scrollRow(-1)}
                aria-label="Scroll providers left"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => scrollRow(1)}
                aria-label="Scroll providers right"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>

          <div
            ref={rowRef}
            className={
              rowExpanded
                ? "flex flex-wrap gap-3"
                : "flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            }
          >
            {providers.length === 0
              ? Array.from({ length: 10 }).map((_, i) => (
                  <Skeleton key={i} className="size-24 shrink-0 rounded-xl" />
                ))
              : providers.map((p) => {
                  const active = selectedProvider?.id === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      title={p.name}
                      aria-pressed={active}
                      onClick={() => selectProvider(p)}
                      className={`group relative size-24 shrink-0 overflow-hidden rounded-xl border transition-all ${
                        active
                          ? "border-primary ring-2 ring-primary/60"
                          : "border-border/60 hover:border-foreground/40 hover:shadow-lg"
                      }`}
                    >
                      {/* Blown-up logo as the tile backdrop, like the reference band. */}
                      <img
                        src={p.logoUrl}
                        alt=""
                        aria-hidden
                        className="absolute inset-0 size-full scale-150 opacity-40 blur-xl"
                      />
                      <div className="absolute inset-0 bg-gradient-to-br from-black/20 via-transparent to-black/70" />
                      <img
                        src={p.logoUrl}
                        alt={p.name}
                        loading="lazy"
                        className="relative size-full object-contain p-4 transition-transform group-hover:scale-110"
                      />
                    </button>
                  );
                })}
          </div>

          <div className="mb-6 mt-10 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                {inResultsMode
                  ? "Search results"
                  : genre
                    ? `${genre.name} Movies`
                    : selectedProvider
                      ? `${selectedProvider.name} Movies`
                      : "All Movies"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {inResultsMode
                  ? `${catalog.length} ${catalog.length === 1 ? "movie" : "movies"} found for “${trimmedQuery}”`
                  : genre
                    ? `Browsing the ${genre.name} collection${
                        selectedProvider ? ` on ${selectedProvider.name}` : ""
                      } — pick a poster and press play.`
                    : selectedProvider
                      ? `Streaming on ${selectedProvider.name} — pick a poster and press play.`
                      : "Fresh from the full IMDB & TMDB catalog — updated weekly. Pick a poster and press play."}
              </p>
            </div>
          </div>

          {inResultsMode ? (
            !movies ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {Array.from({ length: 16 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
                ))}
              </div>
            ) : catalog.length === 0 && trimmedQuery.length >= 2 && (externalLoading || !external || external.q !== trimmedQuery) ? (
              /* Searching or waiting for external results for current query —
                 avoid flashing "nothing matched" during debounce/fetch. */
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
                ))}
              </div>
            ) : catalog.length === 0 ? (
              <Card className="border-dashed border-border/70 bg-card/50">
                <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                  <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Film className="size-6" />
                  </span>
                  <p className="font-display text-lg font-semibold">
                    {trimmedQuery ? "Nothing matched" : "No movies yet"}
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {trimmedQuery
                      ? "Try fewer words, a different spelling, or clear the filters."
                      : "The catalog is empty — check back soon."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {localResults.map((m: any, i: any) => (
                  <MovieCard key={m._id} movie={m} index={i} />
                ))}
                {/* External hits sit in the same grid, styled identically, so a
                    title that isn't in our library still looks like a normal result. */}
                {externalResults.map((h, i) => (
                  <VidSrcResultCard
                    key={h.imdbId}
                    hit={h}
                    index={localResults.length + i}
                    onPlay={playExternal}
                  />
                ))}
              </div>
            )
          ) : (
            <>
              <div className="flex items-start gap-4">
                {/* Left banner rail — grows with the catalog on Load More. */}
                <AdRail
                  count={Math.max(3, Math.ceil(tmdbItems.length / 8))}
                  className="hidden lg:flex"
                />
                <div className="min-w-0 flex-1">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                    {tmdbItems.map((item, i) => (
                      <VidSrcResultCard
                        key={`${item.kind}-${item.tmdbId}`}
                        hit={tmdbToHit(item)}
                        index={i % 10}
                        onPlay={() => playTmdb(item)}
                      />
                    ))}
                    {/* Skeletons for the first batch, or a light tail while loading more. */}
                    {tmdbLoading &&
                      Array.from({ length: tmdbItems.length === 0 ? 12 : 6 }).map((_, i) => (
                        <Skeleton key={`sk-${i}`} className="aspect-[2/3] rounded-xl" />
                      ))}
                  </div>

                  {tmdbError && tmdbItems.length === 0 && (
                    <p className="mt-4 text-sm text-destructive">{tmdbError}</p>
                  )}

                  {tmdbMore && (
                    <div className="mt-8 flex justify-center">
                      <Button
                        variant="outline"
                        size="lg"
                        className="gap-2"
                        disabled={tmdbLoading}
                        onClick={() =>
                          void loadTmdb(tmdbBatch + 1, selectedProvider?.id ?? null, genre?.id ?? null)
                        }
                      >
                        {tmdbLoading ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Film className="size-4" />
                        )}
                        {tmdbLoading ? "Loading…" : "Load More"}
                      </Button>
                    </div>
                  )}
                </div>
                {/* Right banner rail — mirrors the left, grows with Load More. */}
                <AdRail
                  count={Math.max(3, Math.ceil(tmdbItems.length / 8))}
                  className="hidden lg:flex"
                />
              </div>
            </>
          )}
        </section>

        {/* Mid-content ad row — 300×250 rectangle, PR container unit, half-page. */}
        <section className="mt-10 flex flex-wrap items-center justify-center gap-6">
          <AdBanner {...AD_BANNERS.square} />
          <AdContainer />
          <div className="hidden sm:block">
            <AdBanner {...AD_BANNERS.halfpage} />
          </div>
        </section>

        {/* Quick links row */}
        <section className="mt-10 grid gap-4 sm:mt-14 sm:grid-cols-3">
          <Card className="card-lift border-border/60 bg-card/70">
            <CardContent className="flex flex-col gap-2 p-5">
              <Tv className="size-5 text-primary" />
              <p className="font-display font-semibold">Schedule a screening</p>
              <p className="text-sm text-muted-foreground">
                Pick a time, invite the team, and watch together.
              </p>
              <Button asChild variant="ghost" size="sm" className="mt-1 self-start px-0 text-primary hover:text-primary">
                <Link to={isAuthenticated ? "/dashboard" : "/auth?returnTo=%2Fdashboard"}>
                  Open your library →
                </Link>
              </Button>
            </CardContent>
          </Card>
          <Card className="card-lift border-border/60 bg-card/70">
            <CardContent className="flex flex-col gap-2 p-5">
              <ShieldCheck className="size-5 text-primary" />
              <p className="font-display font-semibold">Curated by admins</p>
              <p className="text-sm text-muted-foreground">
                Only admins manage the catalog, so every title is vetted and
                ready to watch.
              </p>
            </CardContent>
          </Card>
          <Card className="card-lift border-border/60 bg-card/70">
            <CardContent className="flex flex-col gap-2 p-5">
              <Badge className="size-5 rounded-md bg-primary/12 p-0.5 text-primary" variant="outline">
                ★
              </Badge>
              <p className="font-display font-semibold">Upgrade the crew</p>
              <p className="text-sm text-muted-foreground">
                Support the catalog and unlock the premiere plan.
              </p>
              <Button asChild variant="ghost" size="sm" className="mt-1 self-start px-0 text-primary hover:text-primary">
                <Link to={isAuthenticated ? "/checkout" : "/auth?returnTo=%2Fcheckout"}>
                  See plans →
                </Link>
              </Button>
            </CardContent>
          </Card>
        </section>

        {/* Footer banner (468×60). */}
        <section className="mt-12 flex justify-center">
          <AdBanner {...AD_BANNERS.banner} />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/60 py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
          <Logo className="scale-90" />
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} FilmFlix. Stream responsibly.
          </p>
        </div>
        <p className="mx-auto mt-4 w-full max-w-7xl px-4 text-center text-[11px] text-muted-foreground/70 sm:px-6">
          No movies are hosted on our server — FilmFlix is a shared catalog for
          our internal team.
        </p>
      </footer>


    </div>
  );
}
