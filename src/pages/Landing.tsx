import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import MovieCard from "@/components/MovieCard";
import VidSrcResultCard, {
  type VidSrcHit,
} from "@/components/VidSrcResultCard";
import { vidsrcEmbedUrl } from "@/lib/vidsrc";
import { rememberExternalHint } from "@/lib/vaplayer";
import {
  browseTmdb,
  listCategories,
  listProviders,
  type CategoryInfo,
  type ProviderInfo,
  type TmdbItem,
} from "@/lib/tmdb";
import ThemeToggle from "@/components/ThemeToggle";
import AdEdgeRail from "@/components/AdEdgeRail";
import AdVideoBanner from "@/components/AdVideoBanner";
import { api } from "@/convex/_generated/api";
import { movieCategoryNames } from "@/lib/categories";
import { useAuth } from "@/hooks/use-auth";
import { useAction, useQuery } from "convex/react";
import {
  Dices,
  Film,
  LogOut,
  Menu,
  Play,
  Search,
  ShieldCheck,
  Tv,
  X,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { motion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
    [
      m.title,
      m.description,
      ...movieCategoryNames(m),
      m.year?.toString(),
      m.kind,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/** Chips shown on phones before "More categories" — keeps the row to two lines. */
const MOBILE_CATEGORY_CHIPS = 4;

/** A typeahead row: a title (or category) plus the small label beside it. */
type Suggestion = { title: string; note?: string };

/** Prefix matches first, then substring matches, shortest title first. */
function rankSuggestions(
  term: string,
  pool: Suggestion[],
  cap = 8,
): Suggestion[] {
  const needle = normalizeText(term);
  if (!needle) return [];
  const starts: Suggestion[] = [];
  const contains: Suggestion[] = [];
  for (const s of pool) {
    const hay = normalizeText(s.title);
    if (!hay) continue;
    if (hay.startsWith(needle)) starts.push(s);
    else if (hay.includes(needle)) contains.push(s);
  }
  const byLength = (a: Suggestion, b: Suggestion) =>
    a.title.length - b.title.length;
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const s of [...starts.sort(byLength), ...contains.sort(byLength)]) {
    const key = normalizeText(s.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Bold the part of the suggestion the user has typed, the way YouTube does. */
function highlightMatch(title: string, term: string) {
  const idx = normalizeText(title).indexOf(normalizeText(term));
  if (idx < 0 || !term.trim()) return title;
  const end = idx + term.trim().length;
  return (
    <>
      {title.slice(0, idx)}
      <span className="font-semibold text-foreground">
        {title.slice(idx, end)}
      </span>
      {title.slice(end)}
    </>
  );
}

export default function Landing() {
  const { signOut, isAuthenticated } = useAuth();
  const movies = useQuery(api.movies.list);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  /* Typing must not search: every keystroke used to fire another catalog
     lookup. The grid only follows the term the user submitted with Enter or
     the Search button. */
  const [searched, setSearched] = useState("");
  const runSearch = () => setSearched(query.trim());
  const clearSearch = () => {
    setQuery("");
    setSearched("");
    setSuggestOpen(false);
  };

  /* A catalog fetch that errors never resolves, and convex-react reports that
     the same way as "still loading". After a grace period stop showing
     skeletons so the search box still returns external hits. */
  const [catalogStalled, setCatalogStalled] = useState(false);
  useEffect(() => {
    if (movies) {
      setCatalogStalled(false);
      return;
    }
    const t = setTimeout(() => setCatalogStalled(true), 8000);
    return () => clearTimeout(t);
  }, [movies]);

  /* -------- Category chips (auto-populated from the embed catalog) ------ */
  /* The embed source's own movie genres, so every chip has real movies
     behind it; picking one reloads the browse grid filtered to that genre. */
  const [embedCategories, setEmbedCategories] = useState<CategoryInfo[]>([]);
  const [genre, setGenre] = useState<CategoryInfo | null>(null);
  /* Phones show a handful of chips plus "More categories"; the row used to be
     a horizontal scroller, which read as a chip sliced in half at the edge. */
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  /* -------- External VidSrc search (titles beyond the local catalog) ---- */
  const searchExternal = useAction(api.vidsrc.search);
  /* Hits are stored with the query they were resolved for, so a slow response
     for a previous query never shows up under the current one. */
  const [external, setExternal] = useState<{
    q: string;
    hits: VidSrcHit[];
  } | null>(null);
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
  const [selectedProvider, setSelectedProvider] = useState<ProviderInfo | null>(
    null,
  );
  const [rowExpanded, setRowExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  /* -------- Typeahead suggestions (YouTube-style) ---------------------- */
  /* Titles we already have — hosted catalog, the loaded browse batch, the
     category chips — rank instantly, then the keyless title search fills in
     near matches the catalog doesn't hold. One lookup per typing pause, never
     per keystroke, and none of it moves the grid: picking a row is the same as
     typing that title and pressing Enter. */
  const typed = query.trim();
  const [remoteSuggests, setRemoteSuggests] = useState<Suggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeSuggest, setActiveSuggest] = useState(-1);

  const knownSuggests = useMemo(
    () =>
      rankSuggestions(typed, [
        ...(movies ?? []).map((m: any) => ({
          title: m.title,
          note: [m.year, m.kind === "series" ? "Series" : null]
            .filter(Boolean)
            .join(" · "),
        })),
        ...tmdbItems.map((t) => ({
          title: t.title,
          note: t.year ? String(t.year) : undefined,
        })),
        ...embedCategories.map((c) => ({ title: c.name, note: "Category" })),
      ]),
    [typed, movies, tmdbItems, embedCategories],
  );

  useEffect(() => {
    /* `typed === searched` means the box holds a term that was already
       submitted, so there is nothing being typed. */
    if (typed.length < 2 || typed === searched) {
      setRemoteSuggests([]);
      setSuggestOpen(false);
      return;
    }
    setSuggestOpen(true);
    setActiveSuggest(-1);
    let cancelled = false;
    const t = setTimeout(() => {
      searchExternal({ q: typed })
        .then((hits) => {
          if (cancelled) return;
          setRemoteSuggests(
            (hits ?? []).slice(0, 8).map((h: any) => ({
              title: h.title,
              note: h.year
                ? `${h.year}${h.kind === "series" ? " · Series" : ""}`
                : undefined,
            })),
          );
        })
        .catch(() => {
          if (!cancelled) setRemoteSuggests([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [typed, searched, searchExternal]);

  const suggestions = useMemo(() => {
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    for (const s of [...knownSuggests, ...remoteSuggests]) {
      const key = normalizeText(s.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 8) break;
    }
    return out;
  }, [knownSuggests, remoteSuggests]);

  const applySuggestion = (title: string) => {
    setQuery(title);
    setSearched(title);
    setSuggestOpen(false);
    setActiveSuggest(-1);
  };

  const loadTmdb = useCallback(
    async (
      batch: number,
      providerId: string | null,
      genreId: number | null,
    ) => {
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
          err instanceof Error
            ? err.message
            : "Could not load movies right now",
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
    clearSearch();
    setSelectedProvider((cur) => {
      const next = cur?.id === p.id ? null : p;
      setTmdbItems([]);
      setTmdbMore(true);
      return next;
    });
  };

  /** Clicking a category chip filters the grid to that genre; again clears. */
  const selectGenre = (cat: CategoryInfo) => {
    clearSearch();
    setTmdbItems([]);
    setTmdbMore(true);
    setGenre((cur) => (cur?.id === cat.id ? null : cat));
  };

  const clearGenre = () => {
    clearSearch();
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
      const state = {
        external: "vaplayer",
        tmdbId: item.tmdbId,
        kind: item.kind,
        title: item.title,
        posterUrl: item.posterUrl ?? undefined,
        backdropUrl: item.backdropUrl ?? undefined,
        overview: item.overview,
        embedUrl: item.embedUrl,
      };
      rememberExternalHint(item.tmdbId, state);
      navigate(`/movie/vaplayer-${item.tmdbId}`, { state });
      return;
    }
    try {
      const hits = await searchExternal({ q: item.title });
      const hit = hits?.[0];
      if (hit) {
        const state = {
          external: true,
          imdbId: hit.imdbId,
          kind: hit.kind,
          title: hit.title,
          posterUrl: hit.posterUrl,
        };
        rememberExternalHint(hit.imdbId, state);
        navigate(`/movie/vidsrc-${hit.imdbId}`, { state });
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

  const trimmedQuery = searched;
  /* Only surface external hits that match the submitted term. */
  const externalHits =
    external && external.q === trimmedQuery ? external.hits : null;

  /* Resolve the submitted title against IMDb (server-side, keyless) so titles
     outside the catalog still show up and play via Server 1. Runs on submit
     only — never while the box is still being typed in. */
  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setExternal(null);
      setExternalLoading(false);
      return;
    }
    let cancelled = false;
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
    return () => {
      cancelled = true;
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

  /** Local catalog rows matching the submitted query (title, description, …). */
  const filtered = useMemo(() => {
    if (!movies) return null;
    let rows = movies;
    const raw = trimmedQuery;
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
  }, [movies, trimmedQuery]);

  const localResults = filtered ?? [];
  /* While searching, external VidSrc hits are merged into the same grid as
     ordinary results so a title that isn't in our library still shows up (and
     plays) exactly like a catalog entry — the viewer can't tell the difference. */
  const externalResults = trimmedQuery.length >= 2 ? (externalHits ?? []) : [];
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
    <div className="relative min-h-screen bg-background text-foreground">
      {/* Banner rails in the outer page margins (beside the content column). */}
      <AdEdgeRail side="left" />
      <AdEdgeRail side="right" />

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
            <Link to="/" className={navLinkClass}>
              Home
            </Link>
            <button type="button" onClick={surprise} className={navLinkClass}>
              Random
            </button>
            <a href="#providers" className={navLinkClass}>
              Providers
            </a>
            <Link
              to={
                isAuthenticated ? "/dashboard" : `/auth?returnTo=%2Fdashboard`
              }
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
          <div className="flex items-center gap-0.5 sm:gap-2">
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
                    {
                      label: "Random",
                      action: () => {
                        setMenuOpen(false);
                        surprise();
                      },
                    },
                    { label: "Providers", href: "#providers" },
                    {
                      label: "Library",
                      to: isAuthenticated
                        ? "/dashboard"
                        : "/auth?returnTo=%2Fdashboard",
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
          <motion.form
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mx-auto flex w-full max-w-2xl items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (!suggestOpen || suggestions.length === 0) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveSuggest((i) =>
                      Math.min(i + 1, suggestions.length - 1),
                    );
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveSuggest((i) => Math.max(i - 1, -1));
                  } else if (e.key === "Escape") {
                    setSuggestOpen(false);
                  } else if (e.key === "Enter" && activeSuggest >= 0) {
                    e.preventDefault();
                    applySuggestion(suggestions[activeSuggest].title);
                  }
                }}
                onBlur={() => setSuggestOpen(false)}
                placeholder="Search by title, category, year…"
                className="h-11 rounded-xl bg-card/80 pl-10 pr-10 text-base"
                aria-label="Search movies"
                role="combobox"
                aria-expanded={suggestOpen && suggestions.length > 0}
                aria-controls="search-suggestions"
                autoComplete="off"
              />
              {query && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              )}
              {suggestOpen && suggestions.length > 0 && (
                <ul
                  id="search-suggestions"
                  role="listbox"
                  aria-label="Search suggestions"
                  className="absolute inset-x-0 top-[calc(100%+6px)] z-40 max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-background/95 py-1 shadow-xl backdrop-blur"
                >
                  {suggestions.map((s, i) => (
                    <li
                      key={`${s.title}-${i}`}
                      role="option"
                      aria-selected={i === activeSuggest}
                    >
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveSuggest(i)}
                        onClick={() => applySuggestion(s.title)}
                        className={`flex w-full items-baseline gap-2.5 px-3.5 py-2 text-left text-sm transition-colors ${
                          i === activeSuggest
                            ? "bg-secondary text-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        <Search className="size-3.5 shrink-0 translate-y-0.5" />
                        <span className="min-w-0 flex-1 truncate">
                          {highlightMatch(s.title, typed)}
                        </span>
                        {s.note && (
                          <span className="shrink-0 text-xs opacity-70">
                            {s.note}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* Results only move on submit (Enter or this button), so typing a
                title no longer fires a lookup per word. */}
            <Button
              type="submit"
              size="lg"
              className="glow-accent h-11 shrink-0 rounded-xl px-4"
              aria-label="Search"
            >
              <Search className="size-4" />
              <span className="hidden sm:inline">Search</span>
            </Button>
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
          </motion.form>
        </section>

        {/* Category sections — chips come from the embed catalog's genres. */}
        <section className="mt-6 sm:mt-8">
          <div className="flex flex-wrap items-center gap-2 pb-1 sm:justify-center">
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
            {embedCategories.map((cat, i) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => selectGenre(cat)}
                className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
                  /* Beyond the first few, chips stay hidden on phones until
                     "More categories" — except the active one, which must never
                     disappear while it is filtering the grid. */
                  i >= MOBILE_CATEGORY_CHIPS &&
                  !categoriesOpen &&
                  genre?.id !== cat.id
                    ? "hidden sm:inline-flex"
                    : ""
                } ${
                  genre?.id === cat.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/70 bg-card/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                }`}
              >
                {cat.name}
              </button>
            ))}
            {embedCategories.length > MOBILE_CATEGORY_CHIPS && (
              <button
                type="button"
                onClick={() => setCategoriesOpen((v) => !v)}
                className="shrink-0 rounded-full border border-primary/50 bg-primary/10 px-4 py-1.5 text-sm font-semibold text-primary sm:hidden"
              >
                {categoriesOpen ? "Show less" : "More categories"}
              </button>
            )}
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
              {(inResultsMode || genre || selectedProvider) && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {inResultsMode
                    ? `${catalog.length} ${catalog.length === 1 ? "movie" : "movies"} found for “${trimmedQuery}”`
                    : genre
                      ? `Browsing the ${genre.name} collection${
                          selectedProvider ? ` on ${selectedProvider.name}` : ""
                        } — pick a poster and press play.`
                      : `Streaming on ${selectedProvider!.name} — pick a poster and press play.`}
                </p>
              )}
            </div>
          </div>

          {inResultsMode ? (
            !movies && !catalogStalled ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {Array.from({ length: 16 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
                ))}
              </div>
            ) : catalog.length === 0 &&
              trimmedQuery.length >= 2 &&
              (externalLoading || !external || external.q !== trimmedQuery) ? (
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
                {[
                  ...localResults.map((m: any, i: any) => (
                    <MovieCard key={m._id} movie={m} index={i} />
                  )),
                  /* External hits sit in the same grid, styled identically, so a
                     title that isn't in our library still looks like a normal result. */
                  ...externalResults.map((h, i) => (
                    <VidSrcResultCard
                      key={h.imdbId}
                      hit={h}
                      index={localResults.length + i}
                      onPlay={playExternal}
                    />
                  )),
                ]}
              </div>
            )
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
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
                  Array.from({ length: tmdbItems.length === 0 ? 12 : 6 }).map(
                    (_, i) => (
                      <Skeleton
                        key={`sk-${i}`}
                        className="aspect-[2/3] rounded-xl"
                      />
                    ),
                  )}
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
                      void loadTmdb(
                        tmdbBatch + 1,
                        selectedProvider?.id ?? null,
                        genre?.id ?? null,
                      )
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
            </>
          )}
        </section>

        {/* HilltopAds' in-page video banners (zone #7535489), played by our own
            element. One card on a phone, two side by side from `sm` up; the
            second never asks the network for an ad it cannot show. Nothing
            renders when the network has no creative. */}
        <section className="mt-10 flex flex-wrap items-start justify-center gap-6">
          <AdVideoBanner slot={0} />
          <AdVideoBanner slot={1} minWidth={640} />
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
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="mt-1 self-start px-0 text-primary hover:text-primary"
              >
                <Link
                  to={
                    isAuthenticated
                      ? "/dashboard"
                      : "/auth?returnTo=%2Fdashboard"
                  }
                >
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
              <Badge
                className="size-5 rounded-md bg-primary/12 p-0.5 text-primary"
                variant="outline"
              >
                ★
              </Badge>
              <p className="font-display font-semibold">Upgrade the crew</p>
              <p className="text-sm text-muted-foreground">
                Support the catalog and unlock the premiere plan.
              </p>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="mt-1 self-start px-0 text-primary hover:text-primary"
              >
                <Link
                  to={
                    isAuthenticated ? "/checkout" : "/auth?returnTo=%2Fcheckout"
                  }
                >
                  See plans →
                </Link>
              </Button>
            </CardContent>
          </Card>
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
