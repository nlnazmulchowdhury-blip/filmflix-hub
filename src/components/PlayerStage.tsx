import { useMiniPlayer } from "@/components/mini-player-context";
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Languages,
  Maximize,
  Minimize,
  Moon,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Settings,
  Share2,
  Volume1,
  Volume2,
  VolumeX,
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
  const [controlsVisible, setControlsVisible] = useState(true);
  /** Cursor is over the control bar — keep the bar up while it is. */
  const [hoveringControls, setHoveringControls] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<
    "main" | "subtitles" | "speed" | "quality"
  >("main");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dubs = movie?.dubs ?? [];
  const qualities = movie?.qualities ?? [];
  const subtitles = movie?.subtitles ?? [];

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
      className={`group/player relative w-full overflow-hidden bg-black shadow-[0_24px_80px_-24px_rgba(0,0,0,0.9)] ${
        fullscreen
          ? "fixed inset-0 z-[80] rounded-none border-0"
          : "aspect-video w-full rounded-xl border border-border/60"
      }`}
      onMouseMove={() => setControlsVisible(true)}
      onMouseLeave={() => playing && setHoveringControls(false)}
      onClickCapture={(e) => {
        setControlsVisible(true);
        // Clicking anywhere outside an open player menu closes it.
        if (!(e.target as HTMLElement).closest("[data-player-menu]")) {
          setLangOpen(false);
          setSettingsOpen(false);
          setSettingsView("main");
        }
      }}
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
