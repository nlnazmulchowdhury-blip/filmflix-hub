import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, SkipForward, Volume2, VolumeX } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { ping, type VastAd } from "@/lib/vast";

/** How long a viewer can be held on an ad before they may leave: the film is
 *  waiting behind this box, and a trapped viewer blames the site rather than the
 *  network. A creative that offers a way out sooner gets the sooner one. */
const SKIP_AFTER = 5;

/** `0:09 / 0:10`, the way the reference skin writes the ad's clock. */
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

const ROUND =
  "flex size-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-white ring-1 ring-white/25 backdrop-blur-sm transition-colors hover:bg-white/30";

/**
 * One HilltopAds VAST creative, played by our own media element while the film
 * is still loading. Nothing about the film's player is handed over: this is a
 * separate element on top of the stage, it starts muted so it can never steal
 * the film's sound, and it is gone the moment the first frame of the movie
 * arrives — even mid-ad.
 */
export default function PreRollAd({ ad, onDone }: { ad: VastAd; onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [wide, setWide] = useState(false);
  const [src, setSrc] = useState(ad.videoUrl);
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(ad.duration);
  const fired = useRef(new Set<string>());

  /* Full-screen is asked of this box, so the icon has to follow what the browser
     actually did rather than what we last wanted. */
  useEffect(() => {
    const sync = () => setWide(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  /* Impressions are counted once per creative, at the moment it is painted. */
  useEffect(() => {
    ping(ad.impressions);
    fired.current.add("start");
    ping(ad.trackings.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fireOnce = (event: string) => {
    if (fired.current.has(event)) return;
    fired.current.add(event);
    ping(ad.trackings[event]);
  };

  const skipAt = Math.min(ad.skipOffset ?? SKIP_AFTER, SKIP_AFTER);
  const canSkip = elapsed >= skipAt;
  /* The button counts down to the moment the viewer may leave, not to the end of
     the creative — a 44-second ad that says "skip in 41s" when it will let them
     go in six reads as a lie. */
  const toSkip = Math.max(0, Math.ceil(skipAt - elapsed));
  const shown = total || videoRef.current?.duration || 0;
  const pct = shown > 0 ? Math.min(100, (elapsed / shown) * 100) : 0;

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 z-[63] select-none bg-black"
      /* The stage toggles playback on a box click; a tap on the ad, its skip or
         its mute must never reach that handler. */
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        autoPlay
        playsInline
        className="absolute inset-0 size-full bg-black object-contain"
        onClick={() => {
          fireOnce("click");
          ping(ad.trackings.click);
          if (ad.clickThrough) window.open(ad.clickThrough, "_blank", "noopener,noreferrer");
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setTotal((t) => t || d);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          const at = el.currentTime;
          setElapsed(at);
          const len = total || el.duration || 0;
          if (len > 0) {
            if (at >= len * 0.25) fireOnce("firstQuartile");
            if (at >= len * 0.5) fireOnce("midpoint");
            if (at >= len * 0.75) fireOnce("thirdQuartile");
          }
        }}
        onPause={() => {
          setPaused(true);
          fireOnce("pause");
        }}
        onPlay={() => {
          setPaused(false);
          fireOnce("resume");
        }}
        onEnded={() => {
          fireOnce("complete");
          onDone();
        }}
        onError={() => {
          /* One retry through our pipe: an ad CDN that gates on Referer still
             answers a request that carries none of the browser's. If that fails
             too, the ad is abandoned — the movie must not be made to wait for a
             creative that will not paint. */
          if (src === ad.videoUrl)
            setSrc(`${API_BASE}/embed/proxy?url=${encodeURIComponent(ad.videoUrl)}`);
          else {
            /* 403 is the VAST code for "the creative would not display", which is
               exactly what the network needs to know it lost this impression. */
            if (ad.errorUrl) ping([ad.errorUrl.replace(/\[ERRORCODE\]/gi, "403")]);
            onDone();
          }
        }}
      />

      {/* The reference skin: round transport buttons along the left, the way out
          along the right, and the ad's own progress line on the bottom edge. The
          line is a read-out, not a scrubber — no network lets a viewer jump
          through a paid impression. */}
      <div className="absolute inset-x-0 bottom-0">
        <div className="flex items-center justify-between gap-2 p-2 sm:p-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const el = videoRef.current;
                if (!el) return;
                if (el.paused) el.play().catch(() => undefined);
                else el.pause();
              }}
              aria-label={paused ? "Play ad" : "Pause ad"}
              className={ROUND}
            >
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            </button>
            <button
              type="button"
              onClick={() => {
                const el = videoRef.current;
                const next = !muted;
                setMuted(next);
                if (el) el.muted = next;
              }}
              aria-label={muted ? "Turn ad sound on" : "Mute ad"}
              className={ROUND}
            >
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            {shown > 0 && (
              <span className="rounded-full bg-black/45 px-2.5 py-1 text-xs font-semibold tabular-nums text-white/85 backdrop-blur-sm">
                {`${clock(elapsed)} / ${clock(shown)}`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!canSkip) return;
                fireOnce("skip");
                onDone();
              }}
              disabled={!canSkip}
              className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm transition-colors enabled:hover:bg-black/90 disabled:opacity-60"
            >
              {canSkip ? "Skip" : `Skip in ${toSkip}s`}
              {canSkip && <SkipForward className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => {
                if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
                else wrapRef.current?.requestFullscreen().catch(() => undefined);
              }}
              aria-label={wide ? "Exit full screen" : "Full screen"}
              className={ROUND}
            >
              {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          </div>
        </div>
        <div className="h-[3px] w-full bg-white/25">
          <div
            className="h-full bg-amber-400 transition-[width] duration-200 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
