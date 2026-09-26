import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Logo from "@/components/Logo";
import MovieFormDialog from "@/components/MovieFormDialog";
import RelayUrlHelper from "@/components/RelayUrlHelper";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DUB_LANGUAGES } from "@/lib/dub-languages";
import { movieCategoryNames } from "@/lib/categories";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery, useAction } from "convex/react";
import {
  ArrowLeft,
  BarChart3,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  Clapperboard,
  CreditCard,
  Film,
  Headset,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users,
  X,
  Link2,
  Languages,
  Check,
  Tv,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const markOrderPaid = useMutation(api.orders.markPaid);
  const users = useQuery(api.admin.listUsers, isAdmin ? {} : "skip");
  const analytics = useQuery(api.analytics.summary, isAdmin ? {} : "skip");

  /* Help-center chat: visitor conversations + admin replies */
  const conversations = useQuery(
    api.support.listConversations,
    isAdmin ? {} : "skip",
  );
  const adminUnread = useQuery(api.support.unreadForAdmin, isAdmin ? {} : "skip");
  const moveMovieTop = useMutation(api.movies.moveToTop);
  const moveMovieOrder = useMutation(api.movies.moveInOrder);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);

  const applyMovieMove = async (
    id: string,
    fn: () => Promise<unknown>,
  ) => {
    setBusyOrder(id);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Move failed");
    } finally {
      setBusyOrder(null);
    }
  };

  const replySupport = useMutation(api.support.replyFromAdmin);
  const editSupport = useMutation(api.support.editAsAdmin);
  const deleteSupport = useMutation(api.support.deleteAsAdmin);
  const markSupportSeen = useMutation(api.support.markSeenByAdmin);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [supportDraft, setSupportDraft] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  // Editing/deleting any message in the thread (admin can touch both sides).
  const [editMsg, setEditMsg] = useState<{ id: string; text: string } | null>(null);
  const [editMsgDraft, setEditMsgDraft] = useState("");
  const [isEditSaving, setIsEditSaving] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<{ id: string; text: string } | null>(null);
  const [isDeleteSaving, setIsDeleteSaving] = useState(false);
  const thread = useQuery(
    api.support.listThread,
    activeThread ? { userId: activeThread as Id<"users"> } : "skip",
  );
  const supportScroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = supportScroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.length, activeThread]);

  useEffect(() => {
    if (activeThread && (thread ?? []).some((m) => m.sender === "user")) {
      markSupportSeen({ userId: activeThread as Id<"users"> });
    }
  }, [activeThread, thread, markSupportSeen]);

  const sendSupportReply = async () => {
    const text = supportDraft.trim();
    if (!text || !activeThread || isReplying) return;
    setIsReplying(true);
    try {
      await replySupport({ userId: activeThread as Id<"users">, text });
      setSupportDraft("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setIsReplying(false);
    }
  };

  const saveSupportEdit = async () => {
    const text = editMsgDraft.trim();
    if (!text || !editMsg || isEditSaving) return;
    setIsEditSaving(true);
    try {
      await editSupport({ messageId: editMsg.id as Id<"supportMessages">, text });
      setEditMsg(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsEditSaving(false);
    }
  };

  const confirmSupportDelete = async () => {
    if (!deleteMsg || isDeleteSaving) return;
    setIsDeleteSaving(true);
    try {
      await deleteSupport({ messageId: deleteMsg.id as Id<"supportMessages"> });
      setDeleteMsg(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setIsDeleteSaving(false);
    }
  };

  /* Link health: broken movie/TV stream URLs → "Links" tab (checked every
     6h by cron + manually). Toasts once when NEW failures appear. */
  const linkHealth = useQuery(api.linkHealth.summary, isAdmin ? {} : "skip");
  const checkLinks = useAction(api.linkHealth.checkAll);
  const setLinkIgnored = useMutation(api.linkHealth.setIgnored);
  const [isCheckingLinks, setIsCheckingLinks] = useState(false);
  const notifiedBroken = useRef(false);

  const brokenCount = linkHealth?.failures.length ?? 0;
  const ignoredCount = linkHealth?.ignoredFailures.length ?? 0;

  useEffect(() => {
    if (!linkHealth) return;
    const count = linkHealth.failures.length;
    if (count > 0 && !notifiedBroken.current) {
      notifiedBroken.current = true;
      toast.warning(
        `${count} stream link${count === 1 ? " is" : "s are"} broken — see the Links tab`,
        { duration: 8000 },
      );
    }
  }, [linkHealth]);

  const toggleLinkIgnored = async (url: string, ignored: boolean) => {
    try {
      await setLinkIgnored({ url, ignored });
      toast.success(ignored ? "Link hidden from the alert" : "Link restored to the alert");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  /* Ad networks (whose script may have loaded on public pages earlier in the
     session) keep injecting stray anchors (e.g. <a id="lkiir">), hidden
     iframes and popunder handlers straight into <body> — those must never
     touch the admin panel. While this route is open, strip the ad script and
     any artifacts it appends. */
  useEffect(() => {
    const AD_SRC = /profitableratecpm/i;
    const isAdAnchor = (a: HTMLAnchorElement) =>
      a.parentElement === document.body &&
      (!a.getAttribute("href") || AD_SRC.test(a.href)) &&
      !(a.textContent ?? "").includes("Freebuff");
    const prune = () => {
      document.querySelectorAll("script[src]").forEach((s) => {
        if (AD_SRC.test((s as HTMLScriptElement).src)) s.remove();
      });
      document.querySelectorAll("body > a").forEach((a) => {
        if (isAdAnchor(a as HTMLAnchorElement)) a.remove();
      });
      document.querySelectorAll("body > iframe").forEach((f) => {
        if (AD_SRC.test((f as HTMLIFrameElement).src || "")) f.remove();
      });
    };
    prune();
    const observer = new MutationObserver(prune);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);

  const handleCheckLinks = async () => {
    setIsCheckingLinks(true);
    try {
      const res = await checkLinks({});
      if (res.failed === 0) {
        toast.success(`All ${res.checked} stream links are working`);
      } else {
        toast.error(
          `${res.failed} of ${res.checked} stream links failed — see the alert below`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Link check failed");
    } finally {
      setIsCheckingLinks(false);
    }
  };

  const removeMovie = useMutation(api.movies.remove);
  const removeCategory = useMutation(api.categories.remove);
  const createCategory = useMutation(api.categories.create);
  const verifyAdminCode = useMutation(api.movies.verifyAdminCode);
  const removeComment = useMutation(api.comments.remove);
  const setRole = useMutation(api.admin.setRole);
  const migrateShortLinks = useAction(api.shortlinks.migrateAllShortLinks);
  const [isFixingLinks, setIsFixingLinks] = useState(false);

  /* AI dubbing (ElevenLabs auto-translation) */
  const [dubMovieId, setDubMovieId] = useState("");
  const dubJobs = useQuery(
    api.dubbing.listJobsForMovie,
    dubMovieId ? { movieId: dubMovieId as Id<"movies"> } : "skip",
  );
  const startDubJob = useMutation(api.dubbing.startDub);
  const submitDub = useAction(api.dubbing.submitDub);
  const pollDub = useAction(api.dubbing.pollDub);
  const removeDubJob = useMutation(api.dubbing.removeJob);
  const [dubLang, setDubLang] = useState("bn");
  const [isStartingDub, setIsStartingDub] = useState(false);
  const [isPolling, setIsPolling] = useState<Id<"dubJobs"> | null>(null);

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
  const [newCategoryName, setNewCategoryName] = useState("");
  const [isAddingCategory, setIsAddingCategory] = useState(false);

  /* Live TV channels — add/remove logo + stream URL, shown on /tv */
  const tvChannels = useQuery(api.tvChannels.list);
  const addTvChannel = useMutation(api.tvChannels.add);
  const updateTvChannel = useMutation(api.tvChannels.update);
  const removeTvChannel = useMutation(api.tvChannels.remove);
  const [tvName, setTvName] = useState("");
  const [tvLogo, setTvLogo] = useState("");
  const [tvUrl, setTvUrl] = useState("");
  const [tvCategories, setTvCategories] = useState("");
  const [tvBackups, setTvBackups] = useState("");
  const [isAddingTv, setIsAddingTv] = useState(false);

  /* Edit-TV-channel dialog state (form is pre-filled from the channel). */
  const [editingTv, setEditingTv] = useState<Doc<"tvChannels"> | null>(null);
  const [isSavingTv, setIsSavingTv] = useState(false);
  const [editTvName, setEditTvName] = useState("");
  const [editTvLogo, setEditTvLogo] = useState("");
  const [editTvUrl, setEditTvUrl] = useState("");
  const [editTvCategories, setEditTvCategories] = useState("");
  const [editTvBackups, setEditTvBackups] = useState("");
  const [editTvOrder, setEditTvOrder] = useState("");

  /* Admin catalog search: matches title, description, categories, year, kind —
     every word must appear somewhere, forgiving of order and punctuation. */
  const allCategories = useQuery(api.categories.listAll);

  /** Every section name on the site: categories created directly (live even
     with zero movies) plus names still only attached to movies. */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of allCategories ?? []) set.add(c.name);
    for (const m of movies ?? []) {
      for (const c of movieCategoryNames(m)) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allCategories, movies]);

  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    setIsAddingCategory(true);
    try {
      await createCategory({ name });
      toast.success(`Category "${name}" created`);
      setNewCategoryName("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create category");
    } finally {
      setIsAddingCategory(false);
    }
  };

  const openEditTv = (c: Doc<"tvChannels">) => {
    setEditingTv(c);
    setEditTvName(c.name);
    setEditTvLogo(c.logoUrl ?? "");
    setEditTvUrl(c.streamUrl);
    setEditTvCategories((c.categories ?? []).join(", "));
    setEditTvBackups((c.backupUrls ?? []).join(String.fromCharCode(10)));
    setEditTvOrder(c.order != null ? String(c.order) : "");
  };

  const handleSaveTv = async () => {
    if (!editingTv) return;
    setIsSavingTv(true);
    try {
      await updateTvChannel({
        id: editingTv._id,
        name: editTvName.trim(),
        logoUrl: editTvLogo.trim() || undefined,
        streamUrl: editTvUrl.trim(),
        backupUrls: editTvBackups
          .split(/[\r\n]/)
          .map((t) => t.trim())
          .filter(Boolean),
        categories: editTvCategories
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        order: editTvOrder.trim() === "" ? undefined : Number(editTvOrder.trim()),
      });
      toast.success(`Channel "${editTvName.trim()}" updated`);
      setEditingTv(null);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update channel",
      );
    } finally {
      setIsSavingTv(false);
    }
  };

  const handleStartDub = async () => {
    if (!dubMovieId) return;
    setIsStartingDub(true);
    try {
      const jobId = await startDubJob({
        movieId: dubMovieId as Id<"movies">,
        targetLang: dubLang,
      });
      toast.success("Dub job queued — sending to ElevenLabs…");
      try {
        await submitDub({ jobId });
        toast.success(
          "Dubbing started on ElevenLabs. A full movie takes a while — use “check now” later.",
        );
      } catch {
        toast.warning("Queued locally. ElevenLabs submit failed — press “send now” to retry.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the dub");
    } finally {
      setIsStartingDub(false);
    }
  };

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
    const row = (allCategories ?? []).find((c) => c.name === deletingCategory.name);
    if (!row) {
      toast.error("Category not found");
      setDeletingCategory(null);
      return;
    }
    try {
      await removeCategory({ id: row._id });
      toast.success(
        `Category "${deletingCategory.name}" removed — ${deletingCategory.count} ${deletingCategory.count === 1 ? "movie" : "movies"} kept in the catalog as uncategorized.`,
      );
      setDeletingCategory(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete category");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
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
            <ThemeToggle />
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
              <div className="flex flex-wrap gap-2">
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
              <TabsList className="flex w-max min-w-full gap-1 bg-card/60 sm:w-auto sm:flex-wrap">
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
                <TabsTrigger value="analytics" className="gap-1.5">
                  <BarChart3 className="size-3.5" /> Analytics
                </TabsTrigger>
                <TabsTrigger value="tv" className="gap-1.5">
                  <Tv className="size-3.5" /> TV
                </TabsTrigger>
                <TabsTrigger value="support" className="gap-1.5">
                  <Headset className="size-3.5" /> Support
                  {(adminUnread ?? 0) > 0 && (
                    <span className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-destructive-foreground">
                      {adminUnread}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="links" className="gap-1.5">
                  <ShieldAlert className="size-3.5" /> Links
                  {brokenCount > 0 && (
                    <span className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-destructive-foreground">
                      {brokenCount}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
              </div>

              {/* Movies */}
              <TabsContent value="movies">
                {/* Category management — always visible, direct add */}
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
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleAddCategory();
                    }}
                    className="mb-3 flex flex-col gap-2 sm:flex-row"
                  >
                    <Input
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      placeholder="New category name — e.g. Hollywood, Bengali, Anime…"
                      aria-label="New category name"
                      maxLength={60}
                      disabled={isAddingCategory}
                    />
                    <Button
                      type="submit"
                      className="gap-2 sm:w-auto"
                      disabled={isAddingCategory || !newCategoryName.trim()}
                    >
                      {isAddingCategory && <Loader2 className="size-4 animate-spin" />}
                      <Plus className="size-4" />
                      Add category
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-2 sm:w-auto"
                      disabled={isFixingLinks}
                      onClick={async () => {
                        setIsFixingLinks(true);
                        try {
                          const res = await migrateShortLinks({});
                          if (res.links === 0) {
                            toast.info("No short links found — every video URL is already a direct link.");
                          } else {
                            toast.success(
                              `Fixed ${res.links} link${res.links === 1 ? "" : "s"} on ${res.movies} movie${res.movies === 1 ? "" : "s"} — videos will play again.`,
                            );
                          }
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Could not fix short links",
                          );
                        } finally {
                          setIsFixingLinks(false);
                        }
                      }}
                    >
                      {isFixingLinks && <Loader2 className="size-4 animate-spin" />}
                      <Link2 className="size-4" />
                      Fix short links
                    </Button>
                  </form>
                  {categories.length > 0 ? (
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
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No categories yet — add your first one above, or pick
                      categories when adding a movie.
                    </p>
                  )}
                </Card>

                {isFixingLinks && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-primary">
                    <Loader2 className="size-4 animate-spin" />
                    Fixing short links — resolving every tinyurl/is.gd link to
                    its real destination. Please keep this page open…
                  </div>
                )}

                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative min-w-0 flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={movieSearch}
                      onChange={(e) => setMovieSearch(e.target.value)}
                      placeholder="Search movies by title, category, year…"
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
                          <TableHead className="w-28">Order</TableHead>
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
                            <TableCell>
                              <div className="flex items-center gap-0.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6"
                                  aria-label={`Move ${m.title} to top`}
                                  title="Move to top — show first on the site"
                                  disabled={busyOrder === m._id}
                                  onClick={() =>
                                    applyMovieMove(m._id, () => moveMovieTop({ id: m._id }))
                                  }
                                >
                                  <ChevronsUp className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6"
                                  aria-label={`Move ${m.title} up`}
                                  title="Move up one slot"
                                  disabled={busyOrder === m._id}
                                  onClick={() =>
                                    applyMovieMove(m._id, () => moveMovieOrder({ id: m._id, dir: "up" }))
                                  }
                                >
                                  <ChevronUp className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6"
                                  aria-label={`Move ${m.title} down`}
                                  title="Move down one slot"
                                  disabled={busyOrder === m._id}
                                  onClick={() =>
                                    applyMovieMove(m._id, () => moveMovieOrder({ id: m._id, dir: "down" }))
                                  }
                                >
                                  <ChevronDown className="size-3.5" />
                                </Button>
                              </div>
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

                {/* AI auto-dubbing */}
                <Card className="mt-4 border-border/60 bg-card/60 p-4">
                  <div className="mb-1 flex items-center gap-2">
                    <Languages className="size-4 text-primary" />
                    <p className="font-display text-sm font-semibold">AI auto-dubbing</p>
                  </div>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Translate a movie's audio into another language with AI
                    (ElevenLabs). The dub runs on their servers — a full movie
                    can take a while. When it's done, the language appears in
                    the player's language menu automatically. Costs credits
                    based on duration.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleStartDub();
                    }}
                    className="flex flex-col gap-2 sm:flex-row"
                  >
                    <select
                      value={dubMovieId}
                      onChange={(e) => setDubMovieId(e.target.value)}
                      aria-label="Movie to dub"
                      className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Pick a movie…</option>
                      {(movies ?? [])
                        .filter((m) => m.videoUrl)
                        .map((m) => (
                          <option key={m._id} value={m._id}>
                            {m.title}
                          </option>
                        ))}
                    </select>
                    <select
                      value={dubLang}
                      onChange={(e) => setDubLang(e.target.value)}
                      aria-label="Target language"
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {DUB_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="submit"
                      className="gap-2"
                      disabled={!dubMovieId || isStartingDub}
                    >
                      {isStartingDub && <Loader2 className="size-4 animate-spin" />}
                      <Languages className="size-4" />
                      Auto-dub
                    </Button>
                  </form>

                  {(dubJobs ?? []).length > 0 && (
                    <div className="mt-3 space-y-2">
                      {dubJobs!.map((j) => (
                        <div
                          key={j._id}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs"
                        >
                          <span className="font-semibold">{j.movieTitle}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-medium">
                            {DUB_LANGUAGES.find((l) => l.code === j.targetLang)?.label ?? j.targetLang}
                          </span>
                          {j.status === "dubbing" && (
                            <span className="inline-flex items-center gap-1.5 text-amber-500">
                              <Loader2 className="size-3 animate-spin" />
                              Dubbing on ElevenLabs…
                              <button
                                type="button"
                                className="underline underline-offset-2 hover:text-foreground"
                                onClick={async () => {
                                  setIsPolling(j._id);
                                  try {
                                    const r = await pollDub({ jobId: j._id });
                                    if (r.status === "dubbed") {
                                      toast.success(`"${j.movieTitle}" ${j.targetLang} dub is ready — language added to the player.`);
                                    } else if (r.status === "failed") {
                                      toast.error("The dub failed — see the error.");
                                    } else {
                                      toast.info("Still dubbing — check again in a few minutes.");
                                    }
                                  } catch (err) {
                                    toast.error(err instanceof Error ? err.message : "Check failed");
                                  } finally {
                                    setIsPolling(null);
                                  }
                                }}
                              >
                                check now
                              </button>
                            </span>
                          )}
                          {j.status === "queued" && (
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                              Queued
                              <button
                                type="button"
                                className="underline underline-offset-2 hover:text-foreground"
                                onClick={async () => {
                                  setIsPolling(j._id);
                                  try {
                                    await submitDub({ jobId: j._id });
                                    toast.success("Submitted to ElevenLabs");
                                  } catch (err) {
                                    toast.error(err instanceof Error ? err.message : "Submit failed");
                                  } finally {
                                    setIsPolling(null);
                                  }
                                }}
                              >
                                send now
                              </button>
                            </span>
                          )}
                          {j.status === "dubbed" && (
                            <span className="font-semibold text-emerald-500">
                              ✓ Dub ready — added to the player
                            </span>
                          )}
                          {j.status === "failed" && (
                            <span
                              className="max-w-[320px] truncate font-medium text-destructive"
                              title={j.error ?? ""}
                            >
                              Failed: {j.error ?? "unknown error"}
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-2">
                            {isPolling === j._id && <Loader2 className="size-3 animate-spin" />}
                            <button
                              type="button"
                              aria-label="Remove job"
                              className="text-muted-foreground transition-colors hover:text-destructive"
                              onClick={async () => {
                                await removeDubJob({ jobId: j._id });
                              }}
                            >
                              <X className="size-3.5" />
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
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
                          <TableHead>Action</TableHead>
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
                                className={
                                  o.status === "paid"
                                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 capitalize"
                                    : "border-amber-500/40 bg-amber-500/10 text-amber-400 capitalize"
                                }
                              >
                                {o.status}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {o.status === "paid" ? (
                                <span className="text-xs text-muted-foreground">—</span>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="gap-1.5"
                                  onClick={async () => {
                                    try {
                                      await markOrderPaid({ orderId: o._id });
                                      toast.success("Order marked as paid");
                                    } catch (err) {
                                      toast.error(
                                        err instanceof Error ? err.message : "Failed",
                                      );
                                    }
                                  }}
                                >
                                  <Check className="size-3.5" />
                                  Mark paid
                                </Button>
                              )}
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

              {/* Analytics — whole-site traffic overview */}
              <TabsContent value="analytics">
                {!analytics ? (
                  <div className="grid gap-3 sm:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-24 w-full rounded-xl" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Stat cards */}
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <Card className="p-4">
                        <p className="text-xs font-medium text-muted-foreground">Total page views</p>
                        <p className="font-display mt-1 text-2xl font-bold tabular-nums">
                          {analytics.total.toLocaleString()}
                        </p>
                      </Card>
                      <Card className="p-4">
                        <p className="text-xs font-medium text-muted-foreground">Today</p>
                        <p className="font-display mt-1 text-2xl font-bold tabular-nums">
                          {analytics.today.toLocaleString()}
                        </p>
                      </Card>
                      <Card className="p-4">
                        <p className="text-xs font-medium text-muted-foreground">Last 7 days</p>
                        <p className="font-display mt-1 text-2xl font-bold tabular-nums">
                          {analytics.last7.toLocaleString()}
                        </p>
                      </Card>
                      <Card className="p-4">
                        <p className="text-xs font-medium text-muted-foreground">
                          Visitors (7 days, approx.)
                        </p>
                        <p className="font-display mt-1 text-2xl font-bold tabular-nums">
                          {analytics.visitors7.toLocaleString()}
                        </p>
                      </Card>
                    </div>

                    {/* 14-day bar chart */}
                    <Card className="p-4">
                      <p className="font-display text-sm font-semibold">Views — last 14 days</p>
                      <div className="mt-4 flex h-36 items-end gap-1.5">
                        {analytics.series.map((d) => {
                          const max = Math.max(...analytics.series.map((x) => x.views), 1);
                          const pct = Math.max(2, Math.round((d.views / max) * 100));
                          return (
                            <div
                              key={d.day}
                              className="group relative flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
                            >
                              <span className="pointer-events-none absolute -top-6 z-10 hidden rounded bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-background group-hover:block">
                                {d.views}
                              </span>
                              <div
                                className="w-full rounded-t-md bg-primary/80 transition-colors group-hover:bg-primary"
                                style={{ height: `${pct}%` }}
                              />
                              <span className="w-full truncate text-center text-[9px] text-muted-foreground">
                                {d.day}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </Card>

                    <div className="grid gap-4 lg:grid-cols-2">
                      {/* Top movies */}
                      <Card className="p-4">
                        <p className="font-display text-sm font-semibold">Most watched movies</p>
                        {analytics.topMovies.length === 0 ? (
                          <p className="mt-3 text-xs text-muted-foreground">
                            No movie page views yet.
                          </p>
                        ) : (
                          <div className="mt-3 space-y-2">
                            {analytics.topMovies.map((m) => {
                              const max = analytics.topMovies[0]?.count || 1;
                              return (
                                <div key={m.title} className="flex items-center gap-3">
                                  <span className="min-w-0 flex-1 truncate text-sm">{m.title}</span>
                                  <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-secondary">
                                    <div
                                      className="h-full rounded-full bg-primary"
                                      style={{ width: `${Math.round((m.count / max) * 100)}%` }}
                                    />
                                  </div>
                                  <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums">
                                    {m.count}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </Card>

                      {/* Top pages + devices + referrers */}
                      <Card className="p-4">
                        <p className="font-display text-sm font-semibold">Top pages</p>
                        {analytics.topPaths.length === 0 ? (
                          <p className="mt-3 text-xs text-muted-foreground">No traffic yet.</p>
                        ) : (
                          <div className="mt-3 space-y-1.5">
                            {analytics.topPaths.map((p) => (
                              <div key={p.path} className="flex items-center justify-between gap-3">
                                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                                  {p.path}
                                </span>
                                <span className="text-xs font-semibold tabular-nums">{p.count}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="mt-5 grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground">Devices</p>
                            <div className="mt-2 space-y-1">
                              {analytics.devices.map((d) => (
                                <div key={d.name} className="flex items-center justify-between gap-2 text-xs">
                                  <span className="capitalize">{d.name}</span>
                                  <span className="font-semibold tabular-nums">{d.count}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground">Top referrers</p>
                            {analytics.topReferrers.length === 0 ? (
                              <p className="mt-2 text-xs text-muted-foreground">Direct visits only.</p>
                            ) : (
                              <div className="mt-2 space-y-1">
                                {analytics.topReferrers.map((r) => (
                                  <div key={r.host} className="flex items-center justify-between gap-2 text-xs">
                                    <span className="min-w-0 flex-1 truncate">{r.host}</span>
                                    <span className="font-semibold tabular-nums">{r.count}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </Card>
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* Live TV channels */}
              <TabsContent value="tv">
                <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
                  {/* Add form */}
                  <Card className="h-fit border-border/60 bg-card/60">
                    <CardHeader className="pb-3">
                      <CardTitle className="font-display flex items-center gap-2 text-base">
                        <Plus className="size-4 text-primary" /> Add TV channel
                      </CardTitle>
                      <CardDescription>
                        Shown on the public /tv page. HLS (.m3u8) and MP4 links
                        play in the built-in player; other links open in a new
                        tab.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-1.5">
                        <label htmlFor="tv-name" className="text-xs font-medium text-muted-foreground">
                          Channel name
                        </label>
                        <Input
                          id="tv-name"
                          value={tvName}
                          onChange={(e) => setTvName(e.target.value)}
                          placeholder="e.g. Sony Entertainment TV"
                          maxLength={80}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="tv-logo" className="text-xs font-medium text-muted-foreground">
                          Logo URL (optional)
                        </label>
                        <Input
                          id="tv-logo"
                          value={tvLogo}
                          onChange={(e) => setTvLogo(e.target.value)}
                          placeholder="https://…/logo.png"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="tv-url" className="text-xs font-medium text-muted-foreground">
                          Stream URL
                        </label>
                        <Input
                          id="tv-url"
                          value={tvUrl}
                          onChange={(e) => setTvUrl(e.target.value)}
                          placeholder="https://…/stream.m3u8"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="tv-backups" className="text-xs font-medium text-muted-foreground">
                          Backup URLs (one per line) — used when the primary stream is down
                        </label>
                        <textarea
                          id="tv-backups"
                          value={tvBackups}
                          onChange={(e) => setTvBackups(e.target.value)}
                          placeholder={"https://…/backup-1.m3u8 | https://…/backup-2.m3u8"}
                          rows={2}
                          className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                      <RelayUrlHelper
                        channelName={tvName}
                        suggestLocalUrl={tvUrl}
                        onUsePublic={setTvUrl}
                        onAddBackup={(u) =>
                          setTvBackups((b) => (b.trim() ? `${b.trimEnd()}\n${u}` : u))
                        }
                      />
                      <div className="space-y-1.5">
                        <label htmlFor="tv-categories" className="text-xs font-medium text-muted-foreground">
                          Categories (comma-separated)
                        </label>
                        <Input
                          id="tv-categories"
                          value={tvCategories}
                          onChange={(e) => setTvCategories(e.target.value)}
                          placeholder="Sports, Bangla, News"
                        />
                      </div>
                      <Button
                        type="button"
                        className="w-full"
                        disabled={isAddingTv || !tvName.trim() || !tvUrl.trim()}
                        onClick={async () => {
                          setIsAddingTv(true);
                          try {
                            await addTvChannel({
                              name: tvName.trim(),
                              logoUrl: tvLogo.trim() || undefined,
                              streamUrl: tvUrl.trim(),
                              backupUrls: tvBackups
                                .split(/[\r\n]/)
                                .map((t) => t.trim())
                                .filter(Boolean),
                              categories: tvCategories
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            });
                            toast.success(`Channel “${tvName.trim()}” added`);
                            setTvName("");
                            setTvLogo("");
                            setTvUrl("");
                            setTvBackups("");
                            setTvCategories("");
                          } catch (err) {
                            toast.error(
                              err instanceof Error ? err.message : "Failed to add channel",
                            );
                          } finally {
                            setIsAddingTv(false);
                          }
                        }}
                      >
                        {isAddingTv && <Loader2 className="size-4 animate-spin" />}
                        Add channel
                      </Button>
                    </CardContent>
                  </Card>

                  {/* Channel list */}
                  <Card className="min-w-0 overflow-hidden border-border/60 bg-card/60">
                    <CardHeader className="pb-3">
                      <CardTitle className="font-display text-base">
                        Channels ({tvChannels?.length ?? 0})
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {!tvChannels ? (
                        <div className="space-y-2">
                          {Array.from({ length: 4 }).map((_, i) => (
                            <Skeleton key={i} className="h-14 w-full rounded-lg" />
                          ))}
                        </div>
                      ) : tvChannels.length === 0 ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">
                          No channels yet — add the first one with the form.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {tvChannels.map((c) => (
                            <div
                              key={c._id}
                              className="flex flex-col gap-3 rounded-lg border border-border/50 bg-background/40 p-2.5 sm:flex-row sm:items-center"
                            >
                              <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                                {c.logoUrl ? (
                                  <img
                                    src={c.logoUrl}
                                    alt=""
                                    loading="lazy"
                                    className="max-h-full max-w-full object-contain"
                                  />
                                ) : (
                                  <Tv className="size-4 text-muted-foreground" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold">{c.name}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {c.streamUrl}
                                </p>
                              </div>
                              <div className="flex w-full gap-1.5 sm:w-auto sm:shrink-0">
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="size-8 flex-1 shrink-0 sm:flex-none"
                                  onClick={() => openEditTv(c)}
                                  aria-label={`Edit ${c.name}`}
                                  title="Edit channel"
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="size-8 flex-1 shrink-0 sm:flex-none"
                                  onClick={() => window.open(c.streamUrl, "_blank", "noopener,noreferrer")}
                                  aria-label={`Test ${c.name} stream`}
                                  title="Test stream"
                                >
                                  <Link2 className="size-3.5" />
                                </Button>
                              <Button
                                variant="outline"
                                size="icon"
                                className="size-8 flex-1 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive sm:flex-none"
                                onClick={() => {
                                  if (window.confirm(`Delete channel “${c.name}”?`)) {
                                    removeTvChannel({ id: c._id });
                                  }
                                }}
                                aria-label={`Delete ${c.name}`}
                              >
                                <Trash2 className="size-3.5" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              {/* Links — stream URL health management */}
              <TabsContent value="links">
                <Card className="overflow-hidden p-0">
                  <CardHeader className="border-b border-border/50 py-4">
                    <CardTitle className="font-display flex flex-wrap items-center gap-2 text-lg">
                      Stream link health
                      {brokenCount > 0 && (
                        <Badge variant="outline" className="border-destructive/50 bg-destructive/10 text-destructive">
                          {brokenCount} broken
                        </Badge>
                      )}
                      {ignoredCount > 0 && (
                        <Badge variant="outline" className="border-border/60 text-muted-foreground">
                          {ignoredCount} ignored
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      Every movie & TV stream URL is probed automatically every 6 hours.
                      Broken links show here — fix, ignore, or re-check them.
                      {linkHealth?.lastCheckedAt && (
                        <span className="block">Last checked {fmtDateTime(linkHealth.lastCheckedAt)}.</span>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-4 py-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={isCheckingLinks}
                      onClick={handleCheckLinks}
                    >
                      {isCheckingLinks ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Link2 className="size-3.5" />
                      )}
                      Check all links now
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Ignored links stay tracked but never raise the alert.
                    </p>
                  </div>

                  {!linkHealth ? (
                    <div className="space-y-3 p-6">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : brokenCount === 0 && ignoredCount === 0 ? (
                    <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                      <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                        <ShieldCheck className="size-6" />
                      </span>
                      <p className="font-display text-lg font-semibold">All stream links are healthy</p>
                      <p className="max-w-sm text-sm text-muted-foreground">
                        {linkHealth.trackedCount} link{linkHealth.trackedCount === 1 ? "" : "s"} tracked.
                        Run a manual check any time to re-probe everything now.
                      </p>
                    </CardContent>
                  ) : (
                    <div className="divide-y divide-border/50">
                      {[...linkHealth.failures, ...linkHealth.ignoredFailures].map((f) => (
                        <div key={f.url} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              {f.targets.map((t, i) => (
                                <span key={`${t.kind}-${t.name}-${i}`} className="text-sm font-medium">
                                  {t.kind === "movie" && t.movieId ? (
                                    <Link
                                      to={`/movie/${t.movieId}`}
                                      className="text-primary underline-offset-2 hover:underline"
                                    >
                                      {t.name}
                                    </Link>
                                  ) : (
                                    <span>{t.name}</span>
                                  )}
                                  {i < f.targets.length - 1 ? "," : ""}
                                </span>
                              ))}
                              <Badge
                                variant="outline"
                                className={
                                  f.ignored
                                    ? "border-border/60 text-muted-foreground"
                                    : "border-destructive/50 bg-destructive/10 text-destructive"
                                }
                              >
                                {f.ignored ? "ignored" : (f.error ?? "failed")}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {fmtDateTime(f.checkedAt)}
                              </span>
                            </div>
                            <p className="mt-1 break-all font-mono text-xs text-muted-foreground" title={f.url}>
                              {f.url}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-1.5">
                            {f.targets.map((t) =>
                              t.kind === "movie" && t.movieId ? (
                                <Button
                                  key={`edit-${t.movieId}`}
                                  size="sm"
                                  variant="outline"
                                  className="gap-1.5"
                                  onClick={() => {
                                    const movie = (movies ?? []).find((m) => m._id === t.movieId);
                                    if (movie) {
                                      setEditing(movie);
                                      setDialogOpen(true);
                                    } else {
                                      toast.error("Movie not found in the catalog");
                                    }
                                  }}
                                >
                                  <Pencil className="size-3.5" />
                                  Edit
                                </Button>
                              ) : t.kind === "tv" && t.channelId ? (
                                <Button
                                  key={`edit-${t.channelId}`}
                                  size="sm"
                                  variant="outline"
                                  className="gap-1.5"
                                  onClick={() => {
                                    const ch = (tvChannels ?? []).find((c) => c._id === t.channelId);
                                    if (ch) {
                                      openEditTv(ch);
                                    } else {
                                      toast.error("Channel not found");
                                    }
                                  }}
                                >
                                  <Pencil className="size-3.5" />
                                  Edit
                                </Button>
                              ) : null,
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              onClick={() => window.open(f.url, "_blank", "noopener,noreferrer")}
                            >
                              <Link2 className="size-3.5" />
                              Open
                            </Button>
                            <Button
                              size="sm"
                              variant={f.ignored ? "secondary" : "ghost"}
                              className="gap-1.5"
                              onClick={() => toggleLinkIgnored(f.url, !f.ignored)}
                            >
                              {f.ignored ? (
                                <>
                                  <ShieldCheck className="size-3.5" />
                                  Un-ignore
                                </>
                              ) : (
                                <>
                                  <X className="size-3.5" />
                                  Ignore
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </TabsContent>

              {/* Support — help-center chat inbox */}
              <TabsContent value="support">
                <Card className="overflow-hidden p-0">
                  <CardHeader className="border-b border-border/50 py-4">
                    <CardTitle className="font-display flex flex-wrap items-center gap-2 text-lg">
                      Help center inbox
                      {(adminUnread ?? 0) > 0 && (
                        <Badge variant="outline" className="border-destructive/50 bg-destructive/10 text-destructive">
                          {adminUnread} unread
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      Messages from the floating help-center widget on the site.
                      Pick a conversation to reply — the user sees it live.
                    </CardDescription>
                  </CardHeader>

                  {!conversations ? (
                    <div className="space-y-3 p-6">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : conversations.length === 0 ? (
                    <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
                      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Headset className="size-6" />
                      </span>
                      <p className="font-display text-lg font-semibold">No conversations yet</p>
                      <p className="max-w-sm text-sm text-muted-foreground">
                        When visitors use the help-center widget (bottom-right
                        of the site), their messages appear here.
                      </p>
                    </CardContent>
                  ) : (
                    <div className="divide-y divide-border/50">
                      {conversations.map((c) => (
                        <div key={c.userId} className="px-4 py-3">
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 text-left"
                            onClick={() =>
                              setActiveThread(activeThread === c.userId ? null : c.userId)
                            }
                          >
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
                              {(c.userName ?? "G").slice(0, 1).toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-semibold">{c.userName}</span>
                                {c.isAnonymous && (
                                  <Badge variant="secondary" className="text-[10px]">guest</Badge>
                                )}
                                {c.unread > 0 && (
                                  <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-5 text-destructive-foreground">
                                    {c.unread}
                                  </span>
                                )}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {c.lastSender === "admin" ? "You: " : ""}
                                {c.lastText}
                              </span>
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {fmtDateTime(c.lastAt)}
                            </span>
                          </button>

                          {activeThread === c.userId && (
                            <div className="mt-3 rounded-lg border border-border/60 bg-background/60 p-3">
                              <div
                                ref={supportScroll}
                                className="max-h-72 space-y-2 overflow-y-auto"
                              >
                                {(thread ?? []).map((m) => (
                                  <div
                                    key={m._id}
                                    className={`group flex items-center gap-1 ${m.sender === "admin" ? "justify-end" : "justify-start"}`}
                                  >
                                    {m.sender !== "admin" && (
                                      <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                                        <button
                                          type="button"
                                          aria-label="Edit message"
                                          title="Edit"
                                          onClick={() => {
                                            setEditMsg({ id: m._id, text: m.text });
                                            setEditMsgDraft(m.text);
                                          }}
                                          className="rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                                        >
                                          <Pencil className="size-3" />
                                        </button>
                                        <button
                                          type="button"
                                          aria-label="Delete message"
                                          title="Delete"
                                          onClick={() => setDeleteMsg({ id: m._id, text: m.text })}
                                          className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        >
                                          <Trash2 className="size-3" />
                                        </button>
                                      </span>
                                    )}
                                    <div
                                      className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm ${
                                        m.sender === "admin"
                                          ? "rounded-br-md bg-primary text-primary-foreground"
                                          : "rounded-bl-md bg-muted text-foreground"
                                      }`}
                                    >
                                      {m.text}
                                    </div>
                                    {m.sender === "admin" && (
                                      <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                                        <button
                                          type="button"
                                          aria-label="Edit message"
                                          title="Edit"
                                          onClick={() => {
                                            setEditMsg({ id: m._id, text: m.text });
                                            setEditMsgDraft(m.text);
                                          }}
                                          className="rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                                        >
                                          <Pencil className="size-3" />
                                        </button>
                                        <button
                                          type="button"
                                          aria-label="Delete message"
                                          title="Delete"
                                          onClick={() => setDeleteMsg({ id: m._id, text: m.text })}
                                          className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        >
                                          <Trash2 className="size-3" />
                                        </button>
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  sendSupportReply();
                                }}
                                className="mt-3 flex items-center gap-2"
                              >
                                <Input
                                  value={supportDraft}
                                  onChange={(e) => setSupportDraft(e.target.value)}
                                  placeholder="Reply as admin…"
                                  maxLength={1000}
                                />
                                <Button
                                  type="submit"
                                  size="icon"
                                  className="size-10 shrink-0"
                                  disabled={isReplying || !supportDraft.trim()}
                                >
                                  {isReplying ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <Send className="size-4" />
                                  )}
                                </Button>
                              </form>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {/* Edit message dialog (admin can edit any message) */}
                <Dialog open={!!editMsg} onOpenChange={(o) => !o && setEditMsg(null)}>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Edit message</DialogTitle>
                      <DialogDescription>
                        Your change is visible to the user immediately.
                      </DialogDescription>
                    </DialogHeader>
                    <Textarea
                      value={editMsgDraft}
                      onChange={(e) => setEditMsgDraft(e.target.value)}
                      maxLength={1000}
                      rows={4}
                    />
                    <DialogFooter className="gap-2 sm:gap-0">
                      <Button variant="outline" onClick={() => setEditMsg(null)}>
                        Cancel
                      </Button>
                      <Button
                        onClick={saveSupportEdit}
                        disabled={isEditSaving || !editMsgDraft.trim()}
                      >
                        {isEditSaving ? <Loader2 className="size-4 animate-spin" /> : null}
                        Save
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Delete message confirm (admin can delete any message) */}
                <AlertDialog
                  open={!!deleteMsg}
                  onOpenChange={(o) => !o && setDeleteMsg(null)}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this message?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {`"${deleteMsg?.text.slice(0, 160) ?? ""}"`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={(e) => {
                          e.preventDefault();
                          void confirmSupportDelete();
                        }}
                        className="bg-destructive text-white hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>

      {/* Edit TV channel dialog */}
      <Dialog
        open={editingTv !== null}
        onOpenChange={(o) => {
          if (!o) setEditingTv(null);
        }}
      >
        <DialogContent className="max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-md overflow-y-auto rounded-xl sm:w-full">
          <DialogHeader>
            <DialogTitle className="font-display">Edit channel</DialogTitle>
            <DialogDescription>
              Update the name, logo, stream URL, categories, or display order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="tv-edit-name" className="text-xs font-medium text-muted-foreground">
                Channel name
              </label>
              <Input
                id="tv-edit-name"
                value={editTvName}
                onChange={(e) => setEditTvName(e.target.value)}
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tv-edit-logo" className="text-xs font-medium text-muted-foreground">
                Logo URL (optional)
              </label>
              <Input
                id="tv-edit-logo"
                value={editTvLogo}
                onChange={(e) => setEditTvLogo(e.target.value)}
                placeholder="https://…/logo.png"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tv-edit-url" className="text-xs font-medium text-muted-foreground">
                Stream URL
              </label>
              <Input
                id="tv-edit-url"
                value={editTvUrl}
                onChange={(e) => setEditTvUrl(e.target.value)}
                placeholder="https://…/stream.m3u8"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tv-edit-backups" className="text-xs font-medium text-muted-foreground">
                Backup URLs (one per line) — used when the primary stream is down
              </label>
              <textarea
                id="tv-edit-backups"
                value={editTvBackups}
                onChange={(e) => setEditTvBackups(e.target.value)}
                placeholder={"https://…/backup-1.m3u8 | https://…/backup-2.m3u8"}
                rows={2}
                className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <RelayUrlHelper
              channelName={editTvName}
              suggestLocalUrl={editTvUrl}
              onUsePublic={setEditTvUrl}
              onAddBackup={(u) =>
                setEditTvBackups((b) => (b.trim() ? `${b.trimEnd()}\n${u}` : u))
              }
            />
            <div className="space-y-1.5">
              <label htmlFor="tv-edit-categories" className="text-xs font-medium text-muted-foreground">
                Categories (comma-separated)
              </label>
              <Input
                id="tv-edit-categories"
                value={editTvCategories}
                onChange={(e) => setEditTvCategories(e.target.value)}
                placeholder="Sports, Bangla, News"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tv-edit-order" className="text-xs font-medium text-muted-foreground">
                Display order (optional, lower numbers first)
              </label>
              <Input
                id="tv-edit-order"
                type="number"
                value={editTvOrder}
                onChange={(e) => setEditTvOrder(e.target.value)}
                placeholder="e.g. 1"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setEditingTv(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isSavingTv || !editTvName.trim() || !editTvUrl.trim()}
              onClick={handleSaveTv}
            >
              {isSavingTv && <Loader2 className="size-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
