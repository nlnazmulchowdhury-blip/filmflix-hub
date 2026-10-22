import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Search,
  Tv,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import Hls from "hls.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  FAMELACK_CREDIT,
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
    const u = new URL(url);
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

  const src = sources[Math.min(active, sources.length - 1)];

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
     long time for a manifest that is never coming. Nothing on screen after 15 s
     is a failed source, so move on to the backup — or to the cover. */
  useEffect(() => {
    if (allFailed) return;
    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && video.readyState < 3 && !video.videoWidth) advance.current();
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [src, allFailed]);

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
        video.play().catch(() => {});
      });
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

    return () => {
      destroyed = true;
      video.removeEventListener("error", onVideoError);
      if (advanceTimer.current != null) {
        window.clearTimeout(advanceTimer.current);
        advanceTimer.current = null;
      }
      if (hls) hls.destroy();
    };
  }, [src, allFailed]);

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
    if (selected || !curated || dead.current.size >= 3) return;
    const first = (curated as LiveChannel[]).find(
      (c) => isDirectStream(c.streamUrl) && !dead.current.has(c._id),
    );
    if (first) setSelected(first);
  }, [curated, selected]);

  const selectedIsDirect = selected ? isDirectStream(selected.streamUrl) : false;

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
            {/* Live viewer count — placeholder until real presence lands. */}
            <span className="hidden items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-xs font-semibold text-muted-foreground sm:inline-flex">
              <Users className="size-3.5 text-emerald-400" /> 135 watching
            </span>
            <Link to="/" className={navLinkClass}>
              Home
            </Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-3 pb-4 pt-4 sm:px-6">
        {/* Big inline player (first/selected direct stream) */}
        <section className="relative">
          {selected?.embedUrl ? (
            <div className="overflow-hidden rounded-lg border border-border/60 bg-black shadow-[0_32px_96px_-40px_rgba(0,0,0,0.9)]">
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
            <div className="overflow-hidden rounded-lg border border-border/60 bg-black shadow-[0_32px_96px_-40px_rgba(0,0,0,0.9)]">
              <div className="relative aspect-video w-full">
                <StreamPlayer
                  sources={[selected.streamUrl, ...(selected.backupUrls ?? [])]}
                  onGiveUp={() => {
                    if (tapped.current || !selected) return;
                    dead.current.add(selected._id);
                    setSelected(null);
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/40">
              {iptvLoading && !channels.length ? (
                <div className="flex flex-col items-center gap-3 px-6 text-center">
                  <Loader2 className="size-7 animate-spin text-muted-foreground" />
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Loading the live channel list…
                  </p>
                </div>
              ) : iptvFailed && !channels.length ? (
                <div className="flex flex-col items-center gap-3 px-6 text-center">
                  <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Tv className="size-6" />
                  </span>
                  <p className="font-display text-lg font-semibold">
                    The channel list did not load
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {IPTV_CREDIT.name} was not reachable. Reload to try again.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 px-6 text-center">
                  <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Tv className="size-6" />
                  </span>
                  <p className="font-display text-lg font-semibold">
                    Pick a channel below
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {search.trim()
                      ? "No direct stream matched your search."
                      : "Choose any channel from the strip underneath to start watching right here."}
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Search + country + category chips */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex shrink-0 items-center gap-2">
            <div className="relative w-full sm:w-48 md:w-56">
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
            <label className="relative inline-flex shrink-0 items-center">
              <span className="sr-only">Filter channels by country</span>
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="h-9 max-w-[150px] cursor-pointer appearance-none rounded-full border border-border/60 bg-secondary/40 py-0 pl-3 pr-7 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus:border-primary/60"
              >
                <option value="All">All countries</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {`${meta[c.code]?.flag ?? ""} ${c.name} (${c.n})`}
                  </option>
                ))}
              </select>
              <ChevronRight className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 rotate-90 text-muted-foreground" />
            </label>
            <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">
              {filtered ? `${filtered.length.toLocaleString()} channels` : "…"}
            </span>
          </div>
          {/* One scrolling row on phones instead of six wrapped chip rows. */}
          <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 sm:pb-0">
            {categories.map((c) => {
              const active = category === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  aria-pressed={active}
                  className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border/60 bg-secondary/40 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  {c !== "All" && (
                    <span
                      className={`size-1.5 rounded-full ${
                        active ? "bg-primary-foreground/80" : "bg-emerald-400"
                      }`}
                    />
                  )}
                  {c}
                </button>
              );
            })}
          </div>
        </div>

        {/* Bottom channel scroller */}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            aria-label="Scroll channels left"
            className="hidden size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-secondary/40 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:flex"
          >
            <ChevronLeft className="size-4" />
          </button>

          <div className="relative flex-1 overflow-hidden">
            <div
              ref={scrollerRef}
              className="flex gap-2.5 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:thin]"
            >
              {!filtered ? (
                <div className="flex w-full items-center justify-center py-10">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex w-full flex-col items-center gap-2 py-10 text-center">
                  <p className="text-sm font-semibold">
                    {search.trim() || country !== "All"
                      ? "No channels matched"
                      : "No channels yet"}
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
                        onClick={() => {
                          tapped.current = true;
                          setSelected(c);
                        }}
                        aria-label={`Watch ${c.name}`}
                        className={`group w-[104px] shrink-0 cursor-pointer text-left ${
                          active ? "" : "opacity-90 transition-opacity hover:opacity-100"
                        }`}
                      >
                        <div
                          className={`relative flex h-[72px] items-center justify-center overflow-hidden rounded-xl border bg-card p-2 transition-colors ${
                            active
                              ? "border-primary ring-2 ring-primary/40"
                              : "border-border/50 group-hover:border-primary/50"
                          }`}
                        >
                          <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-red-500" />
                          {c.logoUrl ? (
                            <img
                              src={c.logoUrl}
                              alt={c.name}
                              loading="lazy"
                              className="max-h-full max-w-full object-contain"
                            />
                          ) : (
                            <Tv className="size-7 text-muted-foreground/50" />
                          )}
                        </div>
                        <p className="mt-1.5 truncate px-0.5 text-[11px] font-medium text-muted-foreground">
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
                      className="flex h-[72px] w-[104px] shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/60 bg-card/40 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                    >
                      <ChevronRight className="size-4 -rotate-90" />
                      {Math.min(CHANNEL_PAGE, filtered.length - shown).toLocaleString()} more
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => scrollBy(1)}
            aria-label="Scroll channels right"
            className="hidden size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-secondary/40 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground sm:flex"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

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
        <p className="mt-3 text-[11px] text-muted-foreground">
          {channels.length.toLocaleString()} live channels from{" "}
          <a
            href={IPTV_CREDIT.url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-semibold underline-offset-2 hover:underline"
          >
            {IPTV_CREDIT.name}
          </a>
          {fam.length > 0 && (
            <>
              {" and "}
              <a
                href={FAMELACK_CREDIT.url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-semibold underline-offset-2 hover:underline"
              >
                {FAMELACK_CREDIT.name}
              </a>
            </>
          )}
          , open collections of publicly available streams. A few of them only
          play through our server, because their broadcaster blocks direct
          links.
        </p>
      </main>

      {/* Full-page player for non-direct (website) links opens in a new tab;
          direct streams play inline above, so no dialog is needed anymore. */}
    </div>
  );
}
