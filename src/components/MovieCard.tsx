import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { Doc } from "@/convex/_generated/dataModel";
import { Play, Star } from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "react-router";

type Movie = Doc<"movies">;

export default function MovieCard({ movie, index = 0 }: { movie: Movie; index?: number }) {
  const rating = movie.rating != null ? movie.rating.toFixed(1) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.04, 0.4), ease: "easeOut" }}
    >
      <Link to={`/movie/${movie._id}`} className="group block focus-visible:outline-none">
        <Card className="card-lift group relative overflow-hidden rounded-xl border-border/60 bg-card p-0 hover:border-primary/40 hover:shadow-[0_16px_48px_-16px_rgba(0,0,0,0.8)] hover:shadow-primary/10">
          <div className="relative aspect-[2/3] overflow-hidden bg-muted">
            {movie.posterUrl ? (
              <img
                src={movie.posterUrl}
                alt={movie.title}
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
                {movie.title}
              </p>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-white/70">
                {movie.year != null && <span>{movie.year}</span>}
                {movie.kind === "series" && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px] uppercase tracking-wide">
                    Series
                  </Badge>
                )}
                {rating && (
                  <span className="ml-auto inline-flex items-center gap-0.5 font-medium text-amber-300">
                    <Star className="size-3 fill-current" />
                    {rating}
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
      </Link>
    </motion.div>
  );
}
