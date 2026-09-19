import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import PlayerStage from "@/components/PlayerStage";
import ThemeToggle from "@/components/ThemeToggle";
import { useMiniPlayer } from "@/components/mini-player-context";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CalendarPlus,
  Loader2,
  MessageSquare,
  Play,
  Send,
  Star,
  Trash2,
  Calendar,
  ListVideo,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

function toLocalInputValue(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MovieDetail() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated, user } = useAuth();
  const navigate = useNavigate();
  const { movie: miniMovie, isActive: miniActive, start } = useMiniPlayer();
  const movie = useQuery(api.movies.get, {
    id: id as Id<"movies">,
  });

  const comments = useQuery(
    api.comments.listByMovie,
    movie ? { movieId: movie._id } : "skip",
  );
  const addComment = useMutation(api.comments.add);
  const removeComment = useMutation(api.comments.remove);

  const scheduleScreening = useMutation(api.screenings.schedule);
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [isScheduling, setIsScheduling] = useState(false);

  const [commentText, setCommentText] = useState("");
  const [isPosting, setIsPosting] = useState(false);

  /* Register this movie with the persistent player as soon as it loads:
     - fresh visit → poster overlay (no autoplay)
     - returning from miniplayer → playback continues seamlessly */
  useEffect(() => {
    if (!movie) return;
    if (miniActive && miniMovie?.movieId === movie._id) return; // already playing
    start(
      {
        movieId: movie._id,
        title: movie.title,
        videoUrl: movie.videoUrl ?? "",
        posterUrl: movie.posterUrl,
        backdropUrl: movie.backdropUrl,
      },
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie?._id]);

  const handleSchedule = async () => {
    if (!movie) return;
    const ts = new Date(when).getTime();
    if (!when || Number.isNaN(ts)) {
      toast.error("Pick a date and time first");
      return;
    }
    setIsScheduling(true);
    try {
      await scheduleScreening({
        movieId: movie._id,
        scheduledFor: ts,
        note: note || undefined,
      });
      toast.success("Screening scheduled — see it in your dashboard");
      setWhen("");
      setNote("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to schedule");
    } finally {
      setIsScheduling(false);
    }
  };

  const handlePostComment = async () => {
    if (!movie) return;
    if (!isAuthenticated) {
      navigate(`/auth?returnTo=${encodeURIComponent(`/movie/${movie._id}`)}`);
      return;
    }
    if (!commentText.trim()) return;
    setIsPosting(true);
    try {
      await addComment({ movieId: movie._id, text: commentText });
      setCommentText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to comment");
    } finally {
      setIsPosting(false);
    }
  };

  const defaultWhen = toLocalInputValue(Date.now() + 24 * 60 * 60 * 1000);

  /* Playlist: main video (if any) first, then the admin-ordered episodes. */
  const playlist = movie
    ? [
        ...(movie.videoUrl
          ? [
              {
                key: "main",
                title: movie.title,
                videoUrl: movie.videoUrl,
                durationSec: undefined as number | undefined,
              },
            ]
          : []),
        ...(movie.episodes ?? []).map((e, i) => ({
          key: `ep-${i}`,
          title: e.title,
          videoUrl: e.videoUrl,
          durationSec: e.durationSec,
        })),
      ]
    : [];

  const nowPlayingUrl = miniMovie?.videoUrl;
  const playItem = (item: (typeof playlist)[number]) => {
    if (!movie) return;
    start(
      {
        movieId: movie._id,
        title: item.title,
        videoUrl: item.videoUrl,
        posterUrl: movie.posterUrl,
        backdropUrl: movie.backdropUrl,
      },
      true,
    );
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-2 px-3 sm:px-6">
          <Link to="/" aria-label="FilmFlix home" className="shrink-0">
            <Logo />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link to="/">
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">Back to catalog</span>
                <span className="sm:hidden">Back</span>
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-3 pb-24 pt-4 sm:px-6 sm:pt-8">
        {!movie ? (
          <div className="space-y-6">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
        ) : (
          <div className="space-y-10">
            {/* Persistent player stage */}
            <PlayerStage
              movieId={movie._id}
              videoUrl={movie.videoUrl ?? ""}
              title={movie.title}
              posterUrl={movie.posterUrl}
              backdropUrl={movie.backdropUrl}
            />

            {/* Episode / parts playlist */}
            {playlist.length > 1 && (
              <section aria-label="Episodes">
                <h2 className="font-display flex items-center gap-2 text-lg font-bold tracking-tight">
                  <ListVideo className="size-5 text-primary" />
                  More episodes
                  <span className="text-sm font-medium text-muted-foreground">
                    ({playlist.length})
                  </span>
                </h2>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {playlist.map((item, i) => {
                    const isPlaying = nowPlayingUrl === item.videoUrl;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => playItem(item)}
                        className={`flex items-center gap-3 rounded-xl border p-2.5 text-left transition-colors ${
                          isPlaying
                            ? "border-primary/60 bg-primary/10"
                            : "border-border/50 bg-card/60 hover:border-foreground/25 hover:bg-card"
                        }`}
                      >
                        <span
                          className={`flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                            isPlaying
                              ? "bg-primary text-primary-foreground"
                              : "bg-primary/12 text-primary"
                          }`}
                        >
                          {isPlaying ? (
                            <Play className="size-4 fill-current" />
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {item.title}
                          </span>
                          {item.durationSec != null && (
                            <span className="text-xs text-muted-foreground">
                              {Math.floor(item.durationSec / 60)}m{" "}
                              {item.durationSec % 60}s
                            </span>
                          )}
                        </span>
                        {isPlaying && (
                          <span className="shrink-0 text-xs font-semibold text-primary">
                            Now playing
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Meta */}
            <div className="grid gap-8 lg:grid-cols-[1fr_280px] lg:gap-10">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  {movie.kind === "series" && (
                    <Badge className="border-primary/40 bg-primary/15 text-primary" variant="outline">
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

                {/* Schedule a screening */}
                <Card className="mt-8 border-border/60 bg-card/70">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <CalendarPlus className="size-4 text-primary" />
                      Schedule a team screening
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isAuthenticated ? (
                      <div className="space-y-3">
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            type="datetime-local"
                            value={when || defaultWhen}
                            min={toLocalInputValue(Date.now())}
                            onChange={(e) => setWhen(e.target.value)}
                            className="sm:max-w-xs"
                            aria-label="Screening date and time"
                          />
                          <Input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Note (optional) — e.g. “room B, snacks on me”"
                            className="min-w-0 flex-1"
                          />
                        </div>
                        <Button
                          onClick={handleSchedule}
                          disabled={isScheduling}
                          className="glow-accent gap-2"
                        >
                          {isScheduling && <Loader2 className="size-4 animate-spin" />}
                          Book this time
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        <Link
                          to={`/auth?returnTo=${encodeURIComponent(`/movie/${movie._id}`)}`}
                          className="text-primary underline underline-offset-4 hover:text-primary/85"
                        >
                          Sign in
                        </Link>{" "}
                        to schedule a screening and join the discussion.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Poster card */}
              <aside className="hidden lg:block">
                <div className="sticky top-20 overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_16px_48px_-20px_rgba(0,0,0,0.8)]">
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

            {/* Team discussion */}
            <section>
              <h2 className="font-display flex items-center gap-2 text-xl font-bold tracking-tight">
                <MessageSquare className="size-5 text-primary" />
                Team discussion
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Notes, reactions, and timecodes from the crew.
              </p>

              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Input
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handlePostComment();
                    }
                  }}
                  placeholder={
                    isAuthenticated
                      ? "Share a thought about this movie…"
                      : "Sign in to join the discussion"
                  }
                  disabled={!isAuthenticated}
                  className="min-w-0 flex-1"
                />
                <Button
                  onClick={handlePostComment}
                  disabled={!isAuthenticated || isPosting || !commentText.trim()}
                  className="gap-2 sm:w-auto"
                >
                  {isPosting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Post
                </Button>
              </div>

              <div className="mt-6 space-y-3">
                {comments === undefined ? (
                  <>
                    <Skeleton className="h-14 w-full rounded-xl" />
                    <Skeleton className="h-14 w-full rounded-xl" />
                  </>
                ) : comments.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                    No comments yet — start the conversation.
                  </p>
                ) : (
                  comments.map((c) => (
                    <div
                      key={c._id}
                      className="flex items-start gap-3 rounded-xl border border-border/50 bg-card/60 p-4"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                        {(c.authorName ?? "M").slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold">
                            {c.authorName ?? "Team member"}
                          </p>
                          <span className="text-xs text-muted-foreground">
                            {new Date(c.createdAt).toLocaleString()}
                          </span>
                          {c.userId === user?._id && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="ml-auto size-7 text-muted-foreground hover:text-destructive"
                              aria-label="Delete comment"
                              onClick={async () => {
                                try {
                                  await removeComment({ id: c._id });
                                } catch (err) {
                                  toast.error(
                                    err instanceof Error ? err.message : "Failed",
                                  );
                                }
                              }}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                          {c.text}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
