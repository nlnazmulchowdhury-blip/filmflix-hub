import {
  Maximize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { createPortal } from "react-dom";
import {
  MiniPlayerContext,
  type MiniPlayerMovie,
  type PlayerControls,
} from "./mini-player-context";
function formatTime(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MiniPlayerProvider({ children }: { children: ReactNode }) {
  const [movie, setMovie] = useState<MiniPlayerMovie | null>(null);
  const [mode, setModeState] = useState<"inline" | "mini">("inline");
  const [hasStarted, setHasStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /** Inline stage slot registered by the movie page. */
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  /** Mini-card video slot (portal target in mini mode). */
  const [miniSlot, setMiniSlot] = useState<HTMLElement | null>(null);
  /** Off-screen parking so the element survives surface swaps unmounted. */
  const parkingRef = useRef<HTMLDivElement | null>(null);
  const [parkingEl, setParkingEl] = useState<HTMLElement | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Latest movie state for callbacks that must not re-create on each render. */
  const movieRef = useRef<MiniPlayerMovie | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  /** Currently playing audio version: null = original, else the dub label. */
  const [activeDub, setActiveDub] = useState<string | null>(null);

  useEffect(() => {
    movieRef.current = movie;
  }, [movie]);

  const onPlayingPage =
    movie != null && location.pathname === `/movie/${movie.movieId}`;

  /* ------------------------------------------------------------ playback */

  const playVideo = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    setHasStarted(true);
    el.muted = false;
    el.play().catch(() => {
      // Autoplay policy fallback: start muted, let the user unmute.
      el.muted = true;
      setMuted(true);
      el.play().catch(() => undefined);
    });
  }, []);

  const start = useCallback(
    (m: MiniPlayerMovie, autoplay = true) => {
      setMovie((prev) => {
        if (prev?.movieId !== m.movieId) {
          setHasStarted(false);
          setCurrentTime(0);
          setDuration(0);
          setActiveDub(null);
        }
        return m;
      });
      setModeState("inline");
      if (autoplay) {
        // Wait for the stage slot to mount, then play.
        requestAnimationFrame(() => playVideo());
      }
    },
    [playVideo],
  );

  /**
   * Switch audio version (original ↔ dub) in place: swap only the video src,
   * restore the playback position and resume. The media element is never
   * recreated, so volume/mute state also survive.
   */
  const setDub = useCallback(
    (label: string | null) => {
      const el = videoRef.current;
      const m = movieRef.current;
      if (!el || !m) return;
      const dub = label ? (m.dubs ?? []).find((d) => d.label === label) : undefined;
      const nextSrc = dub ? dub.videoUrl : m.videoUrl;
      if (!nextSrc || nextSrc === el.currentSrc || nextSrc === el.src) {
        setActiveDub(label);
        return;
      }
      const resumeAt = el.currentTime;
      const wasPlaying = !el.paused;
      setActiveDub(label);
      el.src = nextSrc;
      el.load();
      const restore = () => {
        el.removeEventListener("loadedmetadata", restore);
        if (Number.isFinite(resumeAt) && resumeAt > 0) {
          el.currentTime = resumeAt;
        }
        if (wasPlaying) {
          el.play().catch(() => undefined);
        }
      };
      el.addEventListener("loadedmetadata", restore);
    },
    [],
  );

  const setMode = useCallback((m: "inline" | "mini") => {
    setModeState(m);
  }, []);

  const close = useCallback(() => {
    videoRef.current?.pause();
    setMovie(null);
    setModeState("inline");
    setHasStarted(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setActiveDub(null);
  }, []);

  /* ------------------- YouTube behavior: navigate away => mini ---------- */

  useEffect(() => {
    if (movie && hasStarted && mode === "inline" && !onPlayingPage) {
      setModeState("mini");
    }
  }, [movie, hasStarted, mode, onPlayingPage]);

  /* ------------------------------------------------------------ controls */

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => undefined);
    else el.pause();
  }, []);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  }, []);

  const setVolumeTo = useCallback((v: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = v;
    el.muted = v === 0;
    setVolume(v);
    setMuted(v === 0);
  }, []);

  const seekBy = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(
      0,
      Math.min(el.duration || Number.MAX_SAFE_INTEGER, el.currentTime + delta),
    );
  }, []);

  const seekToRatio = useCallback((ratio: number) => {
    const el = videoRef.current;
    if (!el || !el.duration) return;
    el.currentTime = Math.max(0, Math.min(1, ratio)) * el.duration;
  }, []);

  const pauseVideo = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  const controls = useMemo<PlayerControls>(
    () => ({
      play: playVideo,
      pause: pauseVideo,
      togglePlay,
      toggleMute,
      setVolume: setVolumeTo,
      seekBy,
      seekToRatio,
    }),
    [playVideo, pauseVideo, togglePlay, toggleMute, setVolumeTo, seekBy, seekToRatio],
  );

  const value = useMemo(
    () => ({
      movie,
      mode,
      isActive: movie != null,
      hasStarted,
      playing,
      muted,
      volume,
      currentTime,
      duration,
      activeDub,
      setDub,
      registerStage: setStageEl,
      start,
      setMode,
      close,
      controls,
    }),
    [
      movie,
      mode,
      hasStarted,
      playing,
      muted,
      volume,
      currentTime,
      duration,
      activeDub,
      setDub,
      start,
      setMode,
      close,
      controls,
    ],
  );

  /* ---------------------------------------------------------------- render */

  const inlineOnPage =
    movie != null && mode === "inline" && stageEl != null && onPlayingPage;
  const miniActive = movie != null && mode === "mini";

  // Single portal target: stage (inline on page) → mini card → parking.
  const portalTarget = inlineOnPage ? stageEl : miniActive ? miniSlot : parkingEl;

  return (
    <MiniPlayerContext.Provider value={value}>
      {children}

      {/* Off-screen parking: keeps the video element attached (playback and
          position intact) while surfaces swap underneath it. */}
      <div ref={setParkingEl} className="hidden" aria-hidden />

      {/* THE single persistent video surface. Rendered in exactly ONE stable
          tree position; only the portal container ever changes, so the media
          element is never recreated — no reloads, no position resets. */}
      {movie &&
        portalTarget &&
        createPortal(
          <VideoSurface
            videoRef={videoRef}
            src={movie.videoUrl}
            visible={Boolean(inlineOnPage || miniActive)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTime={(t, d) => {
              setCurrentTime(t);
              setDuration(d);
            }}
            onEnded={close}
          />,
          portalTarget,
        )}

      {/* Floating mini card */}
      {miniActive && movie && (
        <div
          data-slot="mini-player"
          className="fixed bottom-3 right-3 z-[60] w-[45vw] max-w-[340px] min-w-[180px] overflow-hidden rounded-xl border border-white/15 bg-black/95 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.95)] backdrop-blur max-sm:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:right-[max(0.75rem,env(safe-area-inset-right))] sm:bottom-4 sm:right-4 sm:w-[340px]"
        >
          <div className="group/mp relative aspect-video bg-black">
            {/* Portal target for the persistent video */}
            <div ref={setMiniSlot} className="absolute inset-0" />

            {/* Title + close */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-2 opacity-0 transition-opacity group-hover/mp:pointer-events-auto group-hover/mp:opacity-100">
              <p className="line-clamp-1 pr-2 text-xs font-medium text-white/90">
                {movie.title}
              </p>
              <button
                type="button"
                onClick={close}
                aria-label="Close miniplayer"
                className="pointer-events-auto rounded-md bg-black/40 p-1 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Controls */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-0.5 bg-gradient-to-t from-black/85 to-transparent p-1.5 opacity-0 transition-opacity group-hover/mp:pointer-events-auto group-hover/mp:opacity-100">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                className="pointer-events-auto rounded-md p-1.5 text-white transition-colors hover:bg-white/15"
              >
                {playing ? (
                  <Pause className="size-4 fill-current" />
                ) : (
                  <Play className="size-4 fill-current" />
                )}
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                className="pointer-events-auto rounded-md p-1.5 text-white transition-colors hover:bg-white/15"
              >
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
              <span className="ml-auto pr-1 text-[10px] font-medium tabular-nums text-white/70">
                {formatTime(currentTime)}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigate(`/movie/${movie.movieId}`);
                  setModeState("inline");
                }}
                aria-label="Expand player"
                title="Back to movie page"
                className="pointer-events-auto rounded-md p-1.5 text-white transition-colors hover:bg-white/15"
              >
                <Maximize2 className="size-4" />
              </button>
            </div>

            {/* Progress line */}
            <div className="absolute inset-x-0 bottom-0 z-30 h-[3px] bg-white/15">
              <div
                className="h-full bg-primary"
                style={{
                  width: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </MiniPlayerContext.Provider>
  );
}

/* ======================================================================== */

/**
 * The persistent video surface. Rendered once in a stable tree position and
 * only ever moved between portal containers — the underlying media element
 * is never recreated, so playback position, volume and state survive page
 * navigation, exactly like YouTube's miniplayer.
 */
function VideoSurface({
  videoRef,
  src,
  visible,
  onPlay,
  onPause,
  onTime,
  onEnded,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string;
  visible: boolean;
  onPlay: () => void;
  onPause: () => void;
  onTime: (t: number, d: number) => void;
  onEnded: () => void;
}) {
  return (
    <div
      data-slot="persistent-video-wrap"
      className={visible ? "absolute inset-0" : "absolute inset-0 opacity-0"}
    >
      <video
        ref={videoRef}
        src={src}
        className="absolute inset-0 size-full object-contain"
        playsInline
        preload="metadata"
        onPlay={onPlay}
        onPause={onPause}
        onTimeUpdate={(e) =>
          onTime(e.currentTarget.currentTime, e.currentTarget.duration || 0)
        }
        onEnded={onEnded}
        onClick={(e) => {
          const el = e.currentTarget;
          if (el.paused) el.play().catch(() => undefined);
          else el.pause();
        }}
      />
    </div>
  );
}
