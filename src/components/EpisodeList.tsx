import { useMemo, useState } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Download,
  LayoutGrid,
  List,
  Play,
  Search,
  SkipForward,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface EpisodeRow {
  key: string;
  episode: number;
  title: string;
  overview?: string;
  stillUrl?: string | null;
  runtimeSec?: number | null;
  airDate?: string | null;
  /** Set when the admin uploaded this episode — plays the file directly. */
  videoUrl?: string | null;
}

export interface SeasonOption {
  season: number;
  name: string;
  episodeCount: number;
}

/** Runtime + first-air date, shown under the synopsis ("60m · 2013-09-12"). */
function episodeMeta(row: EpisodeRow): string {
  const parts: string[] = [];
  if (row.runtimeSec) parts.push(`${Math.round(row.runtimeSec / 60)}m`);
  if (row.airDate) parts.push(row.airDate);
  return parts.join(" · ");
}

/** TV images are hot-linked and some slots are empty — drop the <img>
 *  cleanly instead of showing a broken-icon rectangle over the row. */
function Still({
  src,
  alt,
  className,
}: {
  src?: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex size-full items-center justify-center bg-muted/60 text-[10px] text-muted-foreground",
          className,
        )}
      >
        no still
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("size-full object-cover", className)}
    />
  );
}

export default function EpisodeList({
  rows,
  seasons,
  season,
  seasonName,
  activeKey,
  loading,
  canGoNext,
  onSeason,
  onPlay,
  onNext,
  onDownload,
}: {
  rows: EpisodeRow[];
  seasons: SeasonOption[];
  season: number;
  seasonName?: string;
  activeKey?: string | null;
  loading?: boolean;
  canGoNext?: boolean;
  onSeason: (season: number) => void;
  onPlay: (row: EpisodeRow) => void;
  onNext?: () => void;
  /** Pass a handler to light up the per-row download button. */
  onDownload?: (row: EpisodeRow) => void;
}) {
  const [query, setQuery] = useState("");
  const [newest, setNewest] = useState(false);
  const [grid, setGrid] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = !q
      ? rows
      : rows.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            (r.overview ?? "").toLowerCase().includes(q),
        );
    return newest ? [...matched].reverse() : matched;
  }, [rows, query, newest]);

  return (
    <section aria-label="Episodes" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-display flex items-center gap-2 text-lg font-bold tracking-tight">
          <List className="size-5 text-primary" />
          Episodes
          {seasonName && (
            <span className="text-sm font-medium text-muted-foreground">
              {seasonName}
            </span>
          )}
        </h2>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {onNext && (
            <button
              type="button"
              onClick={onNext}
              disabled={!canGoNext}
              className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/70 px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-card disabled:cursor-not-allowed disabled:opacity-40"
              title="Play the next episode"
            >
              <SkipForward className="size-3.5" />
              Next
            </button>
          )}

          {seasons.length > 1 && (
            <Select value={String(season)} onValueChange={(v) => onSeason(Number(v))}>
              <SelectTrigger className="h-9 w-[130px] gap-1.5 rounded-lg border-border/60 bg-card/70 text-xs sm:w-[150px]">
                <SelectValue placeholder="Season" />
              </SelectTrigger>
              <SelectContent>
                {seasons.map((s) => (
                  <SelectItem key={s.season} value={String(s.season)} className="text-xs">
                    Season {s.season}
                    <span className="ml-1 text-muted-foreground">({s.episodeCount})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search episodes"
              className="h-9 w-28 rounded-lg border border-border/60 bg-card/70 pl-7 pr-2 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60 sm:w-40"
            />
          </div>

          <button
            type="button"
            onClick={() => setNewest((v) => !v)}
            aria-pressed={newest}
            title={newest ? "Oldest first" : "Newest first"}
            className={cn(
              "flex size-9 items-center justify-center rounded-lg border transition-colors",
              newest
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border/60 bg-card/70 text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            {newest ? (
              <ArrowDownWideNarrow className="size-4" />
            ) : (
              <ArrowUpNarrowWide className="size-4" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setGrid((v) => !v)}
            aria-pressed={grid}
            title={grid ? "List view" : "Grid view"}
            className={cn(
              "flex size-9 items-center justify-center rounded-lg border transition-colors",
              grid
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border/60 bg-card/70 text-muted-foreground hover:bg-card hover:text-foreground",
            )}
          >
            {grid ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[86px] w-full rounded-xl" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-border/50 bg-card/60 px-3 py-4 text-sm text-muted-foreground">
          {query.trim()
            ? `No episode matches “${query.trim()}”.`
            : "No episode list for this season yet."}
        </p>
      ) : grid ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((row) => {
            const active = row.key === activeKey;
            return (
              <div
                key={row.key}
                role="button"
                tabIndex={0}
                onClick={() => onPlay(row)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPlay(row);
                  }
                }}
                className={`group cursor-pointer overflow-hidden rounded-xl border text-left transition-colors ${
                  active
                    ? "border-primary/60 bg-primary/10"
                    : "border-border/50 bg-card/60 hover:border-foreground/25 hover:bg-card"
                }`}
              >
                <div className="relative aspect-video overflow-hidden bg-black/40">
                  <Still src={row.stillUrl} alt={row.title} />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                    <Play className="size-7 fill-white text-white" />
                  </div>
                  <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                    {row.episode}
                  </span>
                </div>
                <div className="p-2">
                  <p className="truncate text-sm font-semibold">{row.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {episodeMeta(row) || `Episode ${row.episode}`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((row) => {
            const active = row.key === activeKey;
            const meta = episodeMeta(row);
            return (
              <li key={row.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onPlay(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onPlay(row);
                    }
                  }}
                  className={`group flex cursor-pointer items-start gap-3 rounded-xl border p-2 text-left transition-colors sm:gap-4 sm:p-2.5 ${
                    active
                      ? "border-primary/60 bg-primary/10"
                      : "border-border/50 bg-card/60 hover:border-foreground/25 hover:bg-card"
                  }`}
                >
                  <span
                    className={`mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold sm:mt-1.5 ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-primary/12 text-primary"
                    }`}
                  >
                    {active ? <Play className="size-3.5 fill-current" /> : row.episode}
                  </span>

                  <span className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-black/40 sm:w-44">
                    <Still src={row.stillUrl} alt={row.title} />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                      <Play className="size-6 fill-white text-white" />
                    </span>
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{row.title}</span>
                      {active && (
                        <span className="hidden shrink-0 text-[11px] font-semibold text-primary sm:inline">
                          Now playing
                        </span>
                      )}
                    </span>
                    {row.overview && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {row.overview}
                      </p>
                    )}
                    {meta && (
                      <p className="mt-1 text-[11px] tabular-nums text-muted-foreground/80">
                        {meta}
                      </p>
                    )}
                  </span>

                  {onDownload && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownload(row);
                      }}
                      aria-label={`Download ${row.title}`}
                      title="Download this episode"
                      className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card/70 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                    >
                      <Download className="size-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
