import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";

/**
 * A vertical stack of side banner ads that flanks the movie grid. The number
 * of units grows with the catalog (`count`), so pressing "Load More" fills the
 * side gutter with more ads instead of leaving it empty. It scrolls with the
 * page (not sticky) so the extra units come into view as the list grows. The
 * caller hides it on narrow screens where there's no room beside the grid.
 */
export default function AdRail({
  count,
  className = "",
}: {
  count: number;
  className?: string;
}) {
  const units = Math.max(0, count);
  return (
    <aside
      aria-hidden
      className={`flex w-40 shrink-0 flex-col items-center gap-4 self-start ${className}`}
    >
      {Array.from({ length: units }).map((_, i) => (
        <AdBanner key={i} {...AD_BANNERS.halfpage} />
      ))}
    </aside>
  );
}
