import {
  Maximize2,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  MiniPlayerContext,
  type MiniPlayerVideo,
} from "@/components/mini-player-context";

function formatTime(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MiniPlayerProvider({ children }: { children: ReactNode }) {
  const [video, setVideo] = useState<MiniPlayerVideo | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const show = useCallback((v: MiniPlayerVideo) => {
    setVideo(v);
    setPlaying(true);
  }, []);

  const close = useCallback(() => {
    setVideo(null);
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  }, []);

  const value = useMemo(
    () => ({ video, show, close, isActive: video != null }),
    [video, show, close],
  );

  return (
    <MiniPlayerContext.Provider value={value}>
      {children}
      {video && (
        <div
          data-slot="mini-player"
          className="fixed bottom-4 right-4 z-[60] w-[320px] overflow-hidden rounded-xl border border-white/15 bg-black shadow-[0_24px_64px_-16px_rgba(0,0,0,0.9)] sm:w-[360px]"
        >
          {/* Video area */}
          <div className="group/mp relative aspect-video bg-black">
            <video
              ref={videoRef}
              src={video.videoUrl}
              poster={video.backdropUrl ?? video.posterUrl ?? undefined}
              autoPlay
              playsInline
              className="size-full object-contain"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={togglePlay}
            />

            {/* Top row: title + close */}
            <div className="absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-2 opacity-0 transition-opacity group-hover/mp:opacity-100">
              <p className="line-clamp-1 pr-2 text-xs font-medium text-white/90">
                {video.title}
              </p>
              <button
                type="button"
                onClick={close}
                aria-label="Close miniplayer"
                className="rounded-md p-1 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Bottom controls */}
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 transition-opacity group-hover/mp:opacity-100">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                className="rounded-md p-1.5 text-white transition-colors hover:bg-white/15"
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
                className="rounded-md p-1.5 text-white transition-colors hover:bg-white/15"
              >
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
              <span className="ml-auto text-[10px] font-medium tabular-nums text-white/70">
                {formatTime(videoRef.current?.currentTime ?? 0)}
              </span>
              <Link
                to={`/movie/${video.movieId}`}
                onClick={close}
                aria-label="Expand to full page"
                title="Back to movie page"
                className="rounded-md p-1.5 text-white transition-colors hover:bg-white/15"
              >
                <Maximize2 className="size-4" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </MiniPlayerContext.Provider>
  );
}
