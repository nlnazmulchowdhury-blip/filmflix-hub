import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Play } from "lucide-react";
import { motion } from "framer-motion";

/** One external (not-in-catalog) search hit resolved from IMDb. */
export interface VidSrcHit {
  imdbId: string;
  title: string;
  year?: number;
  kind: "movie" | "series";
  posterUrl?: string;
  cast?: string;
}

/**
 * Poster card for a VidSrc (Server 1) result. Same visual language as
 * MovieCard, but instead of linking to a local movie page it calls `onPlay`,
 * which opens the embed player overlay.
 */
export default function VidSrcResultCard({
  hit,
  index = 0,
  onPlay,
}: {
  hit: VidSrcHit;
  index?: number;
  onPlay: (hit: VidSrcHit) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.04, 0.4), ease: "easeOut" }}
    >
      <button
        type="button"
        onClick={() => onPlay(hit)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPlay(hit);
          }
        }}
        className="group block w-full text-left focus-visible:outline-none"
        aria-label={`Play ${hit.title}`}
      >
        <Card className="card-lift group relative overflow-hidden rounded-xl border-border/60 bg-card p-0 hover:border-primary/40 hover:shadow-[0_16px_48px_-16px_rgba(0,0,0,0.8)] hover:shadow-primary/10">
          <div className="relative aspect-[2/3] overflow-hidden bg-muted">
            {hit.posterUrl ? (
              <img
                src={hit.posterUrl}
                alt={hit.title}
                loading="lazy"
                className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
            ) : (
              <div className="flex size-full items-center justify-center bg-gradient-to-br from-muted to-background">
                <Play className="size-10 text-muted-foreground/40" />
              </div>
            )}

            {/* gradient scrim + hover play */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent opacity-90 transition-opacity group-hover:opacity-100" />
            <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
              <span className="glow-accent flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Play className="ml-0.5 size-6 fill-current" />
              </span>
            </div>

            {/* bottom info overlay */}
            <div className="absolute inset-x-0 bottom-0 p-3">
              <p className="font-display line-clamp-1 text-sm font-semibold text-white">
                {hit.title}
              </p>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-white/70">
                {hit.year != null && <span>{hit.year}</span>}
                {hit.kind === "series" && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px] uppercase tracking-wide">
                    Series
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </Card>
      </button>
    </motion.div>
  );
}
