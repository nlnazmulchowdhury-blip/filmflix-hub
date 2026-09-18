import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Clapperboard,
  CreditCard,
  Film,
  Loader2,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { toast } from "sonner";

const fmtDateTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function AdminContent() {
  const { user, signOut } = useAuth();
  const isAdmin = user?.role === "admin";
  const movies = useQuery(api.movies.list);
  // Admin-only feeds: don't run them until the admin role is confirmed,
  // otherwise the server rejects the query and crashes the whole page.
  const allScreenings = useQuery(api.screenings.listAll, isAdmin ? {} : "skip");
  const allComments = useQuery(api.comments.listAll, isAdmin ? {} : "skip");
  const allOrders = useQuery(api.orders.listAll, isAdmin ? {} : "skip");
  const users = useQuery(api.admin.listUsers, isAdmin ? {} : "skip");

  const removeMovie = useMutation(api.movies.remove);
  const claimAdmin = useMutation(api.movies.claimAdmin);
  const removeComment = useMutation(api.comments.remove);
  const setRole = useMutation(api.admin.setRole);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Doc<"movies"> | null>(null);
  const [deleting, setDeleting] = useState<Doc<"movies"> | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);

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

      <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-8 sm:px-6">
        {!isAdmin ? (
          <Card className="mx-auto mt-12 max-w-md border-primary/25 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.9)]">
            <CardHeader className="items-center text-center">
              <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/12 text-primary">
                <ShieldCheck className="size-6" />
              </span>
              <CardTitle className="font-display">Admin access</CardTitle>
              <CardDescription>
                You are signed in as {user?.email ?? "a guest"}. Claim the admin
                role to manage the FilmFlix workspace.
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
            {/* Heading */}
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                  Workspace overview
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Manage the catalog, screenings, discussions, members, and plans.
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

            {/* Stats row */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card className="border-border/60 bg-card/70">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5">
                    <Film className="size-3.5" /> Movies
                  </CardDescription>
                  <CardTitle className="font-display text-3xl">
                    {movies === undefined ? "—" : movies.length}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Titles in the catalog.
                </CardContent>
              </Card>
              <Card className="border-border/60 bg-card/70">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5">
                    <CalendarClock className="size-3.5" /> Screenings
                  </CardDescription>
                  <CardTitle className="font-display text-3xl">
                    {allScreenings === undefined ? "—" : allScreenings.length}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Times booked by the team.
                </CardContent>
              </Card>
              <Card className="border-border/60 bg-card/70">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5">
                    <MessageSquare className="size-3.5" /> Comments
                  </CardDescription>
                  <CardTitle className="font-display text-3xl">
                    {allComments === undefined ? "—" : allComments.length}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Discussion posts to moderate.
                </CardContent>
              </Card>
              <Card className="border-border/60 bg-card/70">
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5">
                    <Users className="size-3.5" /> Members
                  </CardDescription>
                  <CardTitle className="font-display text-3xl">
                    {users === undefined ? "—" : users.length}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  People with workspace access.
                </CardContent>
              </Card>
            </div>

            {/* Tabs */}
            <Tabs defaultValue="movies" className="mt-8">
              <TabsList className="flex w-full flex-wrap gap-1 bg-card/60 sm:w-auto">
                <TabsTrigger value="movies" className="gap-1.5">
                  <Film className="size-3.5" /> Movies
                </TabsTrigger>
                <TabsTrigger value="screenings" className="gap-1.5">
                  <CalendarClock className="size-3.5" /> Screenings
                </TabsTrigger>
                <TabsTrigger value="comments" className="gap-1.5">
                  <MessageSquare className="size-3.5" /> Comments
                </TabsTrigger>
                <TabsTrigger value="members" className="gap-1.5">
                  <Users className="size-3.5" /> Members
                </TabsTrigger>
                <TabsTrigger value="orders" className="gap-1.5">
                  <CreditCard className="size-3.5" /> Orders
                </TabsTrigger>
              </TabsList>

              {/* Movies */}
              <TabsContent value="movies">
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
              </TabsContent>

              {/* Screenings */}
              <TabsContent value="screenings">
                <Card className="overflow-hidden p-0">
                  <CardHeader className="border-b border-border/50 py-4">
                    <CardTitle className="font-display text-lg">Team screenings</CardTitle>
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
                                {fmtDateTime(s.scheduledFor)}
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
              </TabsContent>

              {/* Comments */}
              <TabsContent value="comments">
                <Card className="overflow-hidden p-0">
                  <CardHeader className="border-b border-border/50 py-4">
                    <CardTitle className="font-display text-lg">Comment moderation</CardTitle>
                    <CardDescription>
                      Recent discussion posts from across all movies.
                    </CardDescription>
                  </CardHeader>
                  {!allComments ? (
                    <div className="space-y-3 p-6">
                      <Skeleton className="h-14 w-full" />
                      <Skeleton className="h-14 w-full" />
                    </div>
                  ) : allComments.length === 0 ? (
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                      No comments yet — nothing to moderate.
                    </CardContent>
                  ) : (
                    <div className="divide-y divide-border/50">
                      {allComments.map((c) => (
                        <div key={c._id} className="flex items-start gap-3 p-4">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                            {(c.authorName ?? "M").slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold">{c.authorName}</p>
                              <span className="text-xs text-muted-foreground">
                                {fmtDateTime(c.createdAt)}
                              </span>
                              <Link
                                to={`/movie/${c.movieId}`}
                                className="text-xs text-primary underline-offset-4 hover:underline"
                              >
                                on {c.movieTitle}
                              </Link>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/90">
                              {c.text}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label="Delete comment"
                            onClick={async () => {
                              try {
                                await removeComment({ id: c._id });
                                toast.success("Comment removed");
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Failed to remove",
                                );
                              }
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </TabsContent>

              {/* Members */}
              <TabsContent value="members">
                <Card className="overflow-hidden p-0">
                  <CardHeader className="border-b border-border/50 py-4">
                    <CardTitle className="font-display text-lg">Team members</CardTitle>
                    <CardDescription>
                      Promote trusted teammates to admin or remove access.
                    </CardDescription>
                  </CardHeader>
                  {!users ? (
                    <div className="space-y-3 p-6">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Member</TableHead>
                          <TableHead>Role</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {users.map((u) => (
                          <TableRow key={u._id}>
                            <TableCell>
                              <p className="font-medium">
                                {u.name ?? u.email ?? "Guest member"}
                                {u._id === user?._id && (
                                  <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                                )}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {u.email ?? "anonymous — signed in without email"}
                              </p>
                            </TableCell>
                            <TableCell>
                              {u.role === "admin" ? (
                                <Badge className="border-primary/40 bg-primary/15 text-primary" variant="outline">
                                  Admin
                                </Badge>
                              ) : (
                                <Badge variant="secondary">Member</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1.5">
                                {u.role === "admin" ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="gap-1.5 text-muted-foreground"
                                    disabled={u._id === user?._id}
                                    onClick={async () => {
                                      try {
                                        await setRole({ userId: u._id, role: null });
                                        toast.success("Admin access removed");
                                      } catch (err) {
                                        toast.error(
                                          err instanceof Error ? err.message : "Failed",
                                        );
                                      }
                                    }}
                                  >
                                    <ShieldOff className="size-3.5" />
                                    Demote
                                  </Button>
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="gap-1.5"
                                    onClick={async () => {
                                      try {
                                        await setRole({ userId: u._id, role: "admin" });
                                        toast.success("Promoted to admin");
                                      } catch (err) {
                                        toast.error(
                                          err instanceof Error ? err.message : "Failed",
                                        );
                                      }
                                    }}
                                  >
                                    <ShieldCheck className="size-3.5" />
                                    Make admin
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </Card>
              </TabsContent>

              {/* Orders */}
              <TabsContent value="orders">
                <Card className="overflow-hidden p-0">
                  <CardHeader className="border-b border-border/50 py-4">
                    <CardTitle className="font-display text-lg">Plan orders</CardTitle>
                    <CardDescription>
                      Every plan checkout recorded for the team.
                    </CardDescription>
                  </CardHeader>
                  {!allOrders ? (
                    <div className="space-y-3 p-6">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : allOrders.length === 0 ? (
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                      No orders yet.{" "}
                      <Link to="/checkout" className="text-primary underline underline-offset-4">
                        See plans
                      </Link>
                    </CardContent>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Member</TableHead>
                          <TableHead>Plan</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead className="hidden sm:table-cell">Status</TableHead>
                          <TableHead className="hidden md:table-cell">Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {allOrders.map((o) => (
                          <TableRow key={o._id}>
                            <TableCell className="font-medium">{o.memberName}</TableCell>
                            <TableCell>
                              <Badge variant="secondary" className="capitalize">
                                {o.plan}
                              </Badge>
                            </TableCell>
                            <TableCell>${(o.amountCents / 100).toFixed(2)}</TableCell>
                            <TableCell className="hidden sm:table-cell">
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400 capitalize"
                              >
                                {o.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="hidden md:table-cell whitespace-nowrap">
                              {fmtDateTime(o.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </Card>
              </TabsContent>
            </Tabs>
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
      />

      {deleting && (
        <dialog
          open
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleting(null);
          }}
        >
          <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl">
            <h3 className="font-display text-lg font-semibold">Delete movie?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              "{deleting.title}" will be permanently removed from the catalog.
              This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" autoFocus onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete} className="gap-2">
                <Trash2 className="size-4" />
                Delete
              </Button>
            </div>
          </div>
        </dialog>
      )}
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
