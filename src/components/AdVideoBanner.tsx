import { useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { API_BASE } from "@/lib/api";
import {
  HILLTOP_BANNER_VAST_TAG,
  fetchHilltopVastAds,
  ping,
  type VastAd,
} from "@/lib/vast";

/** `0:09 / 0:14`, the same clock the pre-roll uses. */
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

const ROUND =
  "flex size-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-white ring-1 ring-white/25 backdrop-blur-sm transition-colors hover:bg-white/30";

/**
 * HilltopAds' in-page video banner, played by our own element.
 *
 * The zone's snippet is only a loader for a VAST document, so the document is
 * fetched here and the creative runs in a `<video>` we control: it starts muted
 * so a browsing visitor is never ambushed by sound, it sits in one fixed card
 * rather than covering anything, and it loops — the film's player is nowhere
 * near this, so there is nothing here worth skipping. Each pass through the
 * creative is reported to the network as the fresh impression it is.
 *
 * `slot` picks which of the zone's creatives this card plays, so two cards
 * beside each other show two different ads. `minWidth` keeps a card that the
 * breakpoint hides from ever asking the network for an impression it never
 * showed.
 */
export default function AdVideoBanner({
  slot = 0,
  minWidth = 0,
}: {
  slot?: number;
  minWidth?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ad, setAd] = useState<VastAd | null>(null);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [src, setSrc] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(0);
  const fired = useRef(new Set<string>());
  const asked = useRef(false);

  /* Only ask the network once the card is actually on screen at this width. */
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= minWidth,
  );
  useEffect(() => {
    if (minWidth <= 0) return;
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [minWidth]);

  useEffect(() => {
    if (!wide || asked.current) return;
    asked.current = true;
    /* StrictMode mounts, unmounts and mounts again, and the unmount aborts this
       request — so a guard that stays set across it would leave the card asking
       for an ad it never sent. Only a request that actually settled is spent. */
    let settled = false;
    const ac = new AbortController();
    const stop = setTimeout(() => ac.abort(), 12_000);
    fetchHilltopVastAds(ac.signal, HILLTOP_BANNER_VAST_TAG)
      .then((ads) => {
        const a = ads.length ? ads[slot % ads.length] : null;
        if (a) {
          setAd(a);
          setSrc(a.videoUrl);
          setTotal(a.duration);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        settled = true;
        clearTimeout(stop);
      });
    return () => {
      clearTimeout(stop);
      ac.abort();
      if (!settled) asked.current = false;
    };
  }, [wide, slot]);

  /* Counted at the moment the creative is painted, and again on every pass
     through it — a loop is a new view, and the network has to be told. */
  useEffect(() => {
    if (!ad) return;
    fired.current = new Set(["start"]);
    ping(ad.impressions);
    ping(ad.trackings.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad, src]);

  const fireOnce = (event: string) => {
    if (!ad || fired.current.has(event)) return;
    fired.current.add(event);
    ping(ad.trackings[event]);
  };

  if (!ad) return null;

  const shown = total || videoRef.current?.duration || 0;
  const pct = shown > 0 ? Math.min(100, (elapsed / shown) * 100) : 0;

  return (
    <div className="w-full max-w-[420px] overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="relative aspect-video bg-black">
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
          onPause={() => setPaused(true)}
          onPlay={() => {
            setPaused(false);
            fireOnce("resume");
          }}
          onEnded={() => {
            fireOnce("complete");
            const el = videoRef.current;
            if (!el) return;
            el.currentTime = 0;
            el.play().catch(() => undefined);
          }}
          onError={() => {
            /* One retry through our pipe: a creative CDN that gates on Referer
               still answers a request that carries none of the browser's. */
            if (src === ad.videoUrl)
              setSrc(`${API_BASE}/embed/proxy?url=${encodeURIComponent(ad.videoUrl)}`);
            else if (ad.errorUrl) ping([ad.errorUrl.replace(/\[ERRORCODE\]/gi, "403")]);
          }}
        />

        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-1.5">
          <button
            type="button"
            aria-label={paused ? "Play ad" : "Pause ad"}
            className={ROUND}
            onClick={() => {
              const el = videoRef.current;
              if (!el) return;
              if (el.paused) el.play().catch(() => undefined);
              else el.pause();
            }}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label={muted ? "Turn ad sound on" : "Mute ad"}
            className={ROUND}
            onClick={() => {
              const el = videoRef.current;
              const next = !muted;
              setMuted(next);
              if (el) el.muted = next;
            }}
          >
            {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
          </button>
          {shown > 0 && (
            <span className="rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white/85 backdrop-blur-sm">
              {`${clock(elapsed)} / ${clock(shown)}`}
            </span>
          )}
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
