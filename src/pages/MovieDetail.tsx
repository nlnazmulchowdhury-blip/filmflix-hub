import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import VideoPlayer from "@/components/VideoPlayer";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Calendar, Star, Tag } from "lucide-react";
import { Link, useParams } from "react-router";
import { useQuery } from "convex/react";

export default function MovieDetail() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated } = useAuth();
  const movie = useQuery(api.movies.get, {
    id: id as Id<"movies">,
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/10 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="FilmFlix home">
            <Logo />
          </Link>
          <Button asChild variant="outline" size="sm" className="gap-2">
            <Link to="/">
              <ArrowLeft className="size-4" />
              Back to catalog
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-8 sm:px-6">
        {!movie ? (
          <div className="space-y-6">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
        ) : (
          <div className="space-y-8">
            {/* Player */}
            <VideoPlayer
              movie={movie}
              videoUrl={movie.videoUrl}
              title={movie.title}
            />

            {/* Meta */}
            <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  {movie.kind === "series" && (
                    <Badge className="bg-primary/15 text-primary border-primary/40" variant="outline">
                      Series
                    </Badge>
                  )}
                  {movie.year != null && (
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Calendar className="size-3.5" />
                      {movie.year}
                    </span>
                  )}
                  {movie.rating != null && (
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-300">
                      <Star className="size-3.5 fill-current" />
                      {movie.rating.toFixed(1)}
                    </span>
                  )}
                  {movie.genre && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-secondary px-3 py-0.5 text-xs font-medium text-secondary-foreground">
                      <Tag className="size-3" />
                      {movie.genre}
                    </span>
                  )}
                </div>

                <h1 className="font-display mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
                  {movie.title}
                </h1>
                {movie.description ? (
                  <p className="mt-4 max-w-2xl leading-relaxed text-muted-foreground">
                    {movie.description}
                  </p>
                ) : (
                  <p className="mt-4 max-w-2xl text-sm italic text-muted-foreground/70">
                    No description provided yet.
                  </p>
                )}

                {isAuthenticated ? null : (
                  <div className="mt-6 rounded-xl border border-primary/30 bg-primary/8 p-4 text-sm">
                    <p className="font-medium">Want to keep watching?</p>
                    <p className="mt-1 text-muted-foreground">
                      <Link
                        to={`/auth?returnTo=${encodeURIComponent(`/movie/${movie._id}`)}`}
                        className="text-primary underline underline-offset-4 hover:text-primary/85"
                      >
                        Sign in
                      </Link>{" "}
                      to save your place across devices.
                    </p>
                  </div>
                )}
              </div>

              {/* Poster card */}
              <aside className="hidden lg:block">
                <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_16px_48px_-20px_rgba(0,0,0,0.8)]">
                  <div className="aspect-[2/3] bg-muted">
                    {movie.posterUrl ? (
                      <img
                        src={movie.posterUrl}
                        alt={movie.title}
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground/40">
                        No poster
                      </div>
                    )}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
