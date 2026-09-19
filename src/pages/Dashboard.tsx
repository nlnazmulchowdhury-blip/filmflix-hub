import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CalendarClock,
  Clapperboard,
  CreditCard,
  LogOut,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const screenings = useQuery(api.screenings.listMine);
  const myOrders = useQuery(api.orders.listMine);
  const contributions = useQuery(
    api.movies.listByContributor,
    user ? { userId: user._id } : "skip",
  );
  const cancelScreening = useMutation(api.screenings.cancel);

  const activePlan = myOrders?.[0]
    ? myOrders[0].plan === "premiere"
      ? "Premiere"
      : "Crew"
    : null;

  const now = Date.now();
  const sortedScreenings = screenings
    ? [...screenings].sort((a, b) => a.scheduledFor - b.scheduledFor)
    : null;
  const upcoming = sortedScreenings?.filter((s) => s.scheduledFor >= now) ?? [];
  const past = sortedScreenings?.filter((s) => s.scheduledFor < now) ?? [];

  const fmt = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link to="/" aria-label="FilmFlix home">
              <Logo />
            </Link>
            <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
              Library
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm" className="gap-2">
              <Link to="/">
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">Browse</span>
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={async () => {
                await signOut();
              }}
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl space-y-8 px-4 pb-24 pt-8 sm:px-6">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Welcome back{user?.name ? `, ${user.name}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your screenings, contributions, and plan — all in one place.
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="border-border/60 bg-card/70">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <CalendarClock className="size-3.5" /> Upcoming screenings
              </CardDescription>
              <CardTitle className="font-display text-3xl">
                {screenings === undefined ? "—" : upcoming.length}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              Times you have booked to watch with the team.
            </CardContent>
          </Card>
          <Card className="border-border/60 bg-card/70">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <Clapperboard className="size-3.5" /> Titles contributed
              </CardDescription>
              <CardTitle className="font-display text-3xl">
                {contributions === undefined ? "—" : contributions.length}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              Movies you have added to the shared catalog.
            </CardContent>
          </Card>
          <Card className="border-primary/30 bg-card/70">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <CreditCard className="size-3.5" /> Current plan
              </CardDescription>
              <CardTitle className="font-display text-3xl">
                {myOrders === undefined ? "—" : (activePlan ?? "Free")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!activePlan ? (
                <Button asChild size="sm" variant="outline" className="gap-2">
                  <Link to="/checkout">
                    <Sparkles className="size-3.5" />
                    Upgrade
                  </Link>
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Thanks for supporting the catalog!
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Screenings */}
        <Card className="overflow-hidden p-0">
          <CardHeader className="border-b border-border/50 py-4">
            <CardTitle className="font-display text-lg">Your screenings</CardTitle>
            <CardDescription>
              Book new times from any movie page.
            </CardDescription>
          </CardHeader>
          {!screenings ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : screenings.length === 0 ? (
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No screenings yet. Open a movie and pick a time — the whole team
              can see the plan.
            </CardContent>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Movie</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="hidden sm:table-cell">Note</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...upcoming, ...past].map((s) => (
                  <TableRow key={s._id}>
                    <TableCell>
                      <Link
                        to={`/movie/${s.movieId}`}
                        className="font-medium hover:text-primary"
                      >
                        {s.movieTitle}
                      </Link>
                      {s.scheduledFor < now && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          Past
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{fmt(s.scheduledFor)}</TableCell>
                    <TableCell className="hidden max-w-[220px] truncate sm:table-cell">
                      {s.note ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          aria-label="Cancel screening"
                          onClick={async () => {
                            try {
                              await cancelScreening({ id: s._id });
                              toast.success("Screening cancelled");
                            } catch (err) {
                              toast.error(
                                err instanceof Error ? err.message : "Failed to cancel",
                              );
                            }
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {/* Contributions */}
        {contributions && contributions.length > 0 && (
          <Card className="overflow-hidden p-0">
            <CardHeader className="border-b border-border/50 py-4">
              <CardTitle className="font-display text-lg">Your contributions</CardTitle>
              <CardDescription>Movies you added to the catalog.</CardDescription>
            </CardHeader>
            <div className="flex flex-wrap gap-3 p-5">
              {contributions.map((m) => (
                <Link
                  key={m._id}
                  to={`/movie/${m._id}`}
                  className="group flex items-center gap-3 rounded-xl border border-border/50 bg-card/60 p-2 pr-4 transition-colors hover:border-primary/40"
                >
                  <div className="h-12 w-9 overflow-hidden rounded-md bg-muted">
                    {m.posterUrl ? (
                      <img src={m.posterUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <div className="flex size-full items-center justify-center">
                        <Clapperboard className="size-4 text-muted-foreground/50" />
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium group-hover:text-primary">{m.title}</p>
                    <p className="text-xs text-muted-foreground">{m.genre ?? "Movie"}</p>
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}
