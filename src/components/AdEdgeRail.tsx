import { useEffect, useState } from "react";
import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";

/** Tallest stack per rail — keeps the DOM bounded after many Load More clicks. */
const MAX_UNITS = 30;
const GAP = 16;
/** Margin that must be free beside the content before a rail is drawn. */
const MIN_GUTTER = 176;

/**
 * Banner rails that live in the page's outer margins — beside the content
 * column, never over it. The stack is as tall as the scrollable page, so
 * scrolling down (or pressing Load More, which grows the page) keeps bringing
 * fresh ads into view. The unit is picked from the gutter actually available,
 * and nothing renders on screens too narrow to spare one.
 */
export default function AdEdgeRail({ side }: { side: "left" | "right" }) {
  const [gutter, setGutter] = useState(0);
  const [scrollH, setScrollH] = useState(0);

  useEffect(() => {
    const update = () => {
      const main = document.querySelector("main");
      if (main) {
        const r = main.getBoundingClientRect();
        setGutter(Math.max(0, Math.min(r.left, window.innerWidth - r.right)));
      }
      setScrollH(document.documentElement.scrollHeight);
    };
    update();
    window.addEventListener("resize", update);
    // Load More and lazy images change the page height; re-measure after paint.
    const obs = new ResizeObserver(update);
    obs.observe(document.body);
    return () => {
      window.removeEventListener("resize", update);
      obs.disconnect();
    };
  }, []);

  const unit =
    gutter >= AD_BANNERS.square.width + 16
      ? AD_BANNERS.square
      : gutter >= MIN_GUTTER
        ? AD_BANNERS.halfpage
        : null;
  if (!unit) return null;

  const count = Math.min(
    MAX_UNITS,
    Math.max(1, Math.ceil(scrollH / (unit.height + GAP)) + 1),
  );

  return (
    <aside
      aria-hidden
      className={`absolute top-0 z-30 ${side === "left" ? "left-2" : "right-2"}`}
      style={{ width: unit.width }}
    >
      <div className="flex flex-col items-center" style={{ gap: GAP }}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="relative overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_16px_48px_-20px_rgba(0,0,0,0.45)]"
          >
            <AdBanner {...unit} />
            <span className="absolute -top-2 left-2 rounded-full border border-border/60 bg-background px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shadow-sm">
              Ad
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
