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
import MovieFormDialog from "@/components/MovieFormDialog";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CalendarClock,
  Film,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { toast } from "sonner";

function AdminContent() {
  const { user, signOut } = useAuth();
  const movies = useQuery(api.movies.list);
  const allScreenings = useQuery(api.screenings.listAll);
  const removeMovie = useMutation(api.movies.remove);
  const claimAdmin = useMutation(api.movies.claimAdmin);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Doc<"movies"> | null>(null);
  const [deleting, setDeleting] = useState<Doc<"movies"> | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);

  const isAdmin = user?.role === "admin";

  const handleClaim = async () => {
    setIsClaiming(true);
    try {
      await claimAdmin();
      toast.success("You now have admin access");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to claim admin");
    } finally {
      setIsClaiming(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await removeMovie({ id: deleting._id });
      toast.success(`Deleted "${deleting.title}"`);
      setDeleting(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const fmt = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/8 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link to="/" aria-label="FilmFlix home">
              <Logo />
            </Link>
            <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
              Admin
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="gap-2">
              <Link to="/">
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">View site</span>
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
        {!isAdmin ? (
          <Card className="mx-auto mt-12 max-w-md border-primary/25 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.9)]">
            <CardHeader className="items-center text-center">
              <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/12 text-primary">
                <ShieldCheck className="size-6" />
              </span>
              <CardTitle className="font-display">Admin access</CardTitle>
              <CardDescription>
                You are signed in as {user?.email ?? "a guest"}. Claim the admin
                role to manage the FilmFlix catalog.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={handleClaim} disabled={isClaiming} className="w-full gap-2">
                {isClaiming && <Loader2 className="size-4 animate-spin" />}
                Claim admin access
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                  Movie management
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add, edit, and remove movies from the team catalog.
                </p>
              </div>
              <Button
                className="glow-accent gap-2"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="size-4" />
                Add movie
              </Button>
            </div>

            <Card className="overflow-hidden p-0">
              {!movies ? (
                <div className="space-y-3 p-6">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : movies.length === 0 ? (
                <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                  <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Film className="size-6" />
                  </span>
                  <p className="font-display text-lg font-semibold">No movies yet</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Add your first movie and it will show up in the catalog right
                    away.
                  </p>
                </CardContent>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-16">Poster</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead className="hidden sm:table-cell">Genre</TableHead>
                      <TableHead className="hidden md:table-cell">Year</TableHead>
                      <TableHead className="hidden md:table-cell">Rating</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movies.map((m) => (
                      <TableRow key={m._id}>
                        <TableCell>
                          <div className="h-14 w-10 overflow-hidden rounded-md bg-muted">
                            {m.posterUrl ? (
                              <img src={m.posterUrl} alt="" className="size-full object-cover" />
                            ) : (
                              <div className="flex size-full items-center justify-center">
                                <Film className="size-4 text-muted-foreground/50" />
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[200px]">
                          <p className="truncate font-medium">{m.title}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {m.videoUrl ? "Video ready" : "No video"}
                          </p>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {m.genre ? (
                            <Badge variant="secondary">{m.genre}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {m.year ?? "—"}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {m.rating != null ? m.rating.toFixed(1) : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Edit ${m.title}`}
                              onClick={() => {
                                setEditing(m);
                                setDialogOpen(true);
                              }}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-destructive hover:text-destructive"
                              aria-label={`Delete ${m.title}`}
                              onClick={() => setDeleting(m)}
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

            {/* All team screenings */}
            <Card className="overflow-hidden p-0">
              <CardHeader className="border-b border-border/50 py-4">
                <CardTitle className="flex items-center gap-2 font-display text-lg">
                  <CalendarClock className="size-4 text-primary" />
                  Team screenings
                </CardTitle>
                <CardDescription>
                  Every screening booked across the workspace.
                </CardDescription>
              </CardHeader>
              {!allScreenings ? (
                <div className="space-y-3 p-6">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : allScreenings.length === 0 ? (
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  No screenings booked yet.
                </CardContent>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Movie</TableHead>
                      <TableHead>Booked by</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead className="hidden sm:table-cell">Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...allScreenings]
                      .sort((a, b) => a.scheduledFor - b.scheduledFor)
                      .map((s) => (
                        <TableRow key={s._id}>
                          <TableCell className="font-medium">{s.movieTitle}</TableCell>
                          <TableCell>{s.ownerName}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {fmt(s.scheduledFor)}
                          </TableCell>
                          <TableCell className="hidden max-w-[220px] truncate sm:table-cell">
                            {s.note ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </>
        )}
      </main>

      <MovieFormDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditing(null);
        }}
        movie={editing}
        mode="admin"
      />

      <dialog
        open={deleting != null}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
        onClick={(e) => {
          if (e.target === e.currentTarget) setDeleting(null);
        }}
      >
        <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl">
          <h3 className="font-display text-lg font-semibold">Delete movie?</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            "{deleting?.title}" will be permanently removed from the catalog.
            This cannot be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} className="gap-2">
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

export default function Admin() {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}` || "/nazmul";
    return <Navigate to={`/auth?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  return <AdminContent />;
}
