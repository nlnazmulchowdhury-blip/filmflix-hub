import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import MovieCard from "@/components/MovieCard";
import ThemeToggle from "@/components/ThemeToggle";
import AdBanner from "@/components/AdBanner";
import AdSideRail from "@/components/AdSideRail";
import { AD_BANNERS } from "@/lib/ad-banners";
import { api } from "@/convex/_generated/api";
import { movieCategoryNames } from "@/lib/categories";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "convex/react";
import { Dices, Film, LogOut, Menu, Play, Search, ShieldCheck, Tv, X } from "lucide-react";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
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
  // Categories created directly in the admin panel (even with zero movies).
  const tableCategories = useQuery(api.categories.listAll);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  /** Distinct display categories (Hollywood, Bengali, Anime, …): names
      created directly in the admin panel plus every section a movie belongs
      to. */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of tableCategories ?? []) set.add(c.name);
    for (const m of movies ?? []) {
      for (const c of movieCategoryNames(m)) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [tableCategories, movies]);

  const filtered = useMemo(() => {
    if (!movies) return null;
    let rows = movies;
    if (category)
      rows = rows.filter((m) => movieCategoryNames(m).includes(category));
    const raw = query.trim();
    if (raw) {
      const tokens = normalizeText(raw).split(" ").filter(Boolean);
      if (tokens.length > 0) {
        rows = rows.filter((m) => {
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
  }, [movies, category, query]);

  const catalog = filtered ?? [];

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

      {/* Ad slot: wide skyscraper — fixed side rails (auto-fit, never cut). */}
      <AdSideRail side="left" breakpoint="wide" />
      <AdSideRail side="right" breakpoint="wide" />

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
            <a href="#catalog" className={navLinkClass}>Categories</a>
            <Link
              to={isAuthenticated ? "/dashboard" : `/auth?returnTo=%2Fdashboard`}
              className={navLinkClass}
            >
              Library
            </Link>
            <Link to="/tv" className={navLinkClass}>
              TV
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
                  { label: "Categories", href: "#catalog" },
                  {
                    label: "Library",
                    to: isAuthenticated ? "/dashboard" : "/auth?returnTo=%2Fdashboard",
                  },
                  { label: "TV", to: "/tv" },
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
            <ThemeToggle />
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

        {/* Category sections */}
        {categories.length > 0 && (
          <section className="mt-6 sm:mt-8">
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0">
              <button
                type="button"
                onClick={() => setCategory(null)}
                className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
                  category === null
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/70 bg-card/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                }`}
              >
                All categories
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(category === c ? null : c)}
                  className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${
                    category === c
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border/70 bg-card/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Catalog */}
        {/* Ad slots: leaderboard (desktop) / mobile banner. */}
        <div className="mt-8 flex justify-center sm:mt-10">
          <AdBanner {...AD_BANNERS.leaderboard} className="hidden sm:block" />
          <AdBanner {...AD_BANNERS.mobile} className="sm:hidden" />
        </div>

        <section id="catalog" className="scroll-mt-24 pt-10">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                {query.trim()
                  ? "Search results"
                  : category
                    ? category
                    : "New Releases"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {query.trim()
                  ? `${catalog.length} ${catalog.length === 1 ? "movie" : "movies"} found for “${query.trim()}”`
                  : category
                    ? `Browsing the ${category} collection.`
                    : "Watch new releases for free — pick a poster and press play."}
              </p>
            </div>
          </div>

          {!movies ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {Array.from({ length: 16 }).map((_, i) => (
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
                  {query.trim() ? "Nothing matched" : "No movies yet"}
                </p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {query.trim() || category
                    ? "Try fewer words, a different spelling, or clear the filters."
                    : "The catalog is empty — check back soon."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {catalog.map((m, i) => (
                <MovieCard key={m._id} movie={m} index={i} />
              ))}
            </div>
          )}
        </section>

        {/* Ad slot: medium rectangle. */}
        <div className="mt-10 flex justify-center">
          <AdBanner {...AD_BANNERS.square} />
        </div>

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

        {/* Ad slot: full banner. */}
        <div className="mt-10 flex justify-center">
          <AdBanner {...AD_BANNERS.banner} />
        </div>
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
