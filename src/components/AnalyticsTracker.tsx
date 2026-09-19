import { useMutation } from "convex/react";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { api } from "@/convex/_generated/api";

/**
 * Lightweight page-view tracker. Mounted once at the app root; fires one
 * analytics row per route change for every visitor (signed-in or not).
 * Deduplicates remounts within the same location so React StrictMode's
 * double-effect doesn't double-count.
 */
export default function AnalyticsTracker() {
  const location = useLocation();
  const track = useMutation(api.analytics.track);
  const lastTracked = useRef<string | null>(null);

  useEffect(() => {
    if (lastTracked.current === location.pathname) return;
    lastTracked.current = location.pathname;

    const width = window.innerWidth;
    const device = width < 640 ? "mobile" : width < 1024 ? "tablet" : "desktop";

    track({
      path: location.pathname,
      referrer: document.referrer || undefined,
      device,
    }).catch(() => {
      // Analytics must never break the app.
    });
  }, [location.pathname, track]);

  return null;
}
