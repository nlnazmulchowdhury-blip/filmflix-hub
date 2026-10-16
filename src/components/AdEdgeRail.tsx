import { useEffect, useState } from "react";
import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";

/** Max units per rail — keeps the DOM bounded after many Load More clicks. */
const MAX_UNITS = 20;
/** Empty space left between two ads. Larger than a poster row, so only one
 *  ad per side is ever on screen and the movies keep the visual focus. */
const SLOT_GAP = 520;
/** Clearance below the sticky header before the first ad. */
const TOP_OFFSET = 120;
/** Margin that must be free beside the content before a rail is drawn. */
const MIN_GUTTER = 176;

/**
 * Banner rails that live in the page's outer margins — beside the content
 * column, never over it. Ads are spaced a full screen apart and rendered
 * slightly faded until hovered, so they read as background furniture rather
 * than competition for the posters. The stack still spans the whole scroll
 * height, so Load More keeps filling the margins.
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

  const slot = unit.height + SLOT_GAP;
  const count = Math.min(
    MAX_UNITS,
    Math.max(1, Math.ceil((scrollH - TOP_OFFSET) / slot)),
  );

  return (
    <aside
      aria-hidden
      className={`absolute z-30 ${side === "left" ? "left-2" : "right-2"}`}
      style={{ top: TOP_OFFSET, width: unit.width }}
    >
      <div className="flex flex-col items-center" style={{ gap: SLOT_GAP }}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            title="Advertisement"
            className="relative rounded-xl border border-border/40 bg-card/50 opacity-70 shadow-sm transition-[opacity,filter] duration-300 hover:opacity-100 motion-reduce:transition-none"
            style={{ width: unit.width, padding: 4 }}
          >
            <AdBanner {...unit} />
            <span className="absolute -top-2 left-2 rounded-full border border-border/40 bg-background px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Ad
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
