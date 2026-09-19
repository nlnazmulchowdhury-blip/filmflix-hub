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
import { Input } from "@/components/ui/input";
import Logo from "@/components/Logo";
import MovieFormDialog from "@/components/MovieFormDialog";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import { movieCategoryNames } from "@/lib/categories";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CalendarClock,
  Clapperboard,
  CreditCard,
  Film,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
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
  const removeCategory = useMutation(api.movies.removeCategory);
  const verifyAdminCode = useMutation(api.movies.verifyAdminCode);
  const removeComment = useMutation(api.comments.remove);
  const setRole = useMutation(api.admin.setRole);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Doc<"movies"> | null>(null);
  const [deleting, setDeleting] = useState<Doc<"movies"> | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<{
    name: string;
    count: number;
  } | null>(null);
  const [adminCode, setAdminCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [movieSearch, setMovieSearch] = useState("");

  /* Admin catalog search: matches title, description, genre, year, kind —
     every word must appear somewhere, forgiving of order and punctuation. */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of movies ?? []) {
      for (const c of movieCategoryNames(m)) set.add(c);
    }
    return Array.from(set).sort();
  }, [movies]);

  const filteredMovies = useMemo(() => {
    if (!movies) return null;
    const raw = movieSearch.trim();
    if (!raw) return movies;
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const tokens = norm(raw).split(" ").filter(Boolean);
    if (tokens.length === 0) return movies;
    return movies.filter((m) => {
      const hay = norm(
        [
          m.title,
          m.description,
          m.genre,
          ...movieCategoryNames(m),
          m.year?.toString(),
          m.kind,
        ]
          .filter(Boolean)
          .join(" "),
      );
      return tokens.every((t) => hay.includes(t));
    });
  }, [movies, movieSearch]);

  const handleVerifyCode = async () => {
    if (!adminCode.trim()) {
      toast.error("Enter the admin access code");
      return;
    }
    setIsVerifying(true);
    try {
      await verifyAdminCode({ code: adminCode });
      toast.success("Admin access granted");
      setAdminCode("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsVerifying(false);
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

  const handleDeleteCategory = async () => {
    if (!deletingCategory) return;
    try {
      const changed = await removeCategory({ category: deletingCategory.name });
      toast.success(
        `Category "${deletingCategory.name}" removed — ${changed} ${changed === 1 ? "movie" : "movies"} kept in the catalog as uncategorized.`,
      );
      setDeletingCategory(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete category");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/8 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-2 px-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link to="/" aria-label="FilmFlix home">
              <Logo />
            </Link>
            <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
              Admin
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
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

      <main className="mx-auto w-full max-w-6xl px-3 pb-24 pt-4 sm:px-6 sm:pt-8">
        {!isAdmin ? (
          <Card className="mx-auto mt-12 max-w-md border-primary/25 shadow-[0_24px_64px_-32px_rgba(0,0,0,0.9)]">
            <CardHeader className="items-center text-center">
              <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/12 text-primary">
                <KeyRound className="size-6" />
              </span>
              <CardTitle className="font-display">Admin sign-in</CardTitle>
              <CardDescription>
                This area is restricted. Enter the admin access code to manage
                the FilmFlix workspace.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleVerifyCode();
                }}
                className="space-y-3"
              >
                <Input
                  type="password"
                  value={adminCode}
                  onChange={(e) => setAdminCode(e.target.value)}
                  placeholder="Admin access code"
                  autoComplete="off"
                  disabled={isVerifying}
                />
                <Button
                  type="submit"
                  disabled={isVerifying || !adminCode.trim()}
                  className="w-full gap-2"
                >
                  {isVerifying && <Loader2 className="size-4 animate-spin" />}
                  <ShieldCheck className="size-4" />
                  Unlock admin panel
                </Button>
              </form>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Signed in as {user?.email ?? "a guest"} — the code is held only
                by workspace admins.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Heading */}
            <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
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
            <Tabs defaultValue="movies" className="mt-6 sm:mt-8">
              {/* Horizontally scrollable on phones — all five tabs stay reachable. */}
              <div className="-mx-3 overflow-x-auto px-3 pb-1 sm:mx-0 sm:overflow-visible sm:px-0">
              <TabsList className="flex w-max min-w-full gap-1 bg-card/60 sm:w-auto">
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
              </div>

              {/* Movies */}
              <TabsContent value="movies">
                {/* Category management */}
                {categories.length > 0 && (
                  <Card className="mb-4 border-border/60 bg-card/60 p-4">
                    <div className="mb-2.5 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <p className="font-display text-sm font-semibold">
                        Categories ({categories.length})
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Deleting a category keeps its movies in the catalog as
                        uncategorized.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {categories.map((c) => {
                        const count = (movies ?? []).filter(
                          (m) => movieCategoryNames(m).includes(c),
                        ).length;
                        return (
                          <span
                            key={c}
                            className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 py-1 pl-3 pr-1.5 text-xs font-semibold text-primary"
                          >
                            {c}
                            <span className="text-[10px] font-medium text-primary/70">
                              {count}
                            </span>
                            <button
                              type="button"
                              aria-label={`Delete category ${c}`}
                              title="Delete category"
                              onClick={() => setDeletingCategory({ name: c, count })}
                              className="rounded-full p-0.5 text-primary/70 transition-colors hover:bg-primary/20 hover:text-destructive"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  </Card>
                )}

                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative min-w-0 flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={movieSearch}
                      onChange={(e) => setMovieSearch(e.target.value)}
                      placeholder="Search movies by title, genre, year…"
                      className="pl-9 pr-9"
                      aria-label="Search movies in admin panel"
                    />
                    {movieSearch && (
                      <button
                        type="button"
                        onClick={() => setMovieSearch("")}
                        aria-label="Clear search"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <X className="size-4" />
                      </button>
                    )}
                  </div>
                  {filteredMovies !== null && movieSearch.trim() && (
                    <span className="text-xs text-muted-foreground sm:whitespace-nowrap">
                      {filteredMovies.length} of {movies?.length ?? 0} movies
                    </span>
                  )}
                </div>
                <Card className="overflow-hidden p-0">
                  {!filteredMovies ? (
                    <div className="space-y-3 p-6">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : filteredMovies.length === 0 ? (
                    <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Film className="size-6" />
                      </span>
                      <p className="font-display text-lg font-semibold">
                        {movieSearch.trim() ? "Nothing matched" : "No movies yet"}
                      </p>
                      <p className="max-w-sm text-sm text-muted-foreground">
                        {movieSearch.trim()
                          ? "Try fewer words or a different spelling."
                          : "Add your first movie and it will show up in the catalog right away."}
                      </p>
                    </CardContent>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-16">Poster</TableHead>
                          <TableHead>Title</TableHead>
                          <TableHead className="hidden sm:table-cell">Genre</TableHead>
                          <TableHead className="hidden md:table-cell">Category</TableHead>
                          <TableHead className="hidden lg:table-cell">Year</TableHead>
                          <TableHead className="hidden md:table-cell">Rating</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredMovies.map((m) => (
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
                            <TableCell className="max-w-[38vw] sm:max-w-[200px]">
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
                              {(() => {
                                const cats = movieCategoryNames(m);
                                return cats.length > 0 ? (
                                  <div className="flex max-w-[240px] flex-wrap gap-1">
                                    {cats.map((c) => (
                                      <Badge
                                        key={c}
                                        variant="outline"
                                        className="border-primary/40 bg-primary/10 text-primary"
                                      >
                                        {c}
                                      </Badge>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                );
                              })()}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
                              {m.year ?? "—"}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
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
                              <TableCell className="max-w-[32vw] font-medium">
                                <span className="block truncate">{s.movieTitle}</span>
                              </TableCell>
                              <TableCell className="max-w-[26vw]">
                                <span className="block truncate">{s.ownerName}</span>
                              </TableCell>
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
                            <TableCell className="max-w-[40vw] font-medium">
                              <span className="block truncate">{o.memberName}</span>
                            </TableCell>
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
        categories={categories}
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

      {deletingCategory && (
        <dialog
          open
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeletingCategory(null);
          }}
        >
          <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl">
            <h3 className="font-display text-lg font-semibold">
              Delete category "{deletingCategory.name}"?
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {deletingCategory.count > 0
                ? `${deletingCategory.count} ${deletingCategory.count === 1 ? "movie" : "movies"} will become uncategorized but stay in the catalog.`
                : "This category has no movies."}{" "}
              The category pill will disappear from the public site.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" autoFocus onClick={() => setDeletingCategory(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDeleteCategory} className="gap-2">
                <Trash2 className="size-4" />
                Delete category
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
