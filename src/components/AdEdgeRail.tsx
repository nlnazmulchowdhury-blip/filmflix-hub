import { useEffect, useState } from "react";
import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";

/** Breathing room kept above/below the ad on short screens. */
const VERTICAL_PADDING = 40;

/**
 * Tall 160×600 skyscraper banners parked in the page's outer margins, beside
 * the content column rather than over it.
 *
 * The rail is pinned to the vertical centre of the viewport instead of
 * scrolling with the document: an ad that travels with the page keeps
 * straddling the bottom edge, which reads as a half-cut poster. Centred, the
 * whole creative is always on screen, and it scales down on short viewports
 * so the tall art still fits end to end. It also stays faded until hovered,
 * so the movie posters keep the viewer's attention.
 */
export default function AdEdgeRail({ side }: { side: "left" | "right" }) {
  const [gutter, setGutter] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const update = () => {
      const main = document.querySelector("main");
      if (main) {
        const r = main.getBoundingClientRect();
        setGutter(Math.max(0, Math.min(r.left, window.innerWidth - r.right)));
      }
      setViewportH(window.innerHeight);
    };
    update();
    window.addEventListener("resize", update);
    // Load More reflows the page, which shifts the gutter the rails sit in.
    const obs = new ResizeObserver(update);
    obs.observe(document.body);
    return () => {
      window.removeEventListener("resize", update);
      obs.disconnect();
    };
  }, []);

  const unit = AD_BANNERS.skyscraper;
  if (gutter < unit.width + 16) return null;

  // Shrink the whole card when the viewport is shorter than the unit.
  const scale = Math.min(
    1,
    (viewportH - VERTICAL_PADDING) / (unit.height + 10),
  );

  return (
    <aside
      aria-hidden
      className={`fixed top-1/2 z-30 -translate-y-1/2 ${
        side === "left" ? "left-2" : "right-2"
      }`}
      style={{ width: unit.width }}
    >
      <div style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
        <div
          title="Advertisement"
          className="relative overflow-hidden rounded-2xl border border-border/40 bg-card/50 opacity-70 shadow-sm transition-opacity duration-300 hover:opacity-100 motion-reduce:transition-none"
        >
          <AdBanner {...unit} />
          <span className="absolute left-2 top-2 rounded-full border border-border/40 bg-background/90 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Ad
          </span>
        </div>
      </div>
    </aside>
  );
}
