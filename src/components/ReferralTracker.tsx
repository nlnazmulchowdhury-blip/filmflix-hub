import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { isReferralCode, readRefCode, referralApi, saveRefCode } from "@/lib/referrals";

/**
 * Referral click tracker. Mounted once at the app root.
 *
 * `?ref=CODE` writes the 30-day `ref_by` cookie; the cookie (or the code that
 * just set it) then reports a visit for the current movie. The Worker decides
 * whether it counts — own click, same IP within 24 h and dead codes are all
 * dropped server-side, so this can fire on every page load without inflating
 * anything, and the movie id is what makes a visit attributable.
 */
export default function ReferralTracker() {
  const location = useLocation();
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    const fromUrl = (new URLSearchParams(location.search).get("ref") ?? "").trim().toUpperCase();
    if (isReferralCode(fromUrl)) saveRefCode(fromUrl);

    const code = isReferralCode(fromUrl) ? fromUrl : readRefCode();
    if (!code || !isReferralCode(code)) return;

    const movieId = location.pathname.startsWith("/movie/")
      ? location.pathname.slice("/movie/".length)
      : undefined;
    const key = `${code}:${movieId ?? ""}`;
    /* React StrictMode runs effects twice and a route change re-runs this —
       one report per code+movie per page load is enough; the server dedupes
       the rest anyway. */
    if (lastSent.current === key) return;
    lastSent.current = key;

    referralApi.visit(code, movieId).catch(() => {
      /* A referral must never break browsing. */
    });
  }, [location.pathname, location.search]);

  return null;
}
