import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "convex/react";
import {
  Loader2,
  Search,
  Tv,
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

function ChannelCard({
  channel,
  onPlay,
}: {
  channel: Doc<"tvChannels">;
  onPlay: (c: Doc<"tvChannels">) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPlay(channel)}
      className="group text-left"
      aria-label={`Watch ${channel.name}`}
    >
      <Card className="overflow-hidden p-0 transition-colors group-hover:border-primary/50">
        <CardContent className="flex flex-col items-center gap-3 p-4">
          <div className="flex h-20 w-full items-center justify-center overflow-hidden rounded-lg bg-muted">
            {channel.logoUrl ? (
              <img
                src={channel.logoUrl}
                alt={channel.name}
                loading="lazy"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <Tv className="size-8 text-muted-foreground/50" />
            )}
          </div>
          <div className="w-full text-center">
            <p className="truncate text-sm font-semibold">{channel.name}</p>
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </span>
              Live
            </span>
          </div>
        </CardContent>
      </Card>
    </button>
  );
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
  const { user } = useAuth();
  const channels = useQuery(api.tvChannels.list);
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState<Doc<"tvChannels"> | null>(null);

  const filtered = useMemo(() => {
    if (!channels) return null;
    const q = search.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) => c.name.toLowerCase().includes(q));
  }, [channels, search]);

  // Lock body scroll while the player dialog is open.
  useEffect(() => {
    if (!playing) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [playing]);

  const openChannel = (c: Doc<"tvChannels">) => {
    if (isDirectStream(c.streamUrl)) {
      setPlaying(c);
    } else {
      // Website link (e.g. an embed page): open in a new tab.
      window.open(c.streamUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20%] h-[420px] w-[700px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 glass-panel border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-2 px-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link to="/" aria-label="FilmFlix home">
              <Logo />
            </Link>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
              <Tv className="size-3" /> Live TV
            </span>
          </div>
          <nav className="flex items-center gap-4">
            <Link to="/" className={navLinkClass}>
              Home
            </Link>
            {user?.role === "admin" && (
              <Link to="/nazmul" className={navLinkClass}>
                Admin
              </Link>
            )}
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-3 pb-24 pt-6 sm:px-6 sm:pt-8">
        <div className="mb-6">
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Live TV Channels
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Watch live channels right in your browser — pick a channel and
            press play.
          </p>
        </div>

        {/* Search */}
        <div className="relative mb-6 max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search channels…"
            className="pl-9 pr-9"
            aria-label="Search TV channels"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {!filtered ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="flex h-40 animate-pulse flex-col items-center gap-3 rounded-xl border border-border/50 bg-card/50 p-4"
              >
                <div className="h-20 w-full rounded-lg bg-muted/60" />
                <div className="h-3.5 w-2/3 rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Tv className="size-6" />
              </span>
              <p className="font-display text-lg font-semibold">
                {search.trim() ? "No channels matched" : "No channels yet"}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {search.trim()
                  ? "Try a different spelling."
                  : "Live TV channels will appear here once an admin adds them."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {filtered.map((c) => (
              <ChannelCard key={c._id} channel={c} onPlay={openChannel} />
            ))}
          </div>
        )}
      </main>

      {/* Inline player for direct streams */}
      <Dialog open={playing !== null} onOpenChange={(o) => !o && setPlaying(null)}>
        <DialogContent className="max-w-3xl overflow-hidden p-0 sm:rounded-xl">
          {playing && (
            <>
              <DialogHeader className="sr-only">
                <DialogTitle>{playing.name} — live stream</DialogTitle>
                <DialogDescription>
                  Now watching {playing.name} on FilmFlix.
                </DialogDescription>
              </DialogHeader>
              <div className="relative aspect-video w-full bg-black">
                <StreamPlayer src={playing.streamUrl} />
                <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-red-500" />
                  </span>
                  LIVE
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
                <p className="truncate text-sm font-semibold">{playing.name}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(playing.streamUrl, "_blank", "noopener,noreferrer")}
                >
                  Open in new tab
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
