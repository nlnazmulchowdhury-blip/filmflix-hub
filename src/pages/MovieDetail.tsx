import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Logo from "@/components/Logo";
import PlayerStage from "@/components/PlayerStage";
import EpisodeList, { type EpisodeRow } from "@/components/EpisodeList";
import VidSrcResultCard from "@/components/VidSrcResultCard";
import ThemeToggle from "@/components/ThemeToggle";
import { useMiniPlayer } from "@/components/mini-player-context";
import {
  recallExternalHint,
  rememberExternalHint,
  episodeEmbedUrl,
  vaplayerEmbedUrl,
} from "@/lib/vaplayer";
import { fetchTitleDownloads } from "@/lib/embed-resolver";
import { isSavedTitle, toggleSavedTitle } from "@/lib/saved-titles";
import {
  listRelated,
  listSeason,
  type TmdbItem,
  type TvSeasonOption,
  type TvSeasonPayload,
} from "@/lib/tmdb";
import { convexSiteUrl, downloadFileUrl } from "@/lib/video-url";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CalendarPlus,
  Download,
  Loader2,
  Play,
  Star,
  Search,
  Share2,
  Calendar,
  Heart,
  ListVideo,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
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
  const location = useLocation();
  const { movie: miniMovie, isActive: miniActive, start } = useMiniPlayer();
  const isVidSrc = id?.startsWith("vidsrc-") ?? false;
  const vidsrcImdbId = isVidSrc ? id?.replace("vidsrc-", "") : null;
  const isVaplayer = id?.startsWith("vaplayer-") ?? false;
  const vaplayerId = isVaplayer ? id?.replace("vaplayer-", "") : null;
  const isExternal = isVidSrc || isVaplayer;
  const externalStateFromClick = (location.state as any) || null;
  /* A refreshed deep link has no router state left, so fall back to what the
     card remembered for this tab. */
  const externalState = externalStateFromClick?.external
    ? externalStateFromClick
    : {
        ...(recallExternalHint(vaplayerId ?? vidsrcImdbId) || {}),
        ...externalStateFromClick,
      };
  const movie = useQuery(
    api.movies.get,
    isExternal ? "skip" : { id: id as Id<"movies"> },
  );

  /* The header search only collects a term — the catalog, the suggestions and
     the external lookup all live on Landing, so submitting hands the term over
     as `?q=` instead of rebuilding a second search here. */
  const [headerQuery, setHeaderQuery] = useState("");


  const scheduleScreening = useMutation(api.screenings.schedule);
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [isScheduling, setIsScheduling] = useState(false);

  /* Watchlist: saved-for-later toggle. */
  const inWatchlist = useQuery(
    api.watchlist.hasMovie,
    !isVidSrc && movie ? { movieId: movie._id } : "skip",
  );
  const addToWatchlist = useMutation(api.watchlist.add);
  const removeFromWatchlist = useMutation(api.watchlist.remove);
  const [isTogglingWatchlist, setIsTogglingWatchlist] = useState(false);

  const toggleWatchlist = async () => {
    if (!movie || isVidSrc) return;
    setIsTogglingWatchlist(true);
    try {
      if (inWatchlist) {
        await removeFromWatchlist({ movieId: movie._id });
        toast.success("Removed from your watchlist");
      } else {
        await addToWatchlist({ movieId: movie._id });
        toast.success("Saved to your watchlist");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsTogglingWatchlist(false);
    }
  };

  /* Register this movie with the persistent player as soon as it loads:
     - fresh visit → poster overlay (no autoplay)
     - returning from miniplayer → playback continues seamlessly */
  useEffect(() => {
    if (isVidSrc && vidsrcImdbId) {
      const titleExt = externalState.title || `tt${vidsrcImdbId}`;
      start(
        {
          movieId: `vidsrc:${vidsrcImdbId}`,
          title: titleExt,
          videoUrl: "",
          posterUrl: externalState.posterUrl,
          backdropUrl: undefined,
          dubs: [],
          qualities: [],
          subtitles: [],
          imdbId: vidsrcImdbId,
          kind: externalState.kind || "movie",
        } as any,
        false,
      );
      return;
    }
    if (isVaplayer && vaplayerId) {
      const kind = externalState.kind === "series" ? "series" : "movie";
      start(
        {
          movieId: `vaplayer:${vaplayerId}`,
          title: externalState.title || "External",
          /* videoUrl is the provider embed page → PlayerStage detects it via
             isEmbedUrl() and routes through the ad-free embed server. */
          videoUrl:
            externalState.embedUrl ||
            vaplayerEmbedUrl({ tmdbId: vaplayerId, kind }),
          posterUrl: externalState.posterUrl,
          backdropUrl: externalState.backdropUrl,
          dubs: [],
          qualities: [],
          subtitles: [],
          tmdbId: vaplayerId,
          kind,
        } as any,
        false,
      );
      return;
    }
    if (!movie) return;
    if (miniActive && miniMovie?.movieId === movie._id) return; // already playing
    start(
      {
        movieId: movie._id,
        title: movie.title,
        videoUrl: movie.videoUrl ?? "",
        posterUrl: movie.posterUrl,
        backdropUrl: movie.backdropUrl,
        dubs: movie.dubs ?? [],
        qualities: movie.qualities ?? [],
        subtitles: movie.subtitles ?? [],
        imdbId: movie.imdbId,
        tmdbId: movie.tmdbId,
        kind: movie.kind,
      } as any,
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie?._id, isVidSrc, vidsrcImdbId, isVaplayer, vaplayerId]);

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

  const defaultWhen = toLocalInputValue(Date.now() + 24 * 60 * 60 * 1000);

  /* Download menu: admin-added per-quality links. Falls back to the main
     video URL when no explicit download links exist. */
  const downloadOptions = movie
    ? (movie.downloads ?? []).filter((d: any) => d.url)
    : [];

  /* -------- "More videos" under the player ------------------------------ */
  /* Titles related to this one, scraped keyless from the embed source's own
     watch page (its "You may also like" grid). Needs a TMDB id — available
     for vaplayer titles and catalog entries that carry one. */
  const relatedTmdbId: string | null =
    vaplayerId ?? ((movie as any)?.tmdbId as string | undefined) ?? null;
  const [related, setRelated] = useState<TmdbItem[]>([]);
  useEffect(() => {
    if (!relatedTmdbId) {
      setRelated([]);
      return;
    }
    let cancelled = false;
    listRelated(relatedTmdbId)
      .then((r) => {
        if (!cancelled) setRelated(r);
      })
      .catch(() => {
        if (!cancelled) setRelated([]);
      });
    return () => {
      cancelled = true;
    };
  }, [relatedTmdbId]);

  const playRelated = (item: TmdbItem) => {
    const state = {
      external: "vaplayer",
      tmdbId: item.tmdbId,
      kind: item.kind,
      title: item.title,
      posterUrl: item.posterUrl ?? undefined,
      backdropUrl: item.backdropUrl ?? undefined,
      overview: item.overview,
      embedUrl: item.embedUrl,
    };
    rememberExternalHint(item.tmdbId, state);
    navigate(`/movie/vaplayer-${item.tmdbId}`, { state });
  };

  /* Clicking a quality must start a file download, not open a tab that plays
     the movie. Direct CDN links can't do that: they serve `video/mp4` with no
     `Content-Disposition` and browsers ignore the `download` attribute on
     cross-origin URLs. So the link points at the proxy with `&download=1`
     (which answers `attachment`), and we probe a single byte first — if the
     proxy can't reach that host, fall back to opening the direct link instead
     of leaving an error page in this tab. */
  const handleDownload = async (e: ReactMouseEvent<HTMLAnchorElement>, directUrl: string) => {
    e.preventDefault();
    const href = e.currentTarget.href;
    if (!href || href === directUrl) {
      window.open(directUrl, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const res = await fetch(href, {
        headers: { Range: "bytes=0-1" },
        signal: AbortSignal.timeout(8000),
      });
      void res.body?.cancel();
      if (res.ok) {
        // `attachment` makes the browser save the file and stay on this page.
        window.location.assign(href);
        return;
      }
    } catch {
      // Proxy unreachable from the cloud for this host — fall through.
    }
    toast.error("ডাউনলোড শুরু করা গেল না — ভিডিও নতুন টেবে খুলছে");
    window.open(directUrl, "_blank", "noopener,noreferrer");
  };

  /* Episode the stage is on. Providers address a series episode by
     season + episode, so this pair is what selects the stream. */
  const [season, setSeason] = useState(() =>
    Math.max(1, Number((location.state as any)?.season) || 1),
  );
  const [episode, setEpisode] = useState(() =>
    Math.max(1, Number((location.state as any)?.episode) || 1),
  );

  /* Share: native sheet on phones (WhatsApp/Messenger/etc.), clipboard
     fallback everywhere else. */
  const shareMovie = async () => {
    if (!movie) return;
    const url = window.location.href;
    const text = `Watch “${movie.title}” on FilmFlix`;
    try {
      if (navigator.share) {
        await navigator.share({ title: movie.title, text, url });
        return;
      }
    } catch {
      return; // user closed the share sheet
    }
    try {
      await navigator.clipboard.writeText(`${text} — ${url}`);
      toast.success("Link copied — paste it anywhere to share");
    } catch {
      toast.error("Could not copy the link");
    }
  };

  const externalMovie = isVidSrc
    ? {
        _id: `vidsrc:${vidsrcImdbId}` as any,
        title: externalState.title || vidsrcImdbId || "External",
        posterUrl: externalState.posterUrl || null,
        backdropUrl: null,
        year: null,
        description: "This title is from external search (Server 1 — VidSrc).",
        kind: (externalState.kind as any) || "movie",
        category: "External",
        genres: [],
        videoUrl: "",
        dubs: [],
        qualities: [],
        subtitles: [],
        episodes: [],
        downloads: [],
        imdbId: vidsrcImdbId,
        tmdbId: null,
      }
    : isVaplayer
      ? {
          _id: `vaplayer:${vaplayerId}` as any,
          title: externalState.title || "External",
          posterUrl: externalState.posterUrl || null,
          backdropUrl: externalState.backdropUrl || null,
          year: null,
          description:
            externalState.overview ||
            "This title is from the full IMDB/TMDB catalog (Server 2 — embed).",
          kind: (externalState.kind as any) || "movie",
          category: "External",
          genres: [],
          /* The provider embed page — PlayerStage resolves it to an ad-free
             stream, falling back to the provider iframe. */
          videoUrl:
            externalState.embedUrl ||
            vaplayerEmbedUrl({ tmdbId: vaplayerId, kind: externalState.kind }),
          dubs: [],
          qualities: [],
          subtitles: [],
          episodes: [],
          downloads: [],
          imdbId: null,
          tmdbId: vaplayerId,
        }
      : (movie as any);

  /* -------- The Save chip under the player ------------------------------- */
  /* A catalog row goes to the real, server-side watchlist. A provider title has
     no row to hang a save on — the watchlist query joins `movies` and would
     silently drop it — so that one keeps its list on this device. */
  const [savedBump, setSavedBump] = useState(0);
  const saveKey = ((externalMovie as any)?._id as string) ?? "";
  const isSaved = useMemo(
    () =>
      movie
        ? Boolean(inWatchlist)
        : saveKey
          ? isSavedTitle(saveKey)
          : false,
    [movie, inWatchlist, saveKey, savedBump],
  );
  const toggleSave = () => {
    if (movie) {
      void toggleWatchlist();
      return;
    }
    if (!saveKey || !externalMovie) return;
    const now = toggleSavedTitle({
      key: saveKey,
      title: externalMovie.title,
      posterUrl: externalMovie.posterUrl ?? null,
      kind: externalMovie.kind === "series" ? "series" : "movie",
      tmdbId: ((externalMovie as any).tmdbId as string) ?? null,
    });
    setSavedBump((n) => n + 1);
    toast.success(now ? "Saved — find it under your saved titles" : "Removed from saved");
  };

  /* -------- Episodes under the player ----------------------------------- */
  /* Two sources for one list:
       • the admin's own episode files (D1 `episodes`) — real uploads, played
         straight from our own CDN;
       • otherwise the external season guide (Worker `/tmdb/tv`: TMDB when a
         key is configured, TVMaze keyless today). Those rows carry no file:
         picking one re-points the embed server at that season + episode. */
  const showTitle: string = externalMovie?.title || "";

  const [guide, setGuide] = useState<TvSeasonPayload | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);

  /* The guide knows both ids for the show even when this page arrived with
     only one (a VidSrc link, or an admin row with no tmdbId) — and the ad-free
     providers need the numeric TMDB one, so the ids travel back out of it. */
  const guideTmdbId = /^\d+$/.test(String(guide?.tmdbId ?? ""))
    ? (guide?.tmdbId as string)
    : null;
  const seriesTmdbId: string | null =
    vaplayerId ?? ((movie as any)?.tmdbId as string | undefined) ?? guideTmdbId ?? null;
  const seriesImdbId: string | null =
    vidsrcImdbId ??
    ((movie as any)?.imdbId as string | undefined) ??
    (guide?.imdbId as string | undefined) ??
    null;
  const isSeries = externalMovie?.kind === "series";
  const localEpisodes = ((movie as any)?.episodes ?? []) as any[];
  const hasLocalEpisodes = localEpisodes.length > 0;
  const useGuide = isSeries && !hasLocalEpisodes;

  useEffect(() => {
    if (!useGuide || (!seriesTmdbId && !showTitle)) {
      setGuide(null);
      return;
    }
    let cancelled = false;
    setGuideLoading(true);
    listSeason({
      tmdbId: seriesTmdbId,
      title: showTitle,
      imdbId: seriesImdbId,
      season,
    })
      .then((g) => {
        if (!cancelled) setGuide(g);
      })
      .catch(() => {
        if (!cancelled) setGuide(null);
      })
      .finally(() => {
        if (!cancelled) setGuideLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [useGuide, seriesTmdbId, seriesImdbId, showTitle, season]);

  const seasonOptions: TvSeasonOption[] = hasLocalEpisodes
    ? [{ season: 1, name: "Episodes", episodeCount: localEpisodes.length }]
    : (guide?.seasons ?? []);

  const episodeRows: EpisodeRow[] = hasLocalEpisodes
    ? localEpisodes.map((e: any, i: number) => ({
        key: `local-${i}`,
        episode: Number(e.episode) || i + 1,
        title: e.title || `Episode ${i + 1}`,
        overview: e.overview ?? "",
        stillUrl: e.stillUrl ?? null,
        runtimeSec: e.durationSec ?? null,
        airDate: e.airDate ?? null,
        videoUrl: e.videoUrl ?? null,
      }))
    : (guide?.episodes ?? []).map((e) => ({
        key: `s${season}e${e.episode}`,
        episode: e.episode,
        title: e.name,
        overview: e.overview,
        stillUrl: e.stillUrl ?? null,
        runtimeSec: e.runtimeSec ?? null,
        airDate: e.airDate ?? null,
      }));

  /* The provider page of whatever the stage is on. Changing this is what
     swaps the episode: PlayerStage feeds it to the embed resolver and the
     provider iframe. */
  const episodeEmbed =
    useGuide && (seriesTmdbId || seriesImdbId)
      ? episodeEmbedUrl({
          tmdbId: seriesTmdbId,
          imdbId: seriesImdbId,
          kind: "series",
          season,
          episode,
        })
      : "";

  const activeEpisodeKey = hasLocalEpisodes
    ? (episodeRows.find((r) => r.videoUrl && r.videoUrl === miniMovie?.videoUrl)
        ?.key ?? null)
    : `s${season}e${episode}`;

  const activeIndex = episodeRows.findIndex((r) => r.key === activeEpisodeKey);
  const nextEpisode =
    activeIndex >= 0 ? episodeRows[activeIndex + 1] : episodeRows[0];

  const playEpisode = (row: EpisodeRow) => {
    if (row.videoUrl && movie) {
      setEpisode(row.episode);
      start(
        {
          movieId: movie._id,
          title: `${showTitle} — ${row.title}`,
          videoUrl: row.videoUrl,
          posterUrl: movie.posterUrl,
          backdropUrl: movie.backdropUrl,
          dubs: movie.dubs ?? [],
          qualities: movie.qualities ?? [],
          subtitles: movie.subtitles ?? [],
        } as any,
        true,
      );
      return;
    }
    const url = episodeEmbedUrl({
      tmdbId: seriesTmdbId,
      imdbId: seriesImdbId,
      kind: "series",
      season,
      episode: row.episode,
    });
    if (!url) {
      toast.error("এই এপিসোডের কোনো সোর্স পাওয়া যায়নি");
      return;
    }
    setEpisode(row.episode);
    start(
      {
        movieId: (externalMovie as any)?._id,
        title: `${showTitle} — S${season}E${row.episode}`,
        videoUrl: url,
        posterUrl: row.stillUrl ?? externalMovie?.posterUrl ?? null,
        backdropUrl: externalMovie?.backdropUrl ?? null,
        dubs: [],
        qualities: [],
        subtitles: [],
        tmdbId: seriesTmdbId,
        kind: "series",
        season,
        episode: row.episode,
      } as any,
      true,
    );
  };

  /* Per-episode download: our own file when the admin uploaded one, else ask
     the Worker to extract this episode's stream from the ad-free providers. */
  const downloadEpisode = async (row: EpisodeRow) => {
    if (row.videoUrl) {
      window.location.assign(
        downloadFileUrl(row.videoUrl, convexSiteUrl(), `${showTitle} - ${row.title}`),
      );
      return;
    }
    if (!seriesTmdbId && !seriesImdbId) {
      toast.error("এই এপিসোডের ডাউনলোড লিংক পাওয়া যায়নি");
      return;
    }
    toast("ডাউনলোড লিংক খোঁজা হচ্ছে…");
    try {
      const providers = await fetchTitleDownloads({
        tmdbId: seriesTmdbId,
        imdbId: seriesImdbId,
        kind: "series",
        season,
        episode: row.episode,
      });
      const file = providers.flatMap((p) => p.entries).find((e) => e.url);
      if (!file) {
        toast.error("এই এপিসোডের ডাউনলোড লিংক পাওয়া যায়নি");
        return;
      }
      window.location.assign(
        downloadFileUrl(
          file.url,
          convexSiteUrl(),
          `${showTitle} - S${season}E${row.episode} - ${file.label}`,
        ),
      );
    } catch {
      toast.error("ডাউনলোড শুরু করা গেল না");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-2 px-3 sm:px-6">
          <Link to="/" aria-label="FilmFlix home" className="shrink-0">
            <Logo />
          </Link>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const q = headerQuery.trim();
              if (q) navigate(`/?q=${encodeURIComponent(q)}`);
            }}
            className="hidden min-w-0 flex-1 items-center gap-2 px-2 md:flex"
          >
            <div className="relative min-w-0 max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={headerQuery}
                onChange={(e) => setHeaderQuery(e.target.value)}
                placeholder="Search movies…"
                aria-label="Search movies"
                autoComplete="off"
                className="h-9 rounded-xl bg-card/70 pl-9"
              />
            </div>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="shrink-0 gap-1.5 px-3 text-muted-foreground hover:text-foreground"
              aria-label="Search"
            >
              <Search className="size-4" />
              <span className="hidden lg:inline">Search</span>
            </Button>
          </form>
          <div className="flex items-center gap-1 sm:gap-2">
            {/* Phones keep every control in this cluster, so the search is an
                icon here that focuses Landing's own box. */}
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground md:hidden"
              aria-label="Search"
              title="Search"
            >
              <Link to="/?focus=search">
                <Search className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link to="/">
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">Back to catalog</span>
                <span className="sm:hidden">Back</span>
              </Link>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-3 pb-24 pt-4 sm:px-6 sm:pt-8">
        {!externalMovie ? (
          <div className="space-y-6">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
        ) : (
          <div className="space-y-10">
            {/* Persistent player stage */}
            <PlayerStage
              movieId={(externalMovie as any)._id}
              videoUrl={episodeEmbed || ((externalMovie as any).videoUrl ?? "")}
              title={externalMovie.title}
              posterUrl={externalMovie.posterUrl}
              backdropUrl={externalMovie.backdropUrl}
              imdbId={(isVidSrc ? vidsrcImdbId : (externalMovie as any).imdbId) || undefined}
              /* The guide's TMDB id still counts: VidSrc keeps the IMDb id it
                 prefers, but the ad-free providers can only be asked with the
                 numeric one, and this is where a deep link learns it. */
              tmdbId={((externalMovie as any).tmdbId as string) || guideTmdbId || undefined}
              kind={(isVidSrc ? (externalState.kind || "movie") : (externalMovie as any).kind) as any}
              season={season}
              episode={episode}
              disabledServers={(externalMovie as any).disabledServers}
              defaultServer={(externalMovie as any).defaultServer}
              providerEmbedUrl={
                isVidSrc ? undefined : episodeEmbed || (externalMovie as any).embedUrl
              }
              saved={isSaved}
              onToggleSave={toggleSave}
            />

            {/* More videos — titles related to this one from the embed catalog. */}
            {related.length > 0 && (
              <section aria-label="More videos">
                <h2 className="font-display flex items-center gap-2 text-lg font-bold tracking-tight">
                  <ListVideo className="size-5 text-primary" />
                  More videos
                  <span className="text-sm font-medium text-muted-foreground">
                    ({related.length})
                  </span>
                </h2>
                <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
                  {related.map((item, i) => (
                    <VidSrcResultCard
                      key={`${item.kind}-${item.tmdbId}`}
                      hit={{
                        imdbId: `tmdb-${item.tmdbId}`,
                        title: item.title,
                        year: item.year,
                        kind: item.kind,
                        posterUrl: item.posterUrl ?? undefined,
                      }}
                      index={i}
                      onPlay={() => playRelated(item)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Episodes of what you're watching */}
            {(isSeries || hasLocalEpisodes) &&
              (episodeRows.length > 0 || guideLoading) && (
                <EpisodeList
                  rows={episodeRows}
                  seasons={seasonOptions}
                  season={season}
                  seasonName={guide?.seasonName}
                  activeKey={activeEpisodeKey}
                  loading={guideLoading && episodeRows.length === 0}
                  canGoNext={Boolean(nextEpisode)}
                  onSeason={(s) => {
                    setSeason(s);
                    setEpisode(1);
                  }}
                  onPlay={playEpisode}
                  onNext={() => nextEpisode && playEpisode(nextEpisode)}
                  /* Per-row download only for files we actually host: the
                     embed providers still cannot yield a direct episode
                     stream, so an icon that always failed would lie. */
                  onDownload={hasLocalEpisodes ? (row) => void downloadEpisode(row) : undefined}
                />
              )}

            {/* Meta — catalog entries only; external (vidsrc/vaplayer) titles
                show just the player + playlist. */}
            {movie && (
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

                  {/* Watchlist toggle + share */}
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={isTogglingWatchlist}
                      onClick={() => {
                        if (!isAuthenticated) {
                          navigate(
                            `/auth?returnTo=${encodeURIComponent(`/movie/${movie._id}`)}`,
                          );
                          return;
                        }
                        toggleWatchlist();
                      }}
                      aria-pressed={inWatchlist}
                      title={
                        inWatchlist
                          ? "Remove from your watchlist"
                          : "Save to your watchlist"
                      }
                    >
                      <Heart
                        className={`size-3.5 ${
                          inWatchlist ? "fill-primary text-primary" : ""
                        }`}
                      />
                      {inWatchlist ? "Saved" : "Watchlist"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={shareMovie}
                    >
                      <Share2 className="size-3.5" />
                      Share
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
                    {movie.title}
                  </h1>
                  {downloadOptions.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button className="gap-2" size="sm">
                          <Download className="size-4" />
                          Download
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-48">
                        <DropdownMenuLabel>কোয়ালিটি বাছুন</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {downloadOptions.map((d: any) => (
                          <DropdownMenuItem key={d.label + d.url} asChild>
                            <a
                              href={downloadFileUrl(
                                d.url,
                                convexSiteUrl(),
                                `${movie.title} - ${d.label}`,
                              )}
                              download
                              onClick={(e) => void handleDownload(e, d.url)}
                              className="flex w-full cursor-pointer items-center justify-between"
                            >
                              <span>{d.label}</span>
                              <Download className="size-3.5 opacity-60" />
                            </a>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
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
            )}
          </div>
        )}
      </main>
    </div>
  );
}
