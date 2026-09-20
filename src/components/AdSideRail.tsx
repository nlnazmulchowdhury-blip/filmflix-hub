import { useEffect, useState } from "react";
import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";

const UNIT_W = AD_BANNERS.skyscraper.width; // 160
const UNIT_H = AD_BANNERS.skyscraper.height; // 600

/**
 * Fixed side rail for the 160×600 skyscraper unit.
 * - Vertically centered in the viewport.
 * - Automatically scales down on short screens so the ad is NEVER cut off
 *   at the top or bottom edge.
 * - Presented as a soft rounded card with a tiny "Ad" chip.
 * - Hidden until the viewport is wide enough that the rail cannot overlap
 *   the page content. "wide" is for max-w-7xl pages (landing), "normal"
 *   for max-w-6xl pages (movie detail).
 */
export default function AdSideRail({
  side,
  breakpoint = "normal",
}: {
  side: "left" | "right";
  breakpoint?: "normal" | "wide";
}) {
  const [scale, setScale] = useState(() =>
    typeof window === "undefined"
      ? 1
      : Math.min(1, (window.innerHeight - 24) / UNIT_H),
  );

  useEffect(() => {
    const update = () =>
      setScale(Math.min(1, (window.innerHeight - 24) / UNIT_H));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const visibility =
    breakpoint === "wide" ? "min-[1680px]:block" : "2xl:block";

  return (
    <div
      className={`fixed top-1/2 z-30 hidden -translate-y-1/2 ${visibility} ${
        side === "left" ? "left-3" : "right-3"
      }`}
    >
      {/* Scale shrinks the whole card (ad + frame) proportionally; the
          transform keeps clicks mapped to the right spot. */}
      <div
        className="relative"
        style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}
      >
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_16px_48px_-20px_rgba(0,0,0,0.45)]">
          <AdBanner {...AD_BANNERS.skyscraper} />
        </div>
        <span className="absolute -top-2 left-2 rounded-full border border-border/60 bg-background px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground shadow-sm">
          Ad
        </span>
      </div>
    </div>
  );
}
