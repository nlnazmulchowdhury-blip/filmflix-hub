import { useEffect, useState } from "react";
import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";

/** Where the unit sits, i.e. clear of the sticky header. */
const TOP_OFFSET = 120;

/**
 * One 160×600 skyscraper banner in each outer page margin, beside the content
 * column rather than over it — the owner asked for a single ad per side instead
 * of the stack that used to grow down the page with Load More.
 *
 * It scrolls with the document and is never pinned to the viewport, and it keeps
 * its natural size so nothing renders half-cut. Faded until hovered, so the
 * posters keep the viewer's attention.
 */
export default function AdEdgeRail({ side }: { side: "left" | "right" }) {
  const [gutter, setGutter] = useState(0);

  useEffect(() => {
    const update = () => {
      const main = document.querySelector("main");
      if (main) {
        const r = main.getBoundingClientRect();
        setGutter(Math.max(0, Math.min(r.left, window.innerWidth - r.right)));
      }
    };
    update();
    window.addEventListener("resize", update);
    // Rows below the first reflow the content column, which moves the gutter.
    const obs = new ResizeObserver(update);
    obs.observe(document.body);
    return () => {
      window.removeEventListener("resize", update);
      obs.disconnect();
    };
  }, []);

  const unit = AD_BANNERS.skyscraper;
  if (gutter < unit.width + 16) return null;

  return (
    <aside
      aria-hidden
      className={`absolute z-30 ${side === "left" ? "left-2" : "right-2"}`}
      style={{ top: TOP_OFFSET, width: unit.width }}
    >
      <div
        title="Advertisement"
        className="relative overflow-hidden rounded-2xl border border-border/40 bg-card/50 opacity-70 shadow-sm transition-opacity duration-300 hover:opacity-100 motion-reduce:transition-none"
      >
        <AdBanner {...unit} />
        <span className="absolute left-2 top-2 rounded-full border border-border/40 bg-background/90 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Ad
        </span>
      </div>
    </aside>
  );
}
