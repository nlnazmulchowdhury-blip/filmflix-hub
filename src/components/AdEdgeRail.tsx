import { useEffect, useState } from "react";
import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";

/** Where the first unit starts, i.e. clear of the sticky header. */
const TOP_OFFSET = 120;
/** Dead space kept below the final unit so it never touches the footer. */
const BOTTOM_RESERVE = 40;
/** Air between two units — long enough that ads read as margins, not a wall. */
const SLOT_GAP = 200;
const MAX_UNITS = 20;

/**
 * Tall 160×600 skyscraper banners parked in the page's outer margins, beside
 * the content column rather than over it.
 *
 * The stack scrolls with the document instead of being pinned to the viewport:
 * one unit per slot, separated by a wide gap, and the number of units grows
 * with the page height — so pressing Load More adds more ads down both sides.
 * Each creative keeps its natural size, so nothing ever renders half-cut.
 * Units stay faded until hovered, so the posters keep the viewer's attention.
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
    // Load More grows the page, which both reflows the gutter and adds units.
    const obs = new ResizeObserver(update);
    obs.observe(document.body);
    return () => {
      window.removeEventListener("resize", update);
      obs.disconnect();
    };
  }, []);

  const unit = AD_BANNERS.skyscraper;
  if (gutter < unit.width + 16) return null;

  const slot = unit.height + SLOT_GAP;
  const count = Math.max(
    1,
    Math.min(
      MAX_UNITS,
      Math.floor((scrollH - TOP_OFFSET - BOTTOM_RESERVE) / slot),
    ),
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
            className="relative overflow-hidden rounded-2xl border border-border/40 bg-card/50 opacity-70 shadow-sm transition-opacity duration-300 hover:opacity-100 motion-reduce:transition-none"
          >
            <AdBanner {...unit} />
            <span className="absolute left-2 top-2 rounded-full border border-border/40 bg-background/90 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Ad
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
