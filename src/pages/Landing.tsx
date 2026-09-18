import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import MovieCard from "@/components/MovieCard";
import MovieFormDialog from "@/components/MovieFormDialog";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "convex/react";
import { Dices, Film, LogOut, Play, Search, Sparkles, Tv } from "lucide-react";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

export default function Landing() {
  const { user, signOut, isAuthenticated } = useAuth();
  const movies = useQuery(api.movies.list);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState<string | null>(null);
  const [contributeOpen, setContributeOpen] = useState(false);
  const isAdmin = user?.role === "admin";

  const genres = useMemo(() => {
    const set = new Set<string>();
    for (const m of movies ?? []) {
      const g = (m.genre ?? "").trim();
      if (g) set.add(g);
    }
    return Array.from(set).sort();
  }, [movies]);

  const filtered = useMemo(() => {
    if (!movies) return null;
    let rows = movies;
    if (genre) rows = rows.filter((m) => (m.genre ?? "").trim() === genre);
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          (m.description ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [movies, genre, query]);

  const catalog = filtered ?? [];

  const surprise = () => {
    if (!movies || movies.length === 0) return;
    const pick = movies[Math.floor(Math.random() * movies.length)];
    navigate(`/movie/${pick._id}`);
  };

  const navLinkClass =
    "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/14 blur-[140px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[380px] w-[520px] rounded-full bg-primary/8 blur-[120px]" />
        <div className="absolute bottom-[10%] left-[-12%] h-[300px] w-[400px] rounded-full bg-chart-2/10 blur-[120px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/" aria-label="FilmFlix home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-6 md:flex">
            <Link to="/" className={navLinkClass}>Home</Link>
            <button type="button" onClick={surprise} className={navLinkClass}>
              Random
            </button>
            <a href="#catalog" className={navLinkClass}>Genres</a>
            <Link
              to={isAuthenticated ? "/dashboard" : `/auth?returnTo=%2Fdashboard`}
              className={navLinkClass}
            >
              Library
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            {isAdmin ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => setContributeOpen(true)}
                >
                  <Sparkles className="size-4" />
                  <span className="hidden sm:inline">Add title</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-muted-foreground"
                  onClick={async () => {
                    await signOut();
                  }}
                  aria-label="Sign out"
                >
                  <LogOut className="size-4" />
                </Button>
              </>
            ) : (
              <Button asChild size="sm" className="gap-2">
                <Link to="/auth?returnTo=%2F">
                  <Play className="size-4 fill-current" />
                  Start watching
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 pb-24 sm:px-6">
        {/* Search */}
        <section className="pt-10 sm:pt-14">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mx-auto flex w-full max-w-2xl items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search movies…"
                className="h-11 rounded-xl bg-card/80 pl-10 text-base"
                aria-label="Search movies"
              />
            </div>
            <Button
              size="lg"
              className="glow-accent h-11 rounded-xl px-5"
              onClick={surprise}
              aria-label="Surprise me"
            >
              <Dices className="size-4" />
            </Button>
          </motion.div>
        </section>

        {/* Genre pills */}
        {genres.length > 0 && (
          <section className="mt-6">
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => setGenre(null)}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                  genre === null
                    ? "border-primary/60 bg-primary/20 text-primary"
                    : "border-border/70 bg-card/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                }`}
              >
                All
              </button>
              {genres.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGenre(genre === g ? null : g)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                    genre === g
                      ? "border-primary/60 bg-primary/20 text-primary"
                      : "border-border/70 bg-card/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Catalog */}
        <section id="catalog" className="scroll-mt-24 pt-10">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                {query.trim()
                  ? "Search results"
                  : genre
                    ? `${genre} movies`
                    : "New Releases"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {query.trim()
                  ? `Showing matches for “${query.trim()}”.`
                  : "Watch new releases for free — pick a poster and press play."}
              </p>
            </div>
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setContributeOpen(true)}
              >
                <Sparkles className="size-4" />
                Add title
              </Button>
            )}
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
                  {query.trim() || genre ? "Nothing matched" : "No movies yet"}
                </p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {query.trim() || genre
                    ? "Try a different search term or genre."
                    : "The catalog is empty. Add the first title to get the team started."}
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

        {/* Quick links row */}
        <section className="mt-14 grid gap-4 sm:grid-cols-3">
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
              <Film className="size-5 text-primary" />
              <p className="font-display font-semibold">${isAdmin ? "Grow the catalog" : "Curated by admins"}</p>
              <p className="text-sm text-muted-foreground">
                ${isAdmin
                  ? "Add new titles from here or the admin panel — you have full control."
                  : "Only admins add movies, so every title in the catalog is vetted."}
              </p>
              ${isAdmin
                ? `<Button
                variant="ghost"
                size="sm"
                className="mt-1 self-start px-0 text-primary hover:text-primary"
                onClick={() => setContributeOpen(true)}
              >
                Add a movie →
              </Button>`
                : `<Button asChild variant="ghost" size="sm" className="mt-1 self-start px-0 text-primary hover:text-primary">
                <Link to="/nazmul">Admin panel →</Link>
              </Button>`}
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

      <MovieFormDialog open={contributeOpen} onOpenChange={setContributeOpen} movie={null} />
    </div>
  );
}
