import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AdSideRail from "@/components/AdSideRail";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  Tv,
  Users,
  X,
} from "lucide-react";
import Hls from "hls.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

const navLinkClass =
  "text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

/** True if the URL looks like a directly playable stream (HLS/DASH/MP4)
 *  rather than a website link that needs to open in a new tab. */
function isDirectStream(url: string): boolean {
  if (url.endsWith(".m3u8") || url.endsWith(".mpd") || url.endsWith(".mp4"))
    return true;
  // Common free public HLS test/prod hosts embed the stream directly.
  try {
    const u = new URL(url);
    return /\.(m3u8|mpd|mp4)(\?|$)/.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

/** Video element that plays HLS (.m3u8) via hls.js and MP4 natively. */
function StreamPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const isHls = src.includes(".m3u8");
    if (!isHls) {
      video.src = src;
      video.play().catch(() => {});
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari plays HLS natively.
      video.src = src;
      video.play().catch(() => {});
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      return () => {
        hls.destroy();
      };
    }

    video.src = src;
  }, [src]);

  return (
    <video
      ref={videoRef}
      className="size-full"
      controls
      autoPlay
      playsInline
    />
  );
}

export default function TvPage() {
  const channels = useQuery(api.tvChannels.list);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [selected, setSelected] = useState<Doc<"tvChannels"> | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const categories = useMemo(() => {
    if (!channels) return ["All"];
    const set = new Set<string>();
    for (const c of channels)
      for (const name of c.categories ?? []) set.add(name);
    return ["All", ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [channels]);

  const filtered = useMemo(() => {
    if (!channels) return null;
    const q = search.trim().toLowerCase();
    return channels.filter((c) => {
      if (category !== "All" && !(c.categories ?? []).includes(category))
        return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q);
    });
  }, [channels, category, search]);

  // Auto-select the first channel so the big player is never empty.
  useEffect(() => {
    if (!selected && filtered && filtered.length > 0) {
      const first = filtered.find((c) => isDirectStream(c.streamUrl));
      if (first) setSelected(first);
    }
  }, [filtered, selected]);

  const selectedIsDirect = selected ? isDirectStream(selected.streamUrl) : false;

  const scrollBy = (dir: 1 | -1) => {
    scrollerRef.current?.scrollBy({ left: dir * 480, behavior: "smooth" });
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#0d0d17] text-foreground">
      {/* Banner ads on the far edges (same rails as landing/movie detail). */}
      <AdSideRail side="left" breakpoint="wide" />
      <AdSideRail side="right" breakpoint="wide" />

      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-[#0d0d17]/95 backdrop-blur">
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
          {selected && selectedIsDirect ? (
            <div className="overflow-hidden rounded-lg border border-border/60 bg-black shadow-[0_32px_96px_-40px_rgba(0,0,0,0.9)]">
              <div className="relative aspect-video w-full">
                <StreamPlayer src={selected.streamUrl} />
              </div>
            </div>
          ) : (
            <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/40">
              {!channels ? (
                <Loader2 className="size-7 animate-spin text-muted-foreground" />
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

        {/* Search + category chips */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
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
          {categories.map((c) => {
            const active = category === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={active}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
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
                    {search.trim() ? "No channels matched" : "No channels yet"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {search.trim()
                      ? "Try a different spelling."
                      : "Live TV channels will appear here once an admin adds them."}
                  </p>
                </div>
              ) : (
                filtered.map((c) => {
                  const active = selected?._id === c._id;
                  return (
                    <button
                      key={c._id}
                      type="button"
                      onClick={() => setSelected(c)}
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
                        {c.name}
                      </p>
                    </button>
                  );
                })
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

      </main>

      {/* Full-page player for non-direct (website) links opens in a new tab;
          direct streams play inline above, so no dialog is needed anymore. */}
    </div>
  );
}
