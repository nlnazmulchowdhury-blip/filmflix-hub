import { Slider } from "@/components/ui/slider";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  Loader2,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Movie = Doc<"movies">;

function formatTime(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function VideoPlayer({
  movie,
  videoUrl,
  title,
}: {
  movie: Movie | null | undefined;
  videoUrl: string | undefined;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const startPlaying = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    setMuted(false);
    video.play().catch(() => {
      video.muted = true;
      setMuted(true);
      video.play().catch(() => undefined);
    });
  }, []);

  // YouTube-style behavior: first click on the poster starts playback.
  const handleStageClick = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!playing && video.currentTime === 0 && video.paused) {
      startPlaying();
    } else if (playing) {
      video.pause();
    } else {
      video.play().catch(() => undefined);
    }
    setControlsVisible(true);
  }, [playing, startPlaying]);

  const seekBy = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
  };

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.().catch(() => undefined);
    } else {
      document.exitFullscreen?.().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Auto-hide controls while playing
  useEffect(() => {
    if (!playing) {
      setControlsVisible(true);
      return;
    }
    const scheduleHide = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setControlsVisible(false), 2600);
    };
    scheduleHide();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [playing, controlsVisible]);

  const video = videoRef.current;

  return (
    <div
      ref={containerRef}
      className={`group/player relative w-full overflow-hidden rounded-xl border border-border/60 bg-black shadow-[0_24px_80px_-24px_rgba(0,0,0,0.9)] ${
        fullscreen ? "h-screen rounded-none border-0" : "aspect-video"
      }`}
      onMouseMove={() => setControlsVisible(true)}
      onMouseLeave={() => playing && setControlsVisible(false)}
      onDoubleClick={toggleFullscreen}
    >
      <div className="absolute inset-0">
        <video
          ref={videoRef}
          src={videoUrl}
          className="size-full object-contain"
          playsInline
          preload="metadata"
          onClick={handleStageClick}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onTimeUpdate={() => setCurrent(videoRef.current?.currentTime ?? 0)}
          onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
          onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
          onEnded={() => setPlaying(false)}
        />
      </div>

      {/* Poster / click-to-play overlay */}
      {!playing && (
        <button
          type="button"
          aria-label={`Play ${title}`}
          onClick={handleStageClick}
          className="absolute inset-0 flex w-full flex-col items-center justify-center gap-4 bg-black focus-visible:outline-none"
        >
          {movie?.backdropUrl || movie?.posterUrl ? (
            <img
              src={movie.backdropUrl ?? movie.posterUrl}
              alt=""
              className="absolute inset-0 size-full object-cover opacity-60"
            />
          ) : null}
          <span className="relative z-10 flex size-16 items-center justify-center rounded-full bg-primary/95 text-primary-foreground shadow-[0_8px_40px_-8px_var(--primary)] transition-transform duration-300 hover:scale-105 md:size-20">
            <Play className="ml-1 size-8 fill-current" />
          </span>
          <span className="relative z-10 rounded-full bg-black/60 px-4 py-1.5 font-display text-sm font-semibold text-white backdrop-blur-sm">
            {title}
          </span>
        </button>
      )}

      {/* buffering spinner */}
      {waiting && playing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-10 animate-spin text-white/90" />
        </div>
      )}

      {/* Controls bar */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-2.5 pt-10 transition-opacity duration-300 sm:px-4 ${
          controlsVisible || !playing ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {/* progress */}
        <div
          className="mb-2 flex items-center gap-3"
          onClick={(e) => {
            e.stopPropagation();
            const el = e.currentTarget;
            const rect = el.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const v = videoRef.current;
            if (v && v.duration) v.currentTime = ratio * v.duration;
          }}
        >
          <span className="w-10 text-right text-[11px] font-medium tabular-nums text-white/80">
            {formatTime(current)}
          </span>
          <div className="relative h-4 flex-1 cursor-pointer">
            <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-white/25">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${duration ? (current / duration) * 100 : 0}%` }}
              />
            </div>
          </div>
          <span className="w-10 text-[11px] font-medium tabular-nums text-white/80">
            {formatTime(duration)}
          </span>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2.5">
          <button
            type="button"
            onClick={handleStageClick}
            className="rounded-lg p-2 text-white transition-colors hover:bg-white/15"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
          </button>

          <div className="hidden items-center gap-1 sm:flex">
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
          </div>

          {/* Volume: mute toggle + slider */}
          <div className="group/vol flex items-center">
            <button
              type="button"
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                v.muted = !v.muted;
                setMuted(v.muted);
              }}
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
                onValueChange={(val) => {
                  const v = videoRef.current;
                  const next = (val[0] ?? 0) / 100;
                  setVolume(next);
                  if (v) {
                    v.volume = next;
                    v.muted = next === 0;
                    setMuted(next === 0);
                  }
                }}
                className="w-24 [&_[data-slot=slider-track]]:bg-white/25 [&_[data-slot=slider-range]]:bg-primary [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-primary [&_[data-slot=slider-thumb]]:bg-white"
                aria-label="Volume"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
