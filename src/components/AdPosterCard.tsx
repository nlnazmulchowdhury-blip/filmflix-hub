import { Card } from "@/components/ui/card";
import AdBanner from "@/components/AdBanner";
import { AD_BANNERS } from "@/lib/ad-banners";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/** Half-page unit: 160×300 is the closest banner to a 2:3 poster slot. */
const UNIT = AD_BANNERS.halfpage;

/**
 * Poster-shaped ad slot for the movie grid. The banner is rendered at its
 * native size and scaled down to fit the cell, so the creative is never
 * cropped — only letterboxed by the card background.
 */
export default function AdPosterCard({ index = 0 }: { index?: number }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({
    w: UNIT.width,
    h: UNIT.height,
  });

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    /* Column width changes with the breakpoint and when the side rails appear. */
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const scale = Math.min(box.w / UNIT.width, box.h / UNIT.height) || 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.35,
        delay: Math.min(index * 0.04, 0.4),
        ease: "easeOut",
      }}
    >
      <Card className="card-lift group relative overflow-hidden rounded-xl border-border/60 bg-card p-0">
        <div
          ref={frameRef}
          className="relative aspect-[2/3] overflow-hidden bg-muted"
        >
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: UNIT.width,
              height: UNIT.height,
              transform: `translate(-50%, -50%) scale(${scale})`,
            }}
          >
            <AdBanner {...UNIT} />
          </div>
          <span className="absolute left-2 top-2 z-10 rounded-full border border-white/20 bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white/90 backdrop-blur-sm">
            Ad
          </span>
        </div>
      </Card>
    </motion.div>
  );
}
