import { useMutation } from "convex/react";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { api } from "@/convex/_generated/api";

/** GTM's `dataLayer` — declared by the snippet in index.html, but this app must
 *  not care whether it loaded (an ad blocker that eats `gtm.js` must not eat a
 *  render with it). */
function pushDataLayer(event: Record<string, unknown>) {
  const w = window as Window & { dataLayer?: Record<string, unknown>[] };
  (w.dataLayer ??= []).push(event);
}

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

    /* Google Tag Manager ships a `page_view` for the document only. This is a
       single-page app: without this hand the container would see the landing
       page and nothing else, however many films the viewer opened. The path is
       carried so a trigger can still tell a watch page from a browse page. */
    pushDataLayer({
      event: "page_view",
      page_path: location.pathname,
      page_location: window.location.href,
      page_referrer: document.referrer || undefined,
      device,
    });

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
