import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import MovieCard from "@/components/MovieCard";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Clapperboard, Film, Play, Sparkles, Tv } from "lucide-react";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "convex/react";

export default function Landing() {
  const { user, signOut, isAuthenticated } = useAuth();
  const movies = useQuery(api.movies.list);
  const [genre, setGenre] = useState<string | null>(null);

  const genres = useMemo(() => {
    const set = new Set<string>();
    for (const m of movies ?? []) {
      const g = (m.genre ?? "").trim();
      if (g) set.add(g);
    }
    return Array.from(set).slice(0, 8);
  }, [movies]);

  const filtered = useMemo(() => {
    if (!movies) return null;
    if (!genre) return movies;
    return movies.filter((m) => (m.genre ?? "").trim() === genre);
  }, [movies, genre]);

  const featured = movies?.[0];
  const catalog = filtered ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/12 blur-[140px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[380px] w-[520px] rounded-full bg-primary/6 blur-[120px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="FilmFlix home">
            <Logo />
          </Link>
          <nav className="flex items-center gap-2">
            {isAuthenticated ? (
              <>
                <span className="mr-1 hidden text-sm text-muted-foreground sm:inline">
                  {user?.email ?? "Signed in"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={async () => {
                    await signOut();
                  }}
                >
                  Sign out
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
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 pb-24 sm:px-6">
        {/* Hero */}
        <section className="relative py-12 sm:py-16">
          <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: "easeOut" }}
            >
              <Badge variant="outline" className="mb-5 gap-1.5 border-primary/40 bg-primary/10 text-primary">
                <Sparkles className="size-3.5" />
                Movie streaming, made simple
              </Badge>
              <h1 className="font-display text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
                Your movies. <span className="text-gradient">One beautiful</span> place.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                Browse the FilmFlix catalog, pick a poster, and press play — a
                crisp custom player with full volume control, built for
                distraction-free viewing.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="glow-accent gap-2 font-semibold">
                  <a href="#catalog">
                    <Play className="size-4 fill-current" />
                    Browse catalog
                  </a>
                </Button>
                {featured && (
                  <Button asChild size="lg" variant="outline" className="gap-2">
                    <Link to={`/movie/${featured._id}`}>
                      <Clapperboard className="size-4" />
                      Watch featured
                    </Link>
                  </Button>
                )}
              </div>

              <div className="mt-10 flex items-center gap-6 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Film className="size-4 text-primary" />
                  {movies ? `${movies.length} titles` : "Loading…"}
                </span>
                <span className="inline-flex items-center gap-2">
                  <Tv className="size-4 text-primary" />
                  Custom player
                </span>
              </div>
            </motion.div>

            {/* Featured poster preview */}
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.55, delay: 0.12, ease: "easeOut" }}
              className="relative mx-auto w-full max-w-sm"
            >
              {featured ? (
                <Link to={`/movie/${featured._id}`} className="group block">
                  <Card className="overflow-hidden rounded-2xl border-border/60 bg-card p-0 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] transition-transform duration-300 group-hover:scale-[1.02]">
                    <div className="relative aspect-[2/3] bg-muted">
                      {featured.posterUrl ? (
                        <img
                          src={featured.posterUrl}
                          alt={featured.title}
                          className="size-full object-cover"
                        />
                      ) : (
                        <div className="flex size-full items-center justify-center">
                          <Film className="size-12 text-muted-foreground/40" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                      <div className="absolute bottom-4 left-4 right-4">
                        <p className="font-display text-lg font-bold text-white">Featured</p>
                        <p className="line-clamp-1 text-sm text-white/75">{featured.title}</p>
                      </div>
                    </div>
                  </Card>
                </Link>
              ) : (
                <Skeleton className="aspect-[2/3] w-full rounded-2xl" />
              )}
            </motion.div>
          </div>
        </section>

        {/* Catalog */}
        <section id="catalog" className="scroll-mt-24 pt-6">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                The catalog
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Click a poster to open details and start streaming.
              </p>
            </div>
            {genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setGenre(null)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                    genre === null
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border/70 text-muted-foreground hover:border-foreground/25 hover:text-foreground"
                  }`}
                >
                  All
                </button>
                {genres.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGenre(g)}
                    className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                      genre === g
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "border-border/70 text-muted-foreground hover:border-foreground/25 hover:text-foreground"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!movies ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
              ))}
            </div>
          ) : catalog.length === 0 ? (
            <Card className="border-dashed border-border/70 bg-card/50">
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Film className="size-6" />
                </span>
                <p className="font-display text-lg font-semibold">No movies yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  The catalog is empty. An admin can add movies from the admin
                  panel and they will appear here instantly.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {catalog.map((m, i) => (
                <MovieCard key={m._id} movie={m} index={i} />
              ))}
            </div>
          )}
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
      </footer>
    </div>
  );
}
