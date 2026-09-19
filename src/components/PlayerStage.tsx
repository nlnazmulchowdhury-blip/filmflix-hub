import { useMiniPlayer } from "@/components/mini-player-context";
import {
  Languages,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Share2,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
}: {
  movieId: string;
  videoUrl: string;
  title: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
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
    activeDub,
    setDub,
    registerStage,
    start,
    setMode,
    close,
    controls,
  } = useMiniPlayer();

  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  /** Cursor is over the control bar — keep the bar up while it is. */
  const [hoveringControls, setHoveringControls] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dubs = movie?.dubs ?? [];

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
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  /* Auto-hide controls while playing — but never while the cursor rests on
     the control bar itself. */
  useEffect(() => {
    if (!playing || !isHost) {
      setControlsVisible(true);
      return;
    }
    if (!controlsVisible) return;
    const t = setTimeout(() => {
      if (!hoveringControls) setControlsVisible(false);
    }, 2600);
    return () => clearTimeout(t);
  }, [playing, isHost, controlsVisible, hoveringControls]);

  const seekBy = useCallback(
    (delta: number) => {
      controls.seekBy(delta);
      setControlsVisible(true);
    },
    [controls],
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

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.().catch(() => undefined);
    } else {
      document.exitFullscreen?.().catch(() => undefined);
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
            start({ movieId, title, videoUrl, posterUrl, backdropUrl }, true)
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
      className={`group/player relative w-full overflow-hidden rounded-xl border border-border/60 bg-black shadow-[0_24px_80px_-24px_rgba(0,0,0,0.9)] ${
        fullscreen ? "h-screen rounded-none border-0" : "aspect-video"
      }`}
      onMouseMove={() => setControlsVisible(true)}
      onMouseLeave={() => playing && setHoveringControls(false)}
      onClickCapture={() => setControlsVisible(true)}
      onDoubleClick={toggleFullscreen}
    >
      {/* Portal target — the persistent video mounts here. */}
      <div data-slot="stage-slot" className="absolute inset-0" />

      {/* Poster overlay until playback begins */}
      {!hasStarted && (
        <button
          type="button"
          aria-label={`Play ${movie.title}`}
          onClick={() => controls.play()}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black"
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
        {/* Progress / seek bar */}
        <div
          className="mb-2 flex h-4 cursor-pointer items-center"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            controls.seekToRatio((e.clientX - rect.left) / rect.width);
          }}
        >
          <div className="relative h-1 w-full rounded-full bg-white/25">
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${duration ? (currentTime / duration) * 100 : 0}%`,
              }}
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
            <div className="relative">
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

          {/* Mini hand-off */}
          <button
            type="button"
            onClick={() => setMode("mini")}
            className="ml-auto rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label="Play in miniplayer"
            title="Play in miniplayer — keep browsing"
          >
            <MiniIcon />
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

function MiniIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      <polyline points="5 12 5 19 19 19 19 12" />
      <rect x="12" y="5" width="7" height="5" rx="1" />
    </svg>
  );
}
