import { useMiniPlayer } from "@/components/mini-player-context";
import { vidsrcEmbedUrl } from "@/lib/vidsrc";
import { animeEmbedUrl, dramaEmbedUrl } from "@/lib/autoembed";
import {
  isEmbedUrl,
  resolveEmbedStream,
  fetchEmbedQualities,
  fetchTitleDownloads,
  type EmbedCandidate,
  type TitleDownloadProvider,
} from "@/lib/embed-resolver";
import { downloadHls, proxyUrl, saveBlob, isHlsLink } from "@/lib/hls-download";
import {
  setSnifferReferer,
  useSniffedStreams,
  type SniffedStream,
} from "@/lib/media-sniffer";
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Download,
  Gauge,
  Languages,
  Link2,
  Loader2,
  Maximize,
  Minimize,
  Moon,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Server,
  Settings,
  Share2,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";

function formatTime(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Inline home of the persistent video while the user is on the movie page.
 * Registers its slot with the MiniPlayerProvider; the provider portals the
 * single video element in here. In mini mode it shows a bring-back panel.
 */
export default function PlayerStage({
  movieId,
  videoUrl,
  title,
  posterUrl,
  backdropUrl,
  imdbId,
  tmdbId,
  kind,
  season,
  episode,
}: {
  movieId: string;
  videoUrl: string;
  title: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  /** External IDs used to build the VidSrc "Server 1" embed URL. */
  imdbId?: string | null;
  tmdbId?: string | null;
  kind?: "movie" | "series" | null;
  /** Season/episode for series embeds (defaults to 1/1). */
  season?: number;
  episode?: number;
}) {
  const {
    movie,
    mode,
    isActive,
    hasStarted,
    playing,
    muted,
    volume,
    currentTime,
    duration,
    bufferedEnd,
    controlsOverlayVisible,
    setControlsOverlayVisible,
    setControlsHold,
    bumpControlsActivity,
    activeDub,
    setDub,
    nightMode,
    setNightMode,
    loop,
    setLoop,
    rotation,
    setRotation,
    playbackRate,
    setPlaybackRate,
    activeQuality,
    setQuality,
    activeSubtitle,
    setSubtitle,
    registerStage,
    start,
    setMode,
    close,
    controls,
  } = useMiniPlayer();

  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Cursor is over the control bar — keep the bar up while it is. */
  const [hoveringControls, setHoveringControls] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrubbingRef = useRef(false);
  const scrubRef = useRef<HTMLDivElement | null>(null);

  /* The overlay is visible when the provider says so (mouse hover inside
     the surface or a recent tap), when the cursor rests on the control bar,
     or whenever playback is not running (paused/never started). */
  const controlsVisible =
    controlsOverlayVisible || hoveringControls || !playing || !hasStarted;
  const [settingsView, setSettingsView] = useState<
    "main" | "subtitles" | "speed" | "quality"
  >("main");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dubs = movie?.dubs ?? [];
  const qualities = movie?.qualities ?? [];
  const subtitles = movie?.subtitles ?? [];

  /* -------- Playback server: stored file vs VidSrc "Server 1" -------- */
  const vidsrcUrl = vidsrcEmbedUrl({ imdbId, tmdbId, kind, season, episode });
  /* A stored URL that is actually a provider player page (vidapi.ru,
     vidbox.wtf, …) — it goes through the embed resolver, never to <video>. */
  const embedSource = isEmbedUrl(videoUrl) ? videoUrl : "";
  const hasNativeSource =
    (Boolean(videoUrl) && !embedSource) || dubs.length > 0 || qualities.length > 0;
  /* Default to Server 1 only when there is no stored file to play — so the
     API-backed embed auto-plays for catalog entries without a local source,
     while existing files keep their native player (quality/dub/subtitles). */
  const [server, setServer] = useState<
    "original" | "vidsrc" | "embed" | "anime" | "drama"
  >(
    embedSource ? "embed" : vidsrcUrl && !videoUrl ? "vidsrc" : "original",
  );
  const [serverOpen, setServerOpen] = useState(false);
  const usingVidSrc = server === "vidsrc" && Boolean(vidsrcUrl);
  const usingEmbed = server === "embed";

  /* -------- Episode servers: 3 = Anime (VidNest), 4 = Drama (Videasy) -------- */
  const [aeEpisode, setAeEpisode] = useState(episode ?? 1);
  const usingAutoembed = server === "anime" || server === "drama";
  const autoembedUrl =
    server === "anime"
      ? animeEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
      : server === "drama"
        ? dramaEmbedUrl({ tmdbId, kind, season, episode: aeEpisode })
        : "";
  /* The URL of whichever full-cover iframe server is active ("" = none). */
  const iframeServerUrl = (usingVidSrc ? vidsrcUrl : autoembedUrl) ?? "";

  /* Numbered server list — 1, 2, 3… in menu order. */
  const servers: { key: string; label: string; sub?: string }[] = [];
  let serverNo = 0;
  if (vidsrcUrl)
    servers.push({ key: "vidsrc", label: `Server ${++serverNo}`, sub: "VidSrc · vidsrc.to" });
  servers.push({
    key: "embed",
    label: `Server ${++serverNo}`,
    sub: "vidbox/vidapi · ad-free",
  });
  /* Anime/Drama episode servers key off the TMDB id — only offer them when
     the current title actually has one. */
  if (tmdbId) {
    servers.push({ key: "anime", label: `Server ${++serverNo}`, sub: "Anime · VidNest" });
    servers.push({ key: "drama", label: `Server ${++serverNo}`, sub: "Drama · Videasy" });
  }
  if (hasNativeSource)
    servers.push({
      key: "original",
      label: `Server ${++serverNo}`,
      sub: "This site's file",
    });

  /* -------- Embed resolver ("Server 2"): provider page → raw HLS stream ---- */
  const [embedUrl, setEmbedUrl] = useState(embedSource);
  const [embedStatus, setEmbedStatus] = useState<
    "idle" | "resolving" | "ready" | "failed"
  >("idle");
  const [embedCandidates, setEmbedCandidates] = useState<EmbedCandidate[]>([]);
  const [embedError, setEmbedError] = useState("");
  const [embedIframe, setEmbedIframe] = useState(false);
  const [embedStream, setEmbedStream] = useState<string | null>(null);
  const [embedPanelOpen, setEmbedPanelOpen] = useState(false);

  /* -------- Download menu: this site's files + the resolved stream's
      resolutions (asked from the Worker when the menu opens). -------- */
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadFiles: { label: string; url: string }[] = [];
  if (videoUrl && !embedSource)
    downloadFiles.push({ label: "Main file", url: videoUrl });
  for (const q of qualities)
    if (q.videoUrl) downloadFiles.push({ label: q.label, url: q.videoUrl });
  const streamProbeUrl = embedStream || embedCandidates[0]?.url || "";

  const playEmbedCandidate = useCallback(
    (c: EmbedCandidate) => {
      setEmbedStream(c.url);
      setEmbedPanelOpen(false);
      setEmbedIframe(false);
      start({ movieId, title, videoUrl: c.url, posterUrl, backdropUrl }, true);
    },
    [start, movieId, title, posterUrl, backdropUrl],
  );

  const runEmbedResolve = useCallback(
    async (url: string) => {
      const target = url.trim();
      if (!target) {
        setEmbedStatus("failed");
        setEmbedError("No embed URL yet — paste one above.");
        return;
      }
      setEmbedStatus("resolving");
      setEmbedError("");
      setEmbedIframe(false);
      try {
        const r = await resolveEmbedStream(target);
        setEmbedCandidates(r.candidates ?? []);
        if (r.candidates?.length) {
          setEmbedStatus("ready");
          playEmbedCandidate(r.candidates[0]);
        } else {
          setEmbedStatus("failed");
          setEmbedError(
            r.error ||
              "No stream found — this provider hides it behind a browser check. Falling back to the provider iframe.",
          );
          setEmbedIframe(true);
        }
      } catch {
        setEmbedStatus("failed");
        setEmbedError("Resolver request failed. Falling back to the provider iframe.");
        setEmbedIframe(true);
      }
    },
    [playEmbedCandidate],
  );

  /* Stored URL is an embed page: resolve it as soon as the stage mounts. */
  useEffect(() => {
    if (embedSource) void runEmbedResolve(embedSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedSource]);

  const selectServer = (key: string) => {
    const next: "original" | "vidsrc" | "embed" | "anime" | "drama" =
      key === "embed"
        ? "embed"
        : key === "vidsrc"
          ? "vidsrc"
          : key === "anime"
            ? "anime"
            : key === "drama"
              ? "drama"
              : "original";
    if (next === "original" && embedStream) {
      setEmbedStream(null);
      start(
        { movieId, title, videoUrl: embedSource ? "" : videoUrl, posterUrl, backdropUrl },
        true,
      );
    }
    setServer(next);
    if (next === "embed") {
      setEmbedPanelOpen(true);
      if (embedStatus === "idle") void runEmbedResolve(embedUrl || embedSource);
    }
    bumpControlsActivity();
  };

  /* When an iframe server (VidSrc / autoembed / embed fallback) takes over,
     pause the native file so the two never output audio at once. */
  useEffect(() => {
    if (
      (usingVidSrc || usingAutoembed || (usingEmbed && embedIframe)) &&
      playing
    )
      controls.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingVidSrc, usingAutoembed, usingEmbed, embedIframe, playing]);

  const isHost = isActive && mode === "inline";

  /* Register this stage as the portal slot whenever the host container
     mounts/unmounts (callback ref — fires on every branch switch). */
  const containerCallback = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      registerStage(el);
    },
    [registerStage],
  );

  useEffect(() => {
    const onFsChange = () => {
      const fsDoc = document as Document & { webkitFullscreenElement?: Element | null };
      setFullscreen(Boolean(document.fullscreenElement || fsDoc.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  /* Auto-hide lives in the provider (shared with the mini card). Here we
     only hold it open while a menu is open. */
  useEffect(() => {
    setControlsHold(langOpen || settingsOpen || serverOpen);
  }, [langOpen, settingsOpen, serverOpen, setControlsHold]);

  /* Native pointerleave on the whole player box (video + control bar):
     when the mouse leaves the player, hide the controls immediately.
     (React synthetic pointer events proved unreliable here.) */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof PointerEvent === "undefined") return;
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setHoveringControls(false);
      if (!playing) return; /* paused/never started: always show */
      setControlsOverlayVisible(false);
    };
    el.addEventListener("pointerleave", onLeave);
    return () => el.removeEventListener("pointerleave", onLeave);
  }, [isHost, playing, setControlsOverlayVisible]);

  /* Keyboard shortcuts: space = play/pause, ←/→ = ±10s, ↑/↓ = volume,
     M = mute, F = fullscreen. */
  useEffect(() => {
    if (!isHost) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          controls.togglePlay();
          bumpControlsActivity();
          break;
        case "ArrowLeft":
          e.preventDefault();
          controls.seekBy(-10);
          bumpControlsActivity();
          break;
        case "ArrowRight":
          e.preventDefault();
          controls.seekBy(10);
          bumpControlsActivity();
          break;
        case "ArrowUp":
          e.preventDefault();
          controls.setVolume(Math.min(1, volume + 0.1));
          bumpControlsActivity();
          break;
        case "ArrowDown":
          e.preventDefault();
          controls.setVolume(Math.max(0, volume - 0.1));
          bumpControlsActivity();
          break;
        case "m":
        case "M":
          controls.toggleMute();
          bumpControlsActivity();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          bumpControlsActivity();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, controls, volume, bumpControlsActivity]);

  /* While a movie is actually playing, leaving the page (closing the tab,
     reloading, an ad-script redirect) kills the show. Ask first — the
     browser shows its native "Leave site?" confirm. SPA navigation to the
     mini player is unaffected; this only guards full page unloads. */
  useEffect(() => {
    if (!playing || !isHost) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [playing, isHost]);

  const seekBy = useCallback(
    (delta: number) => {
      controls.seekBy(delta);
      bumpControlsActivity();
    },
    [controls, bumpControlsActivity],
  );

  /* Share from the player: native sheet on phones, clipboard elsewhere. */
  const shareMovie = useCallback(async () => {
    const url = window.location.href;
    const text = `Watch “${title}” on FilmFlix`;
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
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
  }, [title]);

  /* Picture-in-picture: pop the video into a floating OS window. */
  const togglePip = useCallback(async () => {
    const v = document.querySelector("video");
    const video = v as (HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>;
      webkitSetPresentationMode?: (m: string) => void;
    }) | null;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      } else if (video.webkitSetPresentationMode) {
        // Safari: webkit presentation mode is the PiP equivalent.
        const target =
          (video as HTMLVideoElement & { webkitPresentationMode?: string })
            .webkitPresentationMode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture";
        video.webkitSetPresentationMode(target);
      } else {
        toast.error("Picture-in-picture is not supported in this browser");
      }
    } catch {
      toast.error("Picture-in-picture is not available right now");
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }) | null;
    const fsDoc = document as Document & { webkitFullscreenElement?: Element | null };
    const isFs = Boolean(document.fullscreenElement || fsDoc.webkitFullscreenElement);
    if (!isFs) {
      // Standard API first; iOS Safari < 16.4 only supports the webkit
      // variant on video elements, so fall back through the chain.
      if (el?.requestFullscreen) {
        el.requestFullscreen().catch(() => undefined);
      } else if (el?.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else {
        // Last resort (iPhone Safari): fullscreen the underlying video via
        // the native controls when the container API is unavailable.
        const v = document.querySelector("video");
        const video = v as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
        video?.webkitEnterFullscreen?.();
      }
      // Hint phones to rotate: landscape for wide screens is nicer, but the
      // video itself letterboxes to whatever orientation the user holds.
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
        ?.lock?.("landscape")
        .catch(() => undefined); // not supported everywhere — fine
    } else {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
        ?.unlock?.();
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => undefined);
      } else if (fsDoc.webkitFullscreenElement) {
        (document as Document & { webkitExitFullscreen?: () => void }).webkitExitFullscreen?.();
      }
    }
  }, []);

  /* -------- Inactive: static placeholder (nothing playing at all) ------- */
  if (!isActive || !movie) {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-black">
        {backdropUrl || posterUrl ? (
          <img
            src={(backdropUrl ?? posterUrl) as string}
            alt=""
            className="absolute inset-0 size-full object-cover opacity-60"
          />
        ) : null}
        <button
          type="button"
          onClick={() =>
            start(
              {
                movieId,
                title,
                videoUrl: embedSource ? "" : videoUrl,
                posterUrl,
                backdropUrl,
              },
              true,
            )
          }
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4"
        >
          <span className="relative z-10 flex size-16 items-center justify-center rounded-full bg-primary/95 text-primary-foreground shadow-[0_8px_40px_-8px_var(--primary)] transition-transform hover:scale-105 sm:size-20">
            <Play className="ml-1 size-8 fill-current" />
          </span>
          <span className="relative z-10 rounded-full bg-black/60 px-4 py-1.5 font-display text-sm font-semibold text-white backdrop-blur-sm">
            {title}
          </span>
        </button>
      </div>
    );
  }

  /* -------- Active but minimized: bring-back panel ---------------------- */
  if (!isHost) {
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-black">
        {backdropUrl || posterUrl ? (
          <img
            src={(backdropUrl ?? posterUrl) as string}
            alt=""
            className="absolute inset-0 size-full object-cover opacity-40"
          />
        ) : null}
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
          <span className="rounded-full bg-black/70 px-4 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
            Playing in miniplayer — keep browsing anywhere on the site
          </span>
          <button
            type="button"
            onClick={() => setMode("inline")}
            className="glow-accent flex items-center gap-2 rounded-full bg-primary/95 px-5 py-2.5 font-display text-sm font-semibold text-primary-foreground"
          >
            <Maximize className="size-4" />
            Bring video back here
          </button>
          <button
            type="button"
            onClick={close}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Stop playback
          </button>
        </div>
      </div>
    );
  }

  /* -------- Inline host of the persistent video -------------------------- */
  return (
    <div
      ref={containerCallback}
      className={`group/player relative w-full overflow-hidden bg-black shadow-[0_24px_80px_-24px_rgba(0,0,0,0.9)] ${
        fullscreen
          ? "fixed inset-0 z-[80] rounded-none border-0"
          : "aspect-video w-full rounded-xl border border-border/60"
      }`}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        bumpControlsActivity();
      }}
      onClickCapture={(e) => {
        bumpControlsActivity();
        // Clicking anywhere outside an open player menu closes it.
        if (!(e.target as HTMLElement).closest("[data-player-menu]")) {
          setLangOpen(false);
          setSettingsOpen(false);
          setServerOpen(false);
          setSettingsView("main");
        }
      }}
      onDoubleClick={toggleFullscreen}
    >
      {/* Portal target — the persistent video mounts here. */}
      <div data-slot="stage-slot" className="absolute inset-0" />

      {/* Poster overlay until playback begins. `playing` is also checked:
          if the video is already running (any start path), the banner must
          never keep covering it. */}
      {!hasStarted && !playing && (
        <button
          type="button"
          aria-label={`Play ${movie.title}`}
          onClick={() => controls.play()}
          /* z-[15]: above the video's tap-zone layer (z-10, later in DOM so
             it wins ties — real clicks on this button were landing on the
             tap zones and doing nothing) but below the control bar (z-20). */
          className="absolute inset-0 z-[15] flex flex-col items-center justify-center gap-4 bg-black"
        >
          {movie.backdropUrl || movie.posterUrl ? (
            <img
              src={(movie.backdropUrl ?? movie.posterUrl) as string}
              alt=""
              className="absolute inset-0 size-full object-cover opacity-60"
            />
          ) : null}
          <span className="relative z-10 flex size-16 items-center justify-center rounded-full bg-primary/95 text-primary-foreground shadow-[0_8px_40px_-8px_var(--primary)] transition-transform hover:scale-105 sm:size-20">
            <Play className="ml-1 size-8 fill-current" />
          </span>
          <span className="relative z-10 rounded-full bg-black/60 px-4 py-1.5 font-display text-sm font-semibold text-white backdrop-blur-sm">
            {movie.title}
          </span>
        </button>
      )}

      {/* Full-cover iframe servers — VidSrc "Server 1" and the AutoEmbed
          episode players "Server 3" (anime) / "Server 4" (drama). */}
      {(usingVidSrc || usingAutoembed) && iframeServerUrl && (
        <div className="absolute inset-0 z-[60] bg-black">
          <iframe
            key={iframeServerUrl}
            src={iframeServerUrl}
            title={`${title} — ${usingVidSrc ? "Server 1" : server === "anime" ? "Server 3 · Anime" : "Server 4 · Drama"}`}
            className="absolute inset-0 size-full border-0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
            allowFullScreen
            referrerPolicy="origin"
          />
          {/* Floating top strip — the iframe covers the native control bar,
              so Server switch + fullscreen live here. */}
          <div className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-1.5 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-2 pb-8 pt-2 sm:px-3">
            {usingAutoembed && (
              <>
                {/* Episode stepper — the anime/drama providers are per-episode
                    for series (VidNest / Videasy `tv/{id}/{season}/{ep}`). */}
                <div className="flex items-center gap-0.5 rounded-lg bg-black/55 text-white backdrop-blur-sm">
                  <button
                    type="button"
                    onClick={() => setAeEpisode((e) => Math.max(1, e - 1))}
                    className="rounded-lg p-1.5 transition-colors hover:bg-white/15"
                    aria-label="Previous episode"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="min-w-[64px] text-center text-xs font-semibold tabular-nums">
                    Ep {aeEpisode}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAeEpisode((e) => e + 1)}
                    className="rounded-lg p-1.5 transition-colors hover:bg-white/15"
                    aria-label="Next episode"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
                <a
                  href={iframeServerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg bg-black/55 px-2.5 py-1.5 text-xs text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                  title="If the player stays blank, open the provider directly"
                >
                  Open ↗
                </a>
              </>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <ServerSwitcher
                servers={servers}
                activeKey={server}
                onSelect={selectServer}
                open={serverOpen}
                setOpen={setServerOpen}
                align="right"
                drop="down"
              />
              <DownloadMenu
                files={downloadFiles}
                streamUrl={streamProbeUrl} referer={embedUrl || embedSource || iframeServerUrl}
                ids={{ tmdbId, imdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? aeEpisode) }}
                title={title}
                open={downloadOpen}
                setOpen={setDownloadOpen}
                align="right"
                drop="down"
              />
              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              >
                {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Embed resolver fallback — provider iframe (with its ads) when no
          raw stream could be extracted server-side. */}
      {usingEmbed && embedIframe && (embedUrl || embedSource) && (
        <div className="absolute inset-0 z-[60] bg-black">
          <iframe
            src={(embedUrl || embedSource) as string}
            title={`${title} — Embed`}
            className="absolute inset-0 size-full border-0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
            allowFullScreen
            referrerPolicy="origin"
          />
          <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-1.5 bg-gradient-to-b from-black/85 via-black/45 to-transparent px-2 pb-8 pt-2 sm:px-3">
            <div className="ml-auto flex items-center gap-1.5">
              <ServerSwitcher
                servers={servers}
                activeKey={server}
                onSelect={selectServer}
                open={serverOpen}
                setOpen={setServerOpen}
                align="right"
                drop="down"
              />
              <DownloadMenu
                files={downloadFiles}
                streamUrl={streamProbeUrl} referer={embedUrl || embedSource || iframeServerUrl}
                ids={{ tmdbId, imdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? aeEpisode) }}
                title={title}
                open={downloadOpen}
                setOpen={setDownloadOpen}
                align="right"
                drop="down"
              />
              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Embed resolver panel — paste/resolve an embed URL and pick a stream. */}
      {usingEmbed && embedPanelOpen && !embedIframe && (
        <div className="absolute inset-0 z-[65] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border/60 bg-card/95 p-4 text-sm text-card-foreground shadow-2xl">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-display font-semibold">
                Embed stream — ad-free
              </span>
              <button
                type="button"
                onClick={() => setEmbedPanelOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              Paste a vidapi.ru / vidbox.wtf (or similar) embed link — the
              Worker follows its iframe chain and plays the raw HLS stream
              here, without the provider&apos;s player or ads.
            </p>
            <div className="flex gap-2">
              <input
                value={embedUrl}
                onChange={(e) => setEmbedUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runEmbedResolve(embedUrl);
                }}
                placeholder="https://vidbox.wtf/e/…"
                className="min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring"
              />
              <button
                type="button"
                disabled={embedStatus === "resolving"}
                onClick={() => void runEmbedResolve(embedUrl)}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-60"
              >
                {embedStatus === "resolving" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Link2 className="size-3.5" />
                )}
                Resolve
              </button>
            </div>
            {embedError && (
              <p className="mt-2 text-xs text-destructive">{embedError}</p>
            )}
            {embedCandidates.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Found {embedCandidates.length} stream(s) — pick one:
                </p>
                {embedCandidates.map((c) => {
                  let host = c.url;
                  try {
                    host = new URL(c.url).hostname;
                  } catch {
                    /* keep full url */
                  }
                  return (
                    <button
                      key={c.url}
                      type="button"
                      onClick={() => playEmbedCandidate(c)}
                      title={c.url}
                      className={`block w-full truncate rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
                        embedStream === c.url
                          ? "border-primary/60 text-primary"
                          : "border-border/60"
                      }`}
                    >
                      {host}{" "}
                      <span className="text-muted-foreground">({c.via})</span>
                    </button>
                  );
                })}
              </div>
            )}
            {(embedUrl || embedSource) && (
              <button
                type="button"
                onClick={() => {
                  setEmbedIframe(true);
                  setEmbedPanelOpen(false);
                }}
                className="mt-3 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Show provider iframe instead (has ads)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Controls — float up from the bottom edge on hover/tap. */}
      <div
        onMouseEnter={() => setHoveringControls(true)}
        onMouseLeave={() => setHoveringControls(false)}
        className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 pb-2.5 pt-10 transition-all duration-300 ease-out sm:px-4 ${
          controlsVisible || !playing
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        {/* Progress / seek bar — click to jump, drag to scrub. */}
        <div
          ref={scrubRef}
          data-player-scrubber
          className="group/scrub mb-2 flex h-6 cursor-pointer touch-none items-center"
          onPointerDown={(e) => {
            if (duration <= 0) return;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* capture is best-effort */
            }
            scrubbingRef.current = true;
            setControlsHold(true);
            const rect = e.currentTarget.getBoundingClientRect();
            controls.seekToRatio((e.clientX - rect.left) / rect.width);
          }}
          onPointerMove={(e) => {
            if (!scrubbingRef.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            controls.seekToRatio((e.clientX - rect.left) / rect.width);
          }}
          onPointerUp={(e) => {
            if (!scrubbingRef.current) return;
            scrubbingRef.current = false;
            setControlsHold(false);
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              /* best-effort */
            }
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false;
            setControlsHold(false);
          }}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
        >
          <div className="relative h-1.5 w-full rounded-full bg-white/25 transition-[height] group-hover/scrub:h-2.5">
            {/* Downloaded (buffered) portion. */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              style={{ width: `${duration ? Math.min(100, (bufferedEnd / duration) * 100) : 0}%` }}
            />
            {/* Played portion + thumb. */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
            />
            <div
              className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform group-hover/scrub:scale-110"
              style={{ left: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2.5">
          <span className="w-10 text-[11px] font-medium tabular-nums text-white/80">
            {formatTime(currentTime)}
          </span>
          <button
            type="button"
            onClick={() => controls.togglePlay()}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="size-5 fill-current" />
            ) : (
              <Play className="size-5 fill-current" />
            )}
          </button>
          <button
            type="button"
            onClick={() => seekBy(-10)}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Back 10 seconds"
          >
            <RotateCcw className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => seekBy(10)}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Forward 10 seconds"
          >
            <RotateCw className="size-4" />
          </button>

          {/* Volume: hover-expand on desktop, plain mute toggle on touch. */}
          <div className="group/vol flex items-center max-sm:hidden">
            <button
              type="button"
              onClick={() => controls.toggleMute()}
              className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted || volume === 0 ? (
                <VolumeX className="size-5" />
              ) : volume < 0.5 ? (
                <Volume1 className="size-5" />
              ) : (
                <Volume2 className="size-5" />
              )}
            </button>
            <div className="w-0 overflow-hidden opacity-0 transition-all duration-300 group-hover/vol:w-24 group-hover/vol:opacity-100 group-focus-within/vol:w-24 group-focus-within/vol:opacity-100">
              <Slider
                value={[muted ? 0 : Math.round(volume * 100)]}
                max={100}
                step={1}
                onValueChange={(val) => controls.setVolume((val[0] ?? 0) / 100)}
                className="w-24 [&_[data-slot=slider-track]]:bg-white/25 [&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-primary [&_[data-slot=slider-thumb]]:bg-white"
                aria-label="Volume"
              />
            </div>
          </div>
          {/* Touch devices have no hover — show the mute toggle here instead. */}
          <button
            type="button"
            onClick={() => controls.toggleMute()}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15 sm:hidden"
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted || volume === 0 ? (
              <VolumeX className="size-5" />
            ) : volume < 0.5 ? (
              <Volume1 className="size-5" />
            ) : (
              <Volume2 className="size-5" />
            )}
          </button>

          {/* Share, right beside the volume controls. */}
          <button
            type="button"
            onClick={shareMovie}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Share this movie"
            title="Share"
          >
            <Share2 className="size-5" />
          </button>

          <span className="w-10 text-[11px] font-medium tabular-nums text-white/80">
            {formatTime(duration)}
          </span>

          {/* Language switch — original + admin-added dubs. */}
          {dubs.length > 0 && (
            <div className="relative" data-player-menu>
              <button
                type="button"
                onClick={() => setLangOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
                aria-label="Audio language"
                title="Audio language"
              >
                <Languages className="size-5" />
                <span className="hidden text-xs font-semibold min-[420px]:inline">
                  {activeDub ?? "Original"}
                </span>
              </button>
              {langOpen && (
                <div className="absolute bottom-full right-0 z-30 mb-2 min-w-[160px] overflow-hidden rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.9)] backdrop-blur">
                  <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
                    Audio language
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setDub(null);
                      setLangOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                      activeDub === null ? "bg-primary/25 font-semibold text-primary" : ""
                    }`}
                  >
                    Original
                    {activeDub === null && <span className="text-xs">✓</span>}
                  </button>
                  {dubs.map((d) => (
                    <button
                      key={d.label}
                      type="button"
                      onClick={() => {
                        setDub(d.label);
                        setLangOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                        activeDub === d.label ? "bg-primary/25 font-semibold text-primary" : ""
                      }`}
                    >
                      {d.label}
                      {activeDub === d.label && <span className="text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Playback server — switch between this site's file, VidSrc, and the
              embed resolver. Shown whenever more than one server is available. */}
          {servers.length > 1 && (
            <ServerSwitcher
              servers={servers}
              activeKey={server}
              onSelect={selectServer}
              open={serverOpen}
              setOpen={setServerOpen}
              align="right"
            />
          )}

          <DownloadMenu
            files={downloadFiles}
            streamUrl={streamProbeUrl} referer={embedUrl || embedSource || iframeServerUrl}
            ids={{ tmdbId, imdbId, kind, season, episode: usingAutoembed ? aeEpisode : (episode ?? aeEpisode) }}
            title={title}
            open={downloadOpen}
            setOpen={setDownloadOpen}
            align="right"
          />

          {/* Settings gear: night mode, loop, rotate, captions, speed, quality. */}
          <div className="relative ml-auto" data-player-menu>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen((v) => !v);
                setSettingsView("main");
                setLangOpen(false);
              }}
              className={`rounded-lg p-2 text-white transition-colors hover:bg-white/15 ${
                settingsOpen || nightMode || loop || rotation !== 0 || playbackRate !== 1 || activeQuality || activeSubtitle
                  ? "text-primary"
                  : ""
              }`}
              aria-label="Player settings"
              title="Settings"
            >
              <Settings className="size-5" />
            </button>

            {settingsOpen && (
              <div className="absolute bottom-full right-0 z-30 mb-2 w-[264px] max-w-[86vw] overflow-hidden rounded-2xl border border-white/15 bg-black/95 py-1.5 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur">
                {settingsView === "main" && (
                  <>
                    <SettingsToggle
                      icon={<Moon className="size-4" />}
                      label="Night Mode"
                      on={nightMode}
                      onToggle={() => setNightMode(!nightMode)}
                    />
                    <SettingsToggle
                      icon={<Repeat className="size-4" />}
                      label="Loop"
                      on={loop}
                      onToggle={() => setLoop(!loop)}
                    />
                    <SettingsToggle
                      icon={<RotateCw className="size-4" />}
                      label="Auto Rotate"
                      on={rotation !== 0}
                      onToggle={() => setRotation(rotation === 0 ? 90 : 0)}
                    />
                    {subtitles.length > 0 && (
                      <SettingsLink
                        icon={<Captions className="size-4" />}
                        label="Subtitles"
                        value={activeSubtitle ?? "Off"}
                        onClick={() => setSettingsView("subtitles")}
                      />
                    )}
                    <SettingsLink
                      icon={<Gauge className="size-4" />}
                      label="Playback Speed"
                      value={playbackRate === 1 ? "Normal" : `${playbackRate}x`}
                      onClick={() => setSettingsView("speed")}
                    />
                    {qualities.length > 0 && (
                      <SettingsLink
                        icon={<Settings className="size-4" />}
                        label="Quality"
                        value={activeQuality ?? "Auto"}
                        onClick={() => setSettingsView("quality")}
                      />
                    )}
                  </>
                )}

                {settingsView !== "main" && (
                  <>
                    <button
                      type="button"
                      onClick={() => setSettingsView("main")}
                      className="flex w-full items-center gap-2.5 border-b border-white/10 px-3 pb-2 pt-1.5 text-left text-sm font-semibold text-white hover:bg-white/5"
                    >
                      <ChevronLeft className="size-4" />
                      {settingsView === "subtitles"
                        ? "Subtitles"
                        : settingsView === "speed"
                          ? "Playback Speed"
                          : "Quality"}
                    </button>
                    <div className="max-h-[220px] overflow-y-auto">
                      {settingsView === "subtitles" && (
                        <>
                          <MenuOption
                            label="Off"
                            selected={activeSubtitle === null}
                            onSelect={() => {
                              setSubtitle(null);
                              setSettingsOpen(false);
                            }}
                          />
                          {subtitles.map((s) => (
                            <MenuOption
                              key={s.label}
                              label={s.label}
                              selected={activeSubtitle === s.label}
                              onSelect={() => {
                                setSubtitle(s.label);
                                setSettingsOpen(false);
                              }}
                            />
                          ))}
                        </>
                      )}
                      {settingsView === "speed" &&
                        [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                          <MenuOption
                            key={r}
                            label={r === 1 ? "Normal" : `${r}x`}
                            selected={playbackRate === r}
                            onSelect={() => {
                              setPlaybackRate(r);
                              setSettingsOpen(false);
                            }}
                          />
                        ))}
                      {settingsView === "quality" && (
                        <>
                          <MenuOption
                            label="Auto"
                            selected={activeQuality === null}
                            onSelect={() => {
                              setQuality(null);
                              setSettingsOpen(false);
                            }}
                          />
                          {qualities.map((q) => (
                            <MenuOption
                              key={q.label}
                              label={q.label}
                              selected={activeQuality === q.label}
                              onSelect={() => {
                                setQuality(q.label);
                                setSettingsOpen(false);
                              }}
                            />
                          ))}
                          <p className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-white/50">
                            {qualities.map((q) => q.label).join(" / ")}
                            {" "}files play when added by the server. If a quality
                            file is not available, the player safely uses the
                            original stream.
                          </p>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Picture-in-picture — floating OS window. */}
          <button
            type="button"
            onClick={togglePip}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Picture-in-picture"
            title="Picture-in-picture"
          >
            <PictureInPicture2 className="size-5" />
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          >
            {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- Server switcher ------------------------- */

/** Dropdown that picks the playback server (VidSrc "Server 1" vs the site's
 *  own file). Shared by the native control bar and the VidSrc overlay strip. */
function ServerSwitcher({
  servers,
  activeKey,
  onSelect,
  open,
  setOpen,
  align = "right",
  drop = "up",
}: {
  servers: { key: string; label: string; sub?: string }[];
  activeKey: string;
  onSelect: (key: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  align?: "left" | "right";
  /** Which way the menu opens. The player box clips overflow, so the button
   *  in the TOP overlay strip must drop downward; the bottom control bar
   *  opens upward. */
  drop?: "up" | "down";
}) {
  const active = servers.find((s) => s.key === activeKey);
  return (
    <div
      className="relative"
      data-player-menu
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
        aria-label="Playback server"
        title="Server"
      >
        <Server className="size-5" />
        <span className="hidden text-xs font-semibold min-[420px]:inline">
          {active?.label ?? "Server"}
        </span>
      </button>
      {open && (
        <div
          className={`absolute z-30 min-w-[220px] overflow-hidden rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur ${
            drop === "down" ? "top-full mt-2" : "bottom-full mb-2"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
            Playback server
          </p>
          {servers.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                onSelect(s.key);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
                s.key === activeKey ? "bg-primary/25 font-semibold text-primary" : ""
              }`}
            >
              <span className="flex flex-col">
                <span>{s.label}</span>
                {s.sub && (
                  <span className="text-[10px] font-normal text-white/50">{s.sub}</span>
                )}
              </span>
              {s.key === activeKey && <span className="text-xs">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------- Download menu ------------------------- */

/** File name hint for the `download` attribute (browsers may ignore it
 *  cross-origin — the link still opens the file for saving). */
function downloadName(title: string, label: string, url: string): string {
  const ext =
    /\.(m3u8|mp4|mkv|webm|mov|m4v)(\?|#|$)/i.exec(url)?.[1]?.toLowerCase() ?? "mp4";
  const clean = (s: string) =>
    s
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
  return `${clean(title).slice(0, 60) || "video"}-${clean(label) || "file"}.${ext}`;
}

function DownloadMenu({
  files,
  streamUrl,
  referer,
  ids,
  title,
  open,
  setOpen,
  align = "right",
  drop = "up",
}: {
  files: { label: string; url: string }[];
  streamUrl: string;
  /** Embed page the stream came from — CDNs hotlink-check this on download. */
  referer?: string;
  ids: {
    tmdbId?: string | number | null;
    imdbId?: string | null;
    kind?: "movie" | "series" | null;
    season?: number;
    episode?: number;
  };
  title: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  align?: "left" | "right";
  /** See ServerSwitcher — top-strip menus must open downward to escape overflow-hidden. */
  drop?: "up" | "down";
}) {
  const [qualities, setQualities] = useState<{ label: string; url: string }[]>([]);
  const [providers, setProviders] = useState<TitleDownloadProvider[]>([]);
  const [probeStatus, setProbeStatus] = useState<"idle" | "loading" | "done">("idle");
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [savedNote, setSavedNote] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const loadedFor = useRef("");

  /* What the player actually fetched this session — the IDM-style list. It is
     the only source that works for token-rotating CDNs, because the URL it
     reports is the one that is live right now. */
  const sniffed = useSniffedStreams();
  useEffect(() => {
    setSnifferReferer(referer ?? "");
  }, [referer]);

  const probeKey = `${streamUrl}|${ids.tmdbId ?? ""}|${ids.imdbId ?? ""}|${ids.kind ?? ""}|${ids.season ?? 0}|${ids.episode ?? 0}`;

  useEffect(() => {
    if (!open || loadedFor.current === probeKey) return;
    loadedFor.current = probeKey;
    setProbeStatus("loading");
    // Provider sweep works on every embed server (iframe-only ones included);
    // the master-playlist probe only applies once a raw stream is resolved.
    Promise.all([
      (ids.tmdbId || ids.imdbId ? fetchTitleDownloads(ids) : Promise.resolve([])).catch(
        () => [] as TitleDownloadProvider[],
      ),
      streamUrl
        ? fetchEmbedQualities(streamUrl)
            .then((r) => r.entries ?? [])
            .catch(() => [])
        : Promise.resolve([]),
    ]).then(([prov, quals]) => {
      setProviders(prov);
      setQualities(quals);
      setProbeStatus("done");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, probeKey]);

  /* Sniffed URLs the probing above did not already list. */
  const listed = new Set([
    ...files.map((f) => f.url),
    ...qualities.map((q) => q.url),
    ...providers.flatMap((p) => p.entries.map((e) => e.url)),
  ]);
  const detected: SniffedStream[] = sniffed.filter((s) => !listed.has(s.url));

  /* The copy button hands out the Worker byte-pipe link: plain, public, no
     browser headers needed, Range-correct — so IDM (or any manager) pulls the
     file at full speed with resume. That is the escape hatch when the
     in-app remux is not enough. */
  const copyBtn = (label: string, url: string) => (
    <button
      type="button"
      title="Copy direct link — paste into IDM or any download manager"
      onClick={() => {
        navigator.clipboard
          ?.writeText(proxyUrl(url, referer || undefined, downloadName(title, label, url)))
          .then(() => {
            setCopied(url);
            setTimeout(() => setCopied(""), 2500);
          })
          .catch(() => undefined);
      }}
      className="shrink-0 rounded p-1.5 text-white/45 transition-colors hover:bg-white/15 hover:text-white"
    >
      {copied === url ? (
        <span className="text-[10px] font-semibold text-primary">copied ✓</span>
      ) : (
        <Link2 className="size-4" />
      )}
    </button>
  );

  const line = (label: string, sub: string, url: string, main: ReactNode) => (
    <div
      key={url + label}
      className="flex items-center gap-1 pr-2 transition-colors hover:bg-white/10"
      title={url}
    >
      <div className="min-w-0 flex-1">{main}</div>
      {copyBtn(label, url)}
    </div>
  );

  /* Direct files go through the byte pipe with an attachment header: a plain
     cross-origin `download` link is silently ignored by browsers, which is why
     these rows used to just open the video in a new tab. */
  const row = (label: string, sub: string, url: string) =>
    line(
      label,
      sub,
      url,
      <a
        href={proxyUrl(url, referer || undefined, downloadName(title, label, url))}
        download={downloadName(title, label, url)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{label}</span>
          {sub && <span className="text-[10px] font-normal text-white/50">{sub}</span>}
        </span>
        <Download className="size-4 shrink-0 text-white/60" />
      </a>,
    );

  /* HLS rows download in-browser (segments → remuxed .mp4) with live progress. */
  const streamRow = (label: string, sub: string, url: string) => {
    if (!isHlsLink(url)) return row(label, sub, url);
    const pct = progress[url];
    const busy = pct !== undefined && pct >= 0 && pct < 1;
    const start = () => {
      setProgress((p) => ({ ...p, [url]: 0 }));
      downloadHls(url, (f) => setProgress((p) => ({ ...p, [url]: f })), { referer })
        .then(({ blob, skipped }) => {
          saveBlob(blob, downloadName(title, label, url).replace(/\.m3u8$/i, ".mp4"));
          if (skipped) setSavedNote((n) => ({ ...n, [url]: `${skipped} parts skipped` }));
          setProgress((p) => ({ ...p, [url]: 1 }));
          setTimeout(
            () =>
              setProgress((p) => {
                const n = { ...p };
                delete n[url];
                return n;
              }),
            4000,
          );
        })
        .catch(() => setProgress((p) => ({ ...p, [url]: -1 })));
    };
    return line(
      label,
      sub,
      url,
      <div className="flex w-full items-center justify-between gap-3 px-3 py-2 text-sm text-white">
        <button
          type="button"
          disabled={busy}
          onClick={start}
          className="flex min-w-0 flex-1 flex-col items-start text-left transition-colors hover:text-primary disabled:opacity-60"
        >
          <span className="truncate">{label}</span>
          {sub && <span className="text-[10px] font-normal text-white/50">{sub}</span>}
        </button>
        {busy ? (
          <span className="shrink-0 text-[10px] tabular-nums text-white/70">
            {Math.round((pct || 0) * 100)}%
          </span>
        ) : pct === 1 ? (
          <span className="shrink-0 text-[10px] font-semibold text-primary">
            {savedNote[url] ? `saved · ${savedNote[url]}` : "saved ✓"}
          </span>
        ) : pct === -1 ? (
          <button
            type="button"
            onClick={start}
            className="shrink-0 text-[10px] font-semibold text-red-400 hover:text-red-300"
          >
            failed — retry
          </button>
        ) : (
          <Download className="size-4 shrink-0 text-white/60" />
        )}
      </div>,
    );
  };

  return (
    <div
      className="relative"
      data-player-menu
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-white transition-colors hover:bg-white/15"
        aria-label="Download"
        title="Download"
      >
        <Download className="size-5" />
        <span className="hidden text-xs font-semibold min-[420px]:inline">Download</span>
      </button>
      {open && (
        <div
          className={`absolute z-30 min-w-[220px] max-h-[60vh] overflow-y-auto rounded-xl border border-white/15 bg-black/95 py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.95)] backdrop-blur ${
            drop === "down" ? "top-full mt-2" : "bottom-full mb-2"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/50">
            Download
          </p>
          {files.map((f) => streamRow(f.label, "This site's file", f.url))}
          {qualities.map((q) => streamRow(q.label, "Now-playing stream", q.url))}
          {providers.flatMap((p) => p.entries.map((e) => streamRow(e.label, p.name, e.url)))}
          {detected.length > 0 && (
            <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-white/50">
              Detected on this page
            </p>
          )}
          {detected.map((s) => streamRow(s.label, `Sniffed · ${s.host}`, s.url))}
          {probeStatus === "loading" && (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-white/60">
              <Loader2 className="size-3.5 animate-spin" /> Checking providers &amp;
              resolutions…
            </p>
          )}
          {files.length === 0 &&
            qualities.length === 0 &&
            providers.length === 0 &&
            detected.length === 0 &&
            probeStatus !== "loading" && (
              <p className="px-3 py-2 text-xs leading-relaxed text-white/60">
                Nothing has played yet, so there is no stream to grab. Start the
                video (or switch server) and open Download again — every URL the
                player pulls shows up here automatically.
              </p>
            )}
          {(detected.length > 0 || files.length + qualities.length + providers.length > 0) && (
            <p className="px-3 py-2 text-[10px] leading-relaxed text-white/40">
              Stuck on a big file? Hit the link icon to copy a direct URL — paste
              it into IDM and it downloads with resume and multiple connections.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------- Settings menu pieces ------------------------- */

function SettingsToggle({
  icon,
  label,
  on,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10"
    >
      <span className="text-white/70">{icon}</span>
      <span className="flex-1">{label}</span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          on ? "bg-primary" : "bg-white/20"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
            on ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function SettingsLink({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10"
    >
      <span className="text-white/70">{icon}</span>
      <span className="flex-1">{label}</span>
      <span className="flex items-center gap-1 text-xs font-medium text-white/70">
        {value}
        <ChevronRight className="size-3.5" />
      </span>
    </button>
  );
}

function MenuOption({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 ${
        selected ? "bg-primary/25 font-semibold text-primary" : ""
      }`}
    >
      {label}
      {selected && <span className="text-xs">✓</span>}
    </button>
  );
}
