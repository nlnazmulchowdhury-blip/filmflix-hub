import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, SkipForward, Volume2, VolumeX } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { adSkipSeconds, ping, type VastAd } from "@/lib/vast";

/** How long we wait for a creative to produce a picture before giving the box
 *  back. An ad that never paints is a black rectangle over a film that is
 *  already loading — worth nothing to the viewer and nothing to the network. */
const PAINT_AFTER = 7;

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
 * separate element on top of the stage and it starts muted so it can never steal
 * the film's sound. The creative gets its full length — however many seconds or
 * minutes the network asked for — and gives the box back when it ends by itself
 * or when the viewer skips it, which is theirs after five seconds.
 */
export default function PreRollAd({ ad, onDone }: { ad: VastAd; onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [wide, setWide] = useState(false);
  const [src, setSrc] = useState(ad.videoUrl);
  const [elapsed, setElapsed] = useState(0);
  const [mediaTotal, setMediaTotal] = useState(0);
  const fired = useRef(new Set<string>());
  /** Where the ad's monotonic clock has got to, in seconds. */
  const clockRef = useRef(0);
  /** Latest copy of the clock's `advance`, so the wall timer below never has to
      be re-armed when the ad's length arrives. */
  const advanceRef = useRef<(at: number) => void>(() => undefined);
  /** True once the creative has produced a frame. Until then the ad's clock is
      this box's own second hand — see the two timers below. */
  const playingRef = useRef(false);
  /** True once the viewer pressed the sound button: their choice outranks our
      guarantee, so the re-mute guard below stands down. */
  const touchedSound = useRef(false);

  /* The creative runs as long as the network said it runs. Its declared length
     is the promise, so it outranks the file's own — a 15-second spot delivered as
     a longer file ends at fifteen, and one that never declared anything gets the
     element's duration instead. */
  const total = ad.duration > 0 ? ad.duration : mediaTotal;

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

  /* Mute is written on the element, not only asked of it. `muted={true}` in the
     markup is what the browser sees at the moment it picks the source, but the
     guarantee we care about is the one the autoplay policy checks: an element
     that is audible has to wait for a gesture, and a viewer who never taps the
     box would then stare at a black rectangle for the whole gap. So the element
     is silenced here, before the first `play()`, and re-silenced if anything
     else in the page unmutes it while the ad still has no picture. */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = true;
    el.play().catch(() => undefined);
    const guard = () => {
      if (!el.muted && !playingRef.current && !touchedSound.current) el.muted = true;
    };
    const id = window.setInterval(guard, 400);
    el.addEventListener("playing", guard);
    return () => {
      window.clearInterval(id);
      el.removeEventListener("playing", guard);
    };
  }, [src]);

  const fireOnce = (event: string) => {
    if (fired.current.has(event)) return;
    fired.current.add(event);
    ping(ad.trackings[event]);
  };

  /* The ad's clock, moved forward by whichever hand is further on: the wall
     while the creative has no frame, the media once it has. Monotonic on
     purpose — a creative that stalls for four seconds and then starts at its own
     0:00 must not hand back a Skip the viewer was already owed. */
  const advance = (at: number) => {
    if (at <= clockRef.current) return;
    clockRef.current = at;
    setElapsed(at);
    const len = total || videoRef.current?.duration || 0;
    if (len > 0) {
      if (at >= len * 0.25) fireOnce("firstQuartile");
      if (at >= len * 0.5) fireOnce("midpoint");
      if (at >= len * 0.75) fireOnce("thirdQuartile");
    }
    /* The creative's length is its own limit, whichever clock reached it first:
       an element that stalls at 0:12 of a 0:10 ad must not keep the box. */
    if (len > 0 && at >= len) {
      fireOnce("complete");
      onDone();
    }
  };
  advanceRef.current = advance;

  /* The wall hand: a viewer held on a black box with a countdown that never
     moves has been told a lie instead of being given a way out. */
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      const el = videoRef.current;
      /* A hand only counts while it is actually moving: a viewer who pauses the
         creative leaves the media clock sitting ahead of a frame they are still
         looking at, and the line must not run out from under them. */
      const media = el && !el.paused && playingRef.current ? el.currentTime : 0;
      advanceRef.current(Math.max((Date.now() - started) / 1000, media));
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  /* The way out: a creative that never paints must not keep the stage. */
  useEffect(() => {
    const stop = setTimeout(() => {
      if (playingRef.current) return;
      if (ad.errorUrl) ping([ad.errorUrl.replace(/\[ERRORCODE\]/gi, "403")]);
      onDone();
    }, PAINT_AFTER * 1000);
    return () => clearTimeout(stop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Five seconds of the creative's own clock, never more: after that the way out
     is the viewer's to take, and they may leave without ending the ad early. */
  const skipAt = adSkipSeconds(ad);
  const canSkip = elapsed >= skipAt;
  /* The button counts down to the moment the viewer may leave, not to the end of
     the creative — a 44-second ad that says "skip in 41s" when it will let them
     go in six reads as a lie. */
  const toSkip = Math.max(0, Math.ceil(skipAt - elapsed));
  const shown = total;
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
        muted
        autoPlay
        playsInline
        className="absolute inset-0 size-full bg-black object-contain"
        onClick={() => {
          fireOnce("click");
          if (ad.clickThrough) window.open(ad.clickThrough, "_blank", "noopener,noreferrer");
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setMediaTotal(d);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (!playingRef.current && el.readyState >= 2 && el.currentTime > 0) {
            playingRef.current = true;
          }
          if (playingRef.current && !el.paused) advance(el.currentTime);
        }}
        onPlay={() => {
          setPaused(false);
          fireOnce("resume");
        }}
        onPlaying={() => {
          playingRef.current = true;
          setPaused(false);
        }}
        onPause={() => {
          setPaused(true);
          fireOnce("pause");
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
          through a paid impression. `touch-manipulation` matters more than it
          looks: without it a phone holds the first tap for a possible
          double-tap-zoom, and a viewer who means Skip gets nothing. */}
      <div className="absolute inset-x-0 bottom-0 [&_button]:touch-manipulation">
        <div className="flex items-center justify-between gap-2 p-2 pb-3 sm:p-3">
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
                touchedSound.current = true;
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
              /* The whole creative is a clickable surface, so a Skip tap that
                 lands a few pixels off opens the advertiser's page instead. The
                 way out therefore gets the biggest target on the bar, and it
                 keeps a label at every width — an icon alone is a guess. */
              onClick={() => {
                if (!canSkip) return;
                fireOnce("skip");
                onDone();
              }}
              disabled={!canSkip}
              className="pointer-events-auto flex min-h-11 items-center gap-1.5 rounded-full bg-black/70 px-4 py-2 text-xs font-semibold text-white backdrop-blur-sm transition-colors enabled:hover:bg-black/90 disabled:opacity-60"
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
