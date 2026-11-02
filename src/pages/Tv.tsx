import { Input } from "@/components/ui/input";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Search,
  Tv,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import Hls from "hls.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  IPTV_CREDIT,
  loadChannels,
  loadCountries,
  loadCustomSources,
  loadFamelack,
  mergeChannels,
  type CountryMeta,
  type LiveChannel,
} from "@/lib/iptv";

const navLinkClass =
  "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

/** Channels rendered per page. The strip is horizontal, so a few hundred logos
 *  is already more than anyone scrolls; ten thousand buttons in the DOM is not
 *  a scrolling problem but a hanging one. */
const CHANNEL_PAGE = 150;

/** True if the URL looks like a directly playable stream (HLS/DASH/MP4)
 *  rather than a website link that needs to open in a new tab. */
function isDirectStream(url: string): boolean {
  /* An owner-declared playlist also carries raw transport streams and files,
     not only HLS, and the player opens those natively. */
  const MEDIA = /\.(m3u8|m3u|mpd|mp4|ts|mkv|webm|mov)(\?|$)/i;
  if (MEDIA.test(url)) return true;
  try {
    /* `playTarget` hands back a root-relative path when the api base is one
       (`/api/embed/proxy?…`), so resolve against the page before reading the
       path — otherwise every piped channel looks like a website link. */
    const u = new URL(url, window.location.href);
    /* A pipe link is a stream by definition — and the file type it carries is
       the upstream's, so judging the link's own path would call it a website. */
    if (u.pathname.endsWith("/embed/proxy")) return true;
    return MEDIA.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

/** The media kind of a stream link, looking through our own pipe at the file
 *  behind it. Nine in ten of these playlists are HLS and the rest are a
 *  wrapper with no extension to read — a live TV list is HLS until it says
 *  otherwise, so the exceptions are named instead of the rule. */
function isHlsSource(url: string): boolean {
  let probe = url;
  try {
    probe = new URL(url, window.location.href).searchParams.get("url") || url;
  } catch {
    /* Not absolute: judge the link as it stands. */
  }
  return !/\.(mpd|mp4|mkv|mov|webm|ts)(\?|$)/i.test(probe);
}

/** Video element that plays HLS (.m3u8) via hls.js and MP4 natively.
 *  Takes an ordered list of source URLs (primary first, then backups) and
 *  automatically advances to the next one whenever the current stream dies —
 *  manifest/network errors, media errors, or the element erroring out — so a
 *  downed primary URL never stops playback as long as a backup works. */
function StreamPlayer({
  sources,
  onGiveUp,
}: {
  sources: string[];
  /** Fired once every source has failed — lets the page drop a channel it
   *  picked itself, so the viewer never opens on a dead stream's failure card. */
  onGiveUp?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Index of the URL currently being played.
  const [active, setActive] = useState(0);
  // Set once every source has been tried and failed.
  const [allFailed, setAllFailed] = useState(false);
  // Debounce: rapid duplicate error events only advance one URL at a time.
  const advanceTimer = useRef<number | null>(null);
  /* The strip is the only chrome, and it is not on screen while a live picture
     is running untouched — the viewer came for the broadcast, not for buttons. */
  const [ui, setUi] = useState(true);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [full, setFull] = useState(false);
  /* Counts arrivals of real media (manifest, fragment, metadata) so the dead-
     feed watchdog can tell "slow" from "silent". */
  const [beat, setBeat] = useState(0);
  const bump = useCallback(() => setBeat((n) => n + 1), []);

  const src = sources[Math.min(active, sources.length - 1)];

  /* Which source the element is buffering, and whether it has a picture yet.
     Keyed by src so a new source reads as "connecting" without a reset pass. */
  const [buffer, setBuffer] = useState({ src: "", waiting: true });
  const buffering = buffer.src !== src || buffer.waiting;

  const advance = useRef(() => {});
  const giveUp = useRef(onGiveUp);
  giveUp.current = onGiveUp;
  advance.current = () => {
    if (advanceTimer.current != null) return;
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      setActive((i) => {
        if (i + 1 < sources.length) return i + 1;
        setAllFailed(true);
        giveUp.current?.();
        return i;
      });
    }, 500);
  };

  // New channel (different source list) → start from the primary again.
  useEffect(() => {
    setActive(0);
    setAllFailed(false);
  }, [sources.join("|")]);

  /* A dead feed can hang without ever erroring: our pipe keeps its socket open
     while the broadcaster's server stays silent, and hls.js will wait a very
     long time for a manifest that is never coming. But a healthy feed is not
     fast either — segments here run up to 27 s, so the first picture can take
     20 s to arrive. The clock therefore restarts on every bit of progress
     (`beat`), and only 25 s of total silence counts as a failed source. */
  useEffect(() => {
    if (allFailed) return;
    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && video.readyState < 3 && !video.videoWidth) advance.current();
    }, 25000);
    return () => window.clearTimeout(timer);
  }, [src, allFailed, beat]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || allFailed) return;

    let destroyed = false;
    let hls: Hls | null = null;

    const isHls = isHlsSource(src);

    /* MSE decides, not canPlayType: Chrome/Firefox answer "maybe" for the HLS
       mime without being able to play it, and a raw playlist in their element
       fails outright. Only a browser with no MSE should get the native path. */
    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        bump();
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.LEVEL_LOADED, bump);
      hls.on(Hls.Events.FRAG_LOADED, bump);
      hls.on(Hls.Events.FRAG_BUFFERED, bump);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (destroyed || !data.fatal) return;
        advance.current();
      });
    } else {
      // Native HLS (Safari) or progressive MP4.
      video.src = src;
      video.play().catch(() => {});
    }

    const onVideoError = () => {
      if (destroyed) return;
      advance.current();
    };
    video.addEventListener("error", onVideoError);
    for (const e of ["loadedmetadata", "canplay", "playing"] as const)
      video.addEventListener(e, bump);

    return () => {
      destroyed = true;
      video.removeEventListener("error", onVideoError);
      for (const e of ["loadedmetadata", "canplay", "playing"] as const)
        video.removeEventListener(e, bump);
      if (advanceTimer.current != null) {
        window.clearTimeout(advanceTimer.current);
        advanceTimer.current = null;
      }
      if (hls) hls.destroy();
    };
  }, [src, allFailed, bump]);

  /* The element is the truth about sound and about playing: a server switch or
     a browser that refused to start audio moves it under us, and an icon that
     disagrees with it is worse than no icon. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      setPaused(video.paused);
      setMuted(video.muted);
      setVolume(video.volume);
    };
    sync();
    for (const e of ["play", "pause", "volumechange"] as const)
      video.addEventListener(e, sync);
    return () => {
      for (const e of ["play", "pause", "volumechange"] as const)
        video.removeEventListener(e, sync);
    };
  }, [src, allFailed]);

  /* A live feed buffers for a long time before its first frame — up to half a
     minute when the broadcaster publishes 27-second segments. Black silence is
     indistinguishable from "broken", so say which one it is. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || allFailed) return;
    const hold = () => setBuffer({ src, waiting: true });
    const release = () => setBuffer({ src, waiting: false });
    const settle = () => setBuffer({ src, waiting: video.readyState < 3 });
    video.addEventListener("waiting", hold);
    video.addEventListener("stalled", hold);
    video.addEventListener("playing", release);
    video.addEventListener("canplay", settle);
    video.addEventListener("loadeddata", settle);
    return () => {
      video.removeEventListener("waiting", hold);
      video.removeEventListener("stalled", hold);
      video.removeEventListener("playing", release);
      video.removeEventListener("canplay", settle);
      video.removeEventListener("loadeddata", settle);
    };
  }, [src, allFailed]);

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* A live stream has nothing to scrub, so the strip earns its place only by
     being reachable: any pointer movement brings it back, and it leaves again
     once the viewer stops reaching for it. Paused, it stays — that is the one
     moment the controls are wanted. */
  useEffect(() => {
    if (!ui || paused || allFailed) return;
    const timer = window.setTimeout(() => setUi(false), 2600);
    return () => window.clearTimeout(timer);
  }, [ui, paused, allFailed, src]);

  const wake = () => setUi(true);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
    wake();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    if (!video.muted && !video.volume) video.volume = 0.6;
    wake();
  };

  const setVol = (v: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    /* Dragging to silence means silence: leaving `muted` set would keep the
       icon crossed out with the slider back up. */
    video.muted = v === 0;
  };

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void boxRef.current?.requestFullscreen?.().catch(() => {});
    wake();
  };

  if (allFailed) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 bg-black/80 text-center">
        <Tv className="size-8 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">Stream is down</p>
        <p className="text-xs text-muted-foreground">
          All sources for this channel failed. Please try again later.
        </p>
      </div>
    );
  }

  const barClass =
    "flex cursor-pointer items-center justify-center rounded-full p-1.5 text-white/90 transition-colors hover:bg-white/15 hover:text-white";

  return (
    <div
      ref={boxRef}
      className="relative size-full bg-black"
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <video
        ref={videoRef}
        className="size-full"
        autoPlay
        playsInline
        onClick={togglePlay}
      />

      {buffering && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/35 text-white/90">
          <Loader2 className="size-7 animate-spin" />
          <span className="text-xs font-medium">Connecting…</span>
        </div>
      )}

      {/* No autoplay gesture means no picture moving, and with the browser's own
          controls gone the only way back is this — it is a play button, not a
          decoration, so it stays until the video is actually running. */}
      {paused && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute left-1/2 top-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/25 backdrop-blur-sm transition-colors hover:bg-black/70"
        >
          <Play className="size-6 fill-current" />
        </button>
      )}

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-black/45 px-2 py-1.5 backdrop-blur-[2px] transition-opacity duration-300 sm:px-3 sm:py-2 ${
          ui || paused ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* An invisible strip must not swallow taps: opacity alone still hit-tests,
            and on a phone this box sits exactly where a thumb taps to play. */}
        <div
          className={`${
            ui || paused ? "pointer-events-auto" : "pointer-events-none"
          } flex items-center gap-1 sm:gap-2`}
        >
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted || !volume ? "Unmute" : "Mute"}
            className={barClass}
          >
            {muted || !volume ? (
              <VolumeX className="size-4 sm:size-[18px]" />
            ) : (
              <Volume2 className="size-4 sm:size-[18px]" />
            )}
          </button>
          {/* Phones get the corner cluster without a slider stealing its room. */}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => setVol(Number(e.target.value))}
            aria-label="Volume"
            className="hidden h-1 w-24 cursor-pointer accent-white sm:block"
          />
          <button
            type="button"
            onClick={toggleFull}
            aria-label={full ? "Exit full screen" : "Full screen"}
            className={barClass}
          >
            {full ? (
              <Minimize2 className="size-4 sm:size-[18px]" />
            ) : (
              <Maximize2 className="size-4 sm:size-[18px]" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Close on an outside press or Escape — the menus in this app never open on
 *  hover and never stay pinned. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/** Country filter. A native `<select>` opens an OS-grey list that ignores the
 *  page's design and cannot be searched with 180 countries in it, so the list
 *  is ours: a glass panel with a finder and the counts that matter. */
function CountryPicker({
  value,
  onChange,
  countries,
  meta,
}: {
  value: string;
  onChange: (code: string) => void;
  countries: { code: string; n: number; name: string }[];
  meta: Record<string, CountryMeta>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [up, setUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  /* The toolbar sits low on a tall page, and a 180-country panel opened
     downward runs off the screen. Open toward whichever side has the room. */
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      setUp(below < 380 && r.top > below);
    }
    setOpen((v) => !v);
  };
  const current = countries.find((c) => c.code === value);
  const needle = q.trim().toLowerCase();
  const list = needle
    ? countries.filter(
        (c) => c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle,
      )
    : countries;
  const total = countries.reduce((n, c) => n + c.n, 0);

  const pick = (code: string) => {
    onChange(code);
    setOpen(false);
    setQ("");
  };
  const rowClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors ${
      active ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
    }`;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border/60 bg-secondary/40 pl-3 pr-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <span className="max-w-[9.5rem] truncate">
          {current ? `${meta[current.code]?.flag ?? ""} ${current.name}` : "All countries"}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          className={`absolute right-0 z-50 w-[min(86vw,330px)] overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_28px_70px_-24px_rgba(0,0,0,0.85)] backdrop-blur-xl ${
            up ? "bottom-full mb-2" : "top-full mt-2"
          }`}
        >
          <div className="border-b border-border/50 p-2">
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a country…"
              aria-label="Find a country"
              className="h-8 text-xs"
            />
          </div>
          <div
            role="listbox"
            aria-label="Countries"
            className="max-h-72 overflow-y-auto p-1 [scrollbar-width:thin]"
          >
            <button type="button" onClick={() => pick("All")} className={rowClass(value === "All")}>
              <span className="flex-1">All countries</span>
              <span className="tabular-nums text-[10px] text-muted-foreground">
                {total.toLocaleString()}
              </span>
              {value === "All" && <Check className="size-3.5 text-primary" />}
            </button>
            {list.map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => pick(c.code)}
                className={rowClass(value === c.code)}
              >
                <span className="w-5 shrink-0 text-center">{meta[c.code]?.flag ?? ""}</span>
                <span className="flex-1 truncate">{c.name}</span>
                <span className="tabular-nums text-[10px] text-muted-foreground">
                  {c.n.toLocaleString()}
                </span>
                {value === c.code && <Check className="size-3.5 text-primary" />}
              </button>
            ))}
            {list.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No country matched “{q.trim()}”.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Categories as one rail; the leftovers live behind “More” instead of six
 *  wrapped rows pushing the channels off a phone screen. */
function CategoryRail({
  categories,
  value,
  onChange,
}: {
  categories: string[];
  value: string;
  onChange: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const toggle = () => {
    if (!open && moreRef.current) {
      const r = moreRef.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      setUp(below < 340 && r.top > below);
    }
    setOpen((v) => !v);
  };

  const chip = (c: string) => {
    const active = value === c;
    return (
      <button
        key={c}
        type="button"
        onClick={() => onChange(c)}
        aria-pressed={active}
        className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
          active
            ? "bg-primary text-primary-foreground"
            : "border border-border/60 bg-secondary/40 text-muted-foreground hover:bg-secondary hover:text-foreground"
        }`}
      >
        {c !== "All" && (
          <span
            className={`size-1.5 rounded-full ${active ? "bg-primary-foreground/80" : "bg-primary/60"}`}
          />
        )}
        {c}
      </button>
    );
  };

  return (
    <div className="relative flex min-w-0 items-center gap-1.5" ref={ref}>
      {/* The rail scrolls; “More” does not. Pinning it keeps the leftovers one
          tap away instead of at the far end of a scroll nobody notices. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {categories.map((c) => chip(c))}
      </div>
      <button
        ref={moreRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-dashed border-border/70 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
      >
        More
        <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          className={`absolute right-0 z-50 w-[min(88vw,460px)] rounded-xl border border-border/60 bg-card p-2.5 shadow-[0_28px_70px_-24px_rgba(0,0,0,0.85)] backdrop-blur-xl ${
            up ? "bottom-full mb-2" : "top-full mt-2"
          }`}
        >
          <div className="flex flex-wrap gap-1.5">{categories.map((c) => chip(c))}</div>
        </div>
      )}
    </div>
  );
}

export default function TvPage() {
  /* Admin-added channels first: they are curated, so they are the ones most
     likely to actually be playing this minute. */
  const curated = useQuery(api.tvChannels.list);
  /** Everything iptv-org publishes for the whole world, parsed in the browser
   *  (its own CDN serves the list, so none of it costs our Worker). */
  const [iptv, setIptv] = useState<LiveChannel[]>([]);
  /** Famelack's validated dataset: mostly the same feeds, plus the ones
   *  iptv-org never carried. Merged by stream URL, so a shared feed is one
   *  card and its extra feeds become backups instead of duplicates. */
  const [fam, setFam] = useState<LiveChannel[]>([]);
  /** The lists the owner declared in `public/tv-sources.json` — their own m3u,
   *  an Xtream playlist export, a panel's channel JSON — read in the browser
   *  like the other two and merged last, so a feed of a channel already on
   *  screen becomes a backup instead of a second card. */
  const [custom, setCustom] = useState<LiveChannel[]>([]);
  /** Their labels, never their addresses: a list that did not answer is worth
   *  saying so, a box on someone's LAN is not worth printing on a public page. */
  const [customFailed, setCustomFailed] = useState<string[]>([]);
  const [iptvLoading, setIptvLoading] = useState(true);
  const [iptvFailed, setIptvFailed] = useState(false);
  const [meta, setMeta] = useState<Record<string, CountryMeta>>({});
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [country, setCountry] = useState<string>("All");
  const [shown, setShown] = useState(CHANNEL_PAGE);
  const [selected, setSelected] = useState<LiveChannel | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setIptvLoading(true);
    setIptvFailed(false);
    loadChannels()
      .then((r) => {
        if (!alive) return;
        setIptv(r.channels);
        setIptvLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setIptvFailed(true);
        setIptvLoading(false);
      });
    /* Names and flags are decoration: the strip works without them, showing
       bare country codes. */
    loadCountries()
      .then((m) => alive && setMeta(m))
      .catch(() => {});
    /* So is famelack: it adds the feeds iptv-org never carried, and if it
       cannot be reached the page still shows the whole open playlist. */
    loadFamelack()
      .then((r) => alive && setFam(r.channels))
      .catch(() => {});
    /* Decoration too, and the only one the owner controls: an empty
       tv-sources.json costs nothing, so this asks for the file and reads
       whatever it declares. */
    loadCustomSources()
      .then((r) => {
        if (!alive) return;
        setCustom(r.channels);
        setCustomFailed(r.failed);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const channels = useMemo<LiveChannel[]>(
    () => [
      ...((curated ?? []) as LiveChannel[]),
      ...mergeChannels(mergeChannels(iptv, fam), custom),
    ],
    [curated, iptv, fam, custom],
  );

  const categories = useMemo(() => {
    if (!channels.length) return ["All"];
    const set = new Set<string>();
    for (const c of channels) for (const name of c.categories ?? []) set.add(name);
    return ["All", ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [channels]);

  /** Only countries that have a channel here, with their counts — iptv-org
     lists 250 countries and roughly 180 of them have something working. */
  const countries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of channels) {
      if (!c.country) continue;
      counts.set(c.country, (counts.get(c.country) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([code, n]) => ({ code, n, name: meta[code]?.name ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, meta]);

  const filtered = useMemo(() => {
    if (!channels.length) return iptvLoading ? null : [];
    const q = search.trim().toLowerCase();
    return channels.filter((c) => {
      if (category !== "All" && !(c.categories ?? []).includes(category)) return false;
      if (country !== "All" && c.country !== country) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (meta[c.country ?? ""]?.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [channels, category, country, search, meta, iptvLoading]);

  /* A new filter is a new list, so the window starts over rather than leaving
     the viewer staring at page three of a shorter result. */
  useEffect(() => {
    setShown(CHANNEL_PAGE);
  }, [category, country, search]);

  // Auto-select the first channel so the big player is never empty — but only
  // from the curated rows. Auto-playing one of ten thousand stranger feeds
  // would put a random live stream on screen that nobody asked for.
  const tapped = useRef(false);
  /* Admin rows are curated but not necessarily alive, so a dead auto-pick is
     dropped rather than left on screen as a failure card. Three tries is the
     limit: past that the strip is the honest answer. */
  const dead = useRef(new Set<string>());
  useEffect(() => {
    if (tapped.current || selected || !curated || dead.current.size >= 3) return;
    const first = (curated as LiveChannel[]).find(
      (c) => isDirectStream(c.streamUrl) && !dead.current.has(c._id),
    );
    if (first) setSelected(first);
  }, [curated, selected]);

  /* The empty stage is the first thing a visitor sees, so it offers a way in
     instead of a sign pointing down at the strip. */
  const quick = useMemo(
    () =>
      (filtered ?? channels)
        .filter((c) => c.embedUrl || isDirectStream(c.streamUrl))
        .slice(0, 6),
    [filtered, channels],
  );

  const selectedIsDirect = selected ? isDirectStream(selected.streamUrl) : false;
  const selectedCountry = selected
    ? meta[selected.country ?? ""]?.name ?? selected.country ?? ""
    : "";

  const openChannel = (c: LiveChannel) => {
    tapped.current = true;
    /* A channel that is only a website has no stream to open in the player;
       it belongs in a tab of its own. */
    if (c.embedUrl || isDirectStream(c.streamUrl)) setSelected(c);
    else window.open(c.streamUrl, "_blank", "noopener,noreferrer");
  };

  const closeStage = () => {
    tapped.current = true;
    setSelected(null);
  };

  const scrollBy = (dir: 1 | -1) => {
    scrollerRef.current?.scrollBy({ left: dir * 480, behavior: "smooth" });
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-2 px-3 sm:h-16 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Link to="/" aria-label="FilmFlix home" className="shrink-0">
              <Logo />
            </Link>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary sm:px-2.5 sm:text-xs">
              <Tv className="size-3" /> Live TV
            </span>
          </div>
          <nav className="flex shrink-0 items-center gap-2 sm:gap-4">
            <Link to="/" className={navLinkClass}>
              Home
            </Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col px-3 pb-24 pt-4 sm:px-6 sm:pt-5 md:pb-6">
        <h1 className="mb-3 font-display text-xl font-semibold leading-tight sm:text-3xl">
          Live TV
        </h1>

        {/* The stage is capped, not stretched: a 1400px-wide empty black box
            pushed the controls off the screen and left nothing in it. */}
        <section className="relative isolate mx-auto w-full max-w-[820px]">
          {selected?.embedUrl ? (
            <div className="overflow-hidden rounded-2xl border border-border/60 bg-black shadow-[0_36px_100px_-44px_rgba(0,0,0,0.95)]">
              <div className="relative aspect-video w-full">
                {/* A YouTube live page, not a stream: no <video> element can open
                    it, so this is the one channel we show as a frame. */}
                <iframe
                  key={selected.embedUrl}
                  src={selected.embedUrl}
                  title={selected.name}
                  className="size-full"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              </div>
            </div>
          ) : selected && selectedIsDirect ? (
            <div className="overflow-hidden rounded-2xl border border-border/60 bg-black shadow-[0_36px_100px_-44px_rgba(0,0,0,0.95)]">
              <div className="relative aspect-video w-full">
                <StreamPlayer
                  sources={[selected.streamUrl, ...(selected.backupUrls ?? [])]}
                  onGiveUp={() => {
                    if (!selected) return;
                    dead.current.add(selected._id);
                    setSelected(null);
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="relative flex min-h-[220px] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-border/60 bg-[#070b14] px-4 py-6 text-center sm:aspect-video sm:gap-4 sm:py-0">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(59,130,246,0.20),transparent_62%)]" />
              {iptvLoading && !channels.length ? (
                <div className="relative z-10 flex flex-col items-center gap-3">
                  <Loader2 className="size-7 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">
                    Loading the live channel list…
                  </p>
                </div>
              ) : iptvFailed && !channels.length ? (
                <div className="relative z-10 flex flex-col items-center gap-2.5">
                  <span className="flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary">
                    <Tv className="size-6" />
                  </span>
                  <p className="font-display text-lg font-semibold">
                    The channel list did not load
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {IPTV_CREDIT.name} was not reachable.
                  </p>
                  <button
                    type="button"
                    onClick={() => setReloadKey((n) => n + 1)}
                    className="mt-1 cursor-pointer rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <div className="relative z-10 flex w-full max-w-[560px] flex-col items-center gap-2.5">
                  <span className="flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary shadow-[0_0_44px_-10px_rgba(59,130,246,0.65)] sm:size-14">
                    <Tv className="size-6 sm:size-7" />
                  </span>
                  <p className="font-display text-lg font-semibold sm:text-xl">
                    {search.trim() ? "Nothing matched" : "Pick a channel"}
                  </p>
                  {quick.length > 0 && (
                    <div className="mt-1 hidden w-full grid-cols-3 gap-2 sm:grid">
                      {quick.map((c) => (
                        <button
                          key={c._id}
                          type="button"
                          onClick={() => openChannel(c)}
                          title={c.name}
                          className="group flex min-w-0 items-center gap-2 rounded-xl border border-border/50 bg-card/70 px-2 py-1.5 text-left backdrop-blur transition-colors hover:border-primary/50 hover:bg-card"
                        >
                          <span className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-secondary/70 text-[10px] font-bold uppercase text-muted-foreground">
                            <span className="flex size-full items-center justify-center">
                              {meta[c.country ?? ""]?.flag ?? c.name.slice(0, 2)}
                            </span>
                            {c.logoUrl && (
                              <img
                                src={c.logoUrl}
                                alt=""
                                loading="lazy"
                                onLoad={(e) =>
                                  e.currentTarget.previousElementSibling?.classList.add("hidden")
                                }
                                onError={(e) => e.currentTarget.remove()}
                                className="absolute inset-0 size-full object-contain"
                              />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-semibold text-foreground">
                              {c.name}
                            </span>
                            <span className="block truncate text-[10px] text-muted-foreground">
                              {meta[c.country ?? ""]?.flag ?? ""}{" "}
                              {meta[c.country ?? ""]?.name ?? c.country ?? ""}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* While a channel plays, the stage says which one and offers a way
            out — ending a broadcast needs a visible target, not a guess. */}
        {selected && (selectedIsDirect || selected.embedUrl) && (
          <div className="mx-auto mt-2 flex w-full max-w-[820px] items-center gap-2.5 rounded-xl border border-border/60 bg-card/60 px-3 py-2 backdrop-blur">
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-400">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" /> Live
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{selected.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {meta[selected.country ?? ""]?.flag ?? ""} {selectedCountry}
                {(selected.categories ?? []).length > 0 &&
                  ` · ${(selected.categories ?? []).slice(0, 2).join(" · ")}`}
              </p>
            </div>
            <button
              type="button"
              onClick={closeStage}
              aria-label="Close player"
              className="shrink-0 cursor-pointer rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {/* One glass toolbar: finder, country, categories. It owns the stacking
            context its menus open in, so a lifted stage never paints over them. */}
        <div className="relative z-30 mt-4 rounded-2xl border border-border/60 bg-card/50 p-2.5 backdrop-blur-xl sm:p-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-[280px]">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search channels…"
                className="h-9 pl-9 pr-8 text-sm"
                aria-label="Search TV channels"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            {/* Countries are a picker, not chips: iptv-org has ~180 of them with
                something live, and no chip row survives that on a phone. */}
            <CountryPicker
              value={country}
              onChange={setCountry}
              countries={countries}
              meta={meta}
            />
            <span className="ml-auto hidden shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground sm:block">
              {filtered ? `${filtered.length.toLocaleString()} channels` : "…"}
            </span>
          </div>
          <div className="mt-2">
            <CategoryRail
              categories={categories}
              value={category}
              onChange={setCategory}
            />
          </div>
        </div>

        {/* Channel strip */}
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="font-display shrink-0 text-sm font-semibold sm:text-base">
                Channels
              </h2>
              <span className="truncate text-[11px] font-semibold text-muted-foreground">
                {filtered ? `${filtered.length.toLocaleString()} found` : "…"}
                {category !== "All" && ` · ${category}`}
                {country !== "All" && ` · ${meta[country]?.name ?? country}`}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => scrollBy(-1)}
                aria-label="Scroll channels left"
                className="hidden size-8 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-secondary/40 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:flex"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => scrollBy(1)}
                aria-label="Scroll channels right"
                className="hidden size-8 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-secondary/40 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:flex"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>

          {/* A phone scrolls down, not sideways: below `sm` the same tiles are a
              grid of rows and columns, and the strip returns on wider screens. */}
          <div
            ref={scrollerRef}
            className="grid grid-cols-3 gap-2 pb-2 [scrollbar-width:thin] sm:flex sm:gap-2 sm:overflow-x-auto sm:scroll-smooth"
          >
            {!filtered ? (
              <div className="col-span-full flex w-full items-center justify-center py-10">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="col-span-full flex w-full flex-col items-center gap-2 py-10 text-center">
                <p className="text-sm font-semibold">
                  {search.trim() || country !== "All" ? "No channels matched" : "No channels yet"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {search.trim() || country !== "All"
                    ? "Try a different spelling, or pick another country."
                    : "Live TV channels will appear here once an admin adds them."}
                </p>
              </div>
            ) : (
              <>
                {filtered.slice(0, shown).map((c) => {
                  const active = selected?._id === c._id;
                  return (
                    <button
                      key={c._id}
                      type="button"
                      onClick={() => openChannel(c)}
                      aria-label={`Watch ${c.name}`}
                      className="group min-w-0 cursor-pointer text-left sm:w-[100px] sm:shrink-0"
                    >
                      <div
                        className={`relative flex h-[68px] items-center justify-center overflow-hidden rounded-xl border bg-card p-2 transition-colors ${
                          active
                            ? "border-primary ring-2 ring-primary/40"
                            : "border-border/50 group-hover:border-primary/50"
                        }`}
                      >
                        <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-red-500" />
                        {/* A logo host that refuses leaves no picture, and the
                            browser's alt text is not a logo — show the country
                            code until a real image paints over it. */}
                        <span className="relative flex size-full items-center justify-center">
                          <span className="flex size-full items-center justify-center text-xs font-bold uppercase tracking-wide text-muted-foreground/60">
                            {meta[c.country ?? ""]?.flag ?? c.name.slice(0, 2)}
                          </span>
                          {c.logoUrl && (
                            <img
                              src={c.logoUrl}
                              alt=""
                              loading="lazy"
                              onLoad={(e) =>
                                e.currentTarget.previousElementSibling?.classList.add("hidden")
                              }
                              onError={(e) => e.currentTarget.remove()}
                              className="absolute inset-0 size-full object-contain"
                            />
                          )}
                        </span>
                      </div>
                      <p
                        className={`mt-1.5 truncate px-0.5 text-[11px] font-medium ${
                          active ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {/* A flag tells the viewer which of these is theirs
                            once every country is on screen at once. */}
                        {meta[c.country ?? ""]?.flag ?? ""} {c.name}
                      </p>
                    </button>
                  );
                })}
                {filtered.length > shown && (
                  <button
                    type="button"
                    onClick={() => setShown((n) => n + CHANNEL_PAGE)}
                    aria-label="Load more channels"
                    className="col-span-3 flex h-11 w-full shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/60 bg-card/40 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground sm:col-span-1 sm:h-[68px] sm:w-[100px]"
                  >
                    <ChevronRight className="size-4 -rotate-90" />
                    {Math.min(CHANNEL_PAGE, filtered.length - shown).toLocaleString()} more
                  </button>
                )}
              </>
            )}
          </div>
        </section>

        {/* Where all of this comes from: the open list is what makes the page
            ten thousand channels instead of the handful an admin could add. */}
        {iptvFailed && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {IPTV_CREDIT.name} was not reachable just now, so only the channels
            an admin added are listed.{" "}
            <button
              type="button"
              onClick={() => setReloadKey((n) => n + 1)}
              className="cursor-pointer font-semibold underline underline-offset-2 hover:text-foreground"
            >
              Try again
            </button>
          </p>
        )}
        {/* A playlist the owner declared that refused to answer is worth saying
            out loud: without it the channels it carries are simply missing, and
            a missing channel looks like a bug in the page. */}
        {customFailed.length > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {customFailed.join(", ")} did not answer just now, so the channels it
            lists are not here.{" "}
            <button
              type="button"
              onClick={() => setReloadKey((n) => n + 1)}
              className="cursor-pointer font-semibold underline underline-offset-2 hover:text-foreground"
            >
              Try again
            </button>
          </p>
        )}
      </main>

      {/* Full-page player for non-direct (website) links opens in a new tab;
          direct streams play inline above, so no dialog is needed anymore. */}
    </div>
  );
}
