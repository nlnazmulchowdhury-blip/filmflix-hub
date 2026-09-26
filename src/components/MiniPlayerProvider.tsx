import {
  Maximize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
  AudioLines,
  ZoomOut,
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
  type PlayerRotation,
} from "./mini-player-context";
import { convexSiteUrl, playableVideoUrl } from "@/lib/video-url";
function formatTime(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Swap the video's file in place: keep the playback position, speed and
 *  play/pause state. Used by language (dub) and quality switching. */
function swapSrcKeepingPosition(el: HTMLVideoElement, nextSrc: string, rate: number) {
  const resumeAt = el.currentTime;
  const wasPlaying = !el.paused;
  el.src = nextSrc;
  el.load();
  const restore = () => {
    el.removeEventListener("loadedmetadata", restore);
    if (Number.isFinite(resumeAt) && resumeAt > 0) {
      el.currentTime = resumeAt;
    }
    el.playbackRate = rate;
    if (wasPlaying) {
      el.play().catch(() => undefined);
    }
  };
  el.addEventListener("loadedmetadata", restore);
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

  /* --------------------- Viewer settings (gear menu) -------------------- */
  const [nightMode, setNightMode] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rotation, setRotation] = useState<PlayerRotation>(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [activeQuality, setActiveQuality] = useState<string | null>(null);
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(null);

  /** Latest settings for callbacks/effects that must not go stale. */
  const playbackRateRef = useRef(1);
  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

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
      const nextSrc = playableVideoUrl(
        dub ? dub.videoUrl : m.videoUrl,
        convexSiteUrl(),
      );
      if (!nextSrc || nextSrc === el.currentSrc || nextSrc === el.src) {
        setActiveDub(label);
        return;
      }
      swapSrcKeepingPosition(el, nextSrc, playbackRateRef.current);
      setActiveDub(label);
    },
    [],
  );

  /** Same in-place src swap, but for quality renditions (480p/720p/…). */
  const setQuality = useCallback((label: string | null) => {
    const el = videoRef.current;
    const m = movieRef.current;
    if (!el || !m) return;
    const q = label ? (m.qualities ?? []).find((x) => x.label === label) : undefined;
    const nextSrc = playableVideoUrl(
      q ? q.videoUrl : m.videoUrl,
      convexSiteUrl(),
    );
    if (!nextSrc || nextSrc === el.currentSrc || nextSrc === el.src) {
      setActiveQuality(label);
      return;
    }
    swapSrcKeepingPosition(el, nextSrc, playbackRateRef.current);
    setActiveQuality(label);
  }, []);

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

  const setPlaybackRate = useCallback((r: number) => {
    const el = videoRef.current;
    playbackRateRef.current = r;
    setPlaybackRateState(r);
    if (el) el.playbackRate = r;
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

  /* Reset viewer settings when a different movie starts. */
  useEffect(() => {
    setNightMode(false);
    setLoop(false);
    setRotation(0);
    setPlaybackRateState(1);
    playbackRateRef.current = 1;
    setActiveQuality(null);
    setActiveSubtitle(null);
  }, [movie?.movieId]);

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
      setSubtitle: setActiveSubtitle,
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
      nightMode,
      loop,
      rotation,
      playbackRate,
      setPlaybackRate,
      activeQuality,
      setQuality,
      activeSubtitle,
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
            src={playableVideoUrl(movie.videoUrl, convexSiteUrl())}
            subtitles={movie.subtitles ?? []}
            activeSubtitle={activeSubtitle}
            nightMode={nightMode}
            rotation={rotation}
            loop={loop}
            visible={Boolean(inlineOnPage || miniActive)}
            posterUrl={movie.backdropUrl ?? movie.posterUrl ?? null}
            title={movie.title}
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
 *
 * Also hosts the viewer settings that live on the media element itself:
 * subtitle tracks, night-mode dimming and the 90° rotation steps.
 */
function VideoSurface({
  videoRef,
  src,
  subtitles,
  activeSubtitle,
  nightMode,
  rotation,
  loop,
  visible,
  posterUrl,
  title,
  onPlay,
  onPause,
  onTime,
  onEnded,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string;
  subtitles: { label: string; url: string }[];
  activeSubtitle: string | null;
  nightMode: boolean;
  rotation: PlayerRotation;
  loop: boolean;
  visible: boolean;
  posterUrl?: string | null;
  title?: string;
  onPlay: () => void;
  onPause: () => void;
  onTime: (t: number, d: number) => void;
  onEnded: () => void;
}) {
  /* Container size — needed to keep a rotated picture fully in view. */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Audio-only sources (mp3 links etc.) render no picture at all — the
     screen would be a silent-looking black box. When the file has no video
     track, show the movie's art behind the (invisible) media element and a
     small badge so users know playback itself is fine. */
  const [audioOnly, setAudioOnly] = useState(false);
  useEffect(() => {
    setAudioOnly(false);
    const el = videoRef.current;
    if (!el) return;
    const check = () => {
      /* height 0 with a real duration = audio-only content */
      const noVideo = el.videoHeight === 0;
      setAudioOnly(noVideo && Number.isFinite(el.duration) && el.duration > 0);
    };
    check();
    el.addEventListener("loadedmetadata", check);
    el.addEventListener("durationchange", check);
    return () => {
      el.removeEventListener("loadedmetadata", check);
      el.removeEventListener("durationchange", check);
    };
  }, [src, videoRef]);

  /* Rotate: swap the box so the rotated picture stays fully visible. */
  const rotated = rotation === 90 || rotation === 270;
  const fitScale =
    rotated && box.w > 0 && box.h > 0
      ? Math.min(box.w, box.h) / Math.max(box.w, box.h)
      : 1;

  /* ---------------- Pinch-to-zoom & pan (touch) -------------------------
   * Two-finger pinch zooms (1x–5x), one finger pans while zoomed, and a
   * double-tap toggles between normal and "fill the screen" (cover) zoom —
   * so letterboxed movies can be enlarged to use the whole phone screen.
   * The transform composes translate → rotate → scale, so panning always
   * follows the finger in screen space, with or without rotation. */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [gesturing, setGesturing] = useState(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  /** On-screen size of the picture at zoom `z` (rotation-aware). */
  const pictureSize = useCallback(
    (z: number) => {
      const el = videoRef.current;
      const vw = el?.videoWidth || 16;
      const vh = el?.videoHeight || 9;
      if (!box.w || !box.h) return { w: 0, h: 0 };
      // object-contain footprint inside the box, before zoom:
      const cw = Math.min(box.w, (box.h * vw) / vh);
      const ch = Math.min(box.h, (box.w * vh) / vw);
      const base = rotated ? fitScale : 1;
      return {
        w: (rotated ? ch : cw) * base * z,
        h: (rotated ? cw : ch) * base * z,
      };
    },
    [box.w, box.h, rotated, fitScale, videoRef],
  );

  /** Never let the picture be dragged past its own edges. */
  const clampPan = useCallback(
    (z: number, p: { x: number; y: number }) => {
      if (z <= 1.001) return { x: 0, y: 0 };
      const { w, h } = pictureSize(z);
      const mx = Math.max(0, (w - box.w) / 2);
      const my = Math.max(0, (h - box.h) / 2);
      return {
        x: Math.max(-mx, Math.min(mx, p.x)),
        y: Math.max(-my, Math.min(my, p.y)),
      };
    },
    [pictureSize, box.w, box.h],
  );

  /** Zoom at which the picture covers the whole container (fill mode). */
  const coverZoom = useCallback(() => {
    if (!box.w || !box.h) return 2;
    const { w, h } = pictureSize(1);
    if (!w || !h) return 2;
    return Math.min(5, Math.max(1, box.w / w, box.h / h));
  }, [box.w, box.h, pictureSize]);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  /* A new movie, a swapped file (dub/quality) or a rotation starts clean. */
  useEffect(() => {
    resetZoom();
  }, [src, rotation, resetZoom]);

  /* Container resized (e.g. fullscreen toggle) → re-clamp the pan. */
  useEffect(() => {
    setPan((p) => clampPan(zoomRef.current, p));
  }, [box.w, box.h, clampPan]);

  /* Stop iOS Safari's non-standard page pinch over the picture. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const stop = (ev: Event) => ev.preventDefault();
    el.addEventListener("gesturestart", stop);
    el.addEventListener("gesturechange", stop);
    return () => {
      el.removeEventListener("gesturestart", stop);
      el.removeEventListener("gesturechange", stop);
    };
  }, []);

  const pinch = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    startDist: number;
    startZoom: number;
    startPan: { x: number; y: number };
    lastPos: { x: number; y: number };
    moved: boolean;
    pointerType: string;
  } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const lastPointerType = useRef("mouse");

  const clearTapTimer = () => {
    if (tapTimer.current) {
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
    }
  };
  useEffect(() => clearTapTimer, []);

  const toggleVideoPlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => undefined);
    else el.pause();
  };

  const onSurfacePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    lastPointerType.current = e.pointerType;
    clearTapTimer();
    const g = pinch.current;
    if (!g) {
      pinch.current = {
        pointers: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]),
        startDist: 1,
        startZoom: 1,
        startPan: { x: 0, y: 0 },
        lastPos: { x: e.clientX, y: e.clientY },
        moved: false,
        pointerType: e.pointerType,
      };
    } else {
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.pointers.size === 2) {
        /* Pinch begins: snapshot geometry (tap detection is cancelled by
           the clearTapTimer above). */
        const pts = [...g.pointers.values()];
        const a = pts[0];
        const b = pts[1];
        if (a && b) {
          g.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          g.startZoom = zoomRef.current;
          g.startPan = { ...panRef.current };
        }
      }
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  };

  const onSurfacePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = pinch.current;
    if (!g || !g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size >= 2) {
      const pts = [...g.pointers.values()];
      const a = pts[0];
      const b = pts[1];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const next = Math.min(5, Math.max(1, g.startZoom * (dist / g.startDist)));
      /* Keep the pinch midpoint anchored under the fingers. The midpoint is
         converted to container-center-relative coordinates so it lives in
         the same space as the pan offset. */
      const rect = e.currentTarget.getBoundingClientRect();
      const ux = (a.x + b.x) / 2 - (rect.left + rect.width / 2);
      const uy = (a.y + b.y) / 2 - (rect.top + rect.height / 2);
      const k = next / g.startZoom;
      setGesturing(true);
      setZoom(next);
      setPan(
        clampPan(next, {
          x: ux - (ux - g.startPan.x) * k,
          y: uy - (uy - g.startPan.y) * k,
        }),
      );
      if (Math.abs(dist - g.startDist) > 8) g.moved = true;
    } else if (zoomRef.current > 1.001) {
      /* One finger pans while zoomed in. */
      const dx = e.clientX - g.lastPos.x;
      const dy = e.clientY - g.lastPos.y;
      if (dx || dy) g.moved = true;
      setGesturing(true);
      setPan((p) => clampPan(zoomRef.current, { x: p.x + dx, y: p.y + dy }));
    }
    g.lastPos = { x: e.clientX, y: e.clientY };
  };

  const onSurfacePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = pinch.current;
    if (!g || !g.pointers.has(e.pointerId)) return;
    g.pointers.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
    if (g.pointers.size === 1) {
      /* One finger lifted from a pinch: keep panning with the other. */
      const only = [...g.pointers.values()][0];
      if (only) g.lastPos = { x: only.x, y: only.y };
      return;
    }
    pinch.current = null;
    setGesturing(false);
    if (g.moved) return;
    if (g.pointerType !== "touch") {
      /* Mouse keeps the old instant click-to-pause behavior; double-click
         still reaches the container's fullscreen handler. */
      toggleVideoPlay();
      return;
    }
    /* Touch: double-tap toggles fill zoom, single tap plays/pauses. */
    const now = Date.now();
    const lt = lastTap.current;
    if (now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 40) {
      lastTap.current = { t: 0, x: 0, y: 0 };
      clearTapTimer();
      if (zoomRef.current > 1.05) {
        resetZoom();
      } else {
        /* Fill the screen (cover); skip when the aspect already matches. */
        const c = coverZoom();
        if (c > 1.02) {
          setZoom(c);
          setPan({ x: 0, y: 0 });
        }
      }
    } else {
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      clearTapTimer();
      tapTimer.current = setTimeout(() => {
        tapTimer.current = null;
        toggleVideoPlay();
      }, 280);
    }
  };

  const onSurfacePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = pinch.current;
    if (!g) return;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size === 0) {
      pinch.current = null;
      setGesturing(false);
      clearTapTimer();
    }
  };

  /* Touch double-taps must not also trigger the container's
     double-click fullscreen toggle. */
  const onSurfaceDoubleClick = (e: React.MouseEvent) => {
    if (lastPointerType.current === "touch") e.stopPropagation();
  };

  return (
    <div
      ref={wrapRef}
      data-slot="persistent-video-wrap"
      className={visible ? "absolute inset-0" : "absolute inset-0 opacity-0"}
    >
      <div
        data-slot="zoom-surface"
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onSurfacePointerMove}
        onPointerUp={onSurfacePointerUp}
        onPointerCancel={onSurfacePointerCancel}
        onDoubleClick={onSurfaceDoubleClick}
        className="absolute inset-0"
        /* pan-y: single-finger vertical swipes still scroll the page while
           zoomed out; once zoomed (or mid-pinch) the surface owns all
           gestures so the picture pans instead of the page. */
        style={{ touchAction: zoom > 1 || gesturing ? "none" : "pan-y" }}
      >
        {audioOnly && (
          <>
            {posterUrl ? (
              <img
                src={posterUrl}
                alt=""
                className="absolute inset-0 size-full object-cover blur-sm brightness-[0.55]"
              />
            ) : (
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(var(--primary-rgb,124,58,237),0.25),transparent_65%)]" />
            )}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span
                className={`flex size-20 items-center justify-center rounded-full bg-primary/25 text-primary backdrop-blur ${
                  visible ? "animate-pulse" : ""
                }`}
              >
                <AudioLines className="size-10" />
              </span>
            </div>
            <div className="pointer-events-none absolute left-3 top-3 z-30 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur">
              <AudioLines className="size-3.5" />
              Audio only{title ? ` — ${title}` : ""}
            </div>
          </>
        )}
        <video
          ref={videoRef}
          src={src}
          loop={loop}
          className="absolute inset-0 size-full object-contain"
          style={{
            transformOrigin: "center",
            transform:
              zoom === 1
                ? rotation !== 0
                  ? `rotate(${rotation}deg) scale(${rotated ? fitScale : 1})`
                  : undefined
                : `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${
                    (rotated ? fitScale : 1) * zoom
                  })`,
            filter: nightMode ? "brightness(0.6)" : undefined,
          }}
          playsInline
          preload="metadata"
          /* No crossOrigin here: most video hosts do not send CORS headers,
             and the attribute would make the browser refuse the video file
             entirely. Subtitle <track>s still load CORS-anonymously on their
             own, so captions keep working independently of the video. */
          onPlay={onPlay}
          onPause={onPause}
          onTimeUpdate={(e) =>
            onTime(e.currentTarget.currentTime, e.currentTarget.duration || 0)
          }
          onEnded={onEnded}
        >
          {subtitles.map((s) => (
            <track key={s.label} kind="subtitles" src={s.url} label={s.label} />
          ))}
        </video>
      </div>

      {zoom > 1.05 && (
        <button
          type="button"
          onClick={resetZoom}
          className="absolute left-3 top-3 z-30 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur transition-colors hover:bg-black/85"
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          <ZoomOut className="size-3.5" />
          {Math.round(zoom * 10) / 10}×
        </button>
      )}
    </div>
  );
}
