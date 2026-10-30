/**
 * Referral client.
 *
 * Every call here is pinned to the primary Worker on purpose: the settlement
 * cron only runs there, so the balance a referrer is paid into and the balance
 * they read back must live in the same D1 database. The failover rotation used
 * for catalog reads would otherwise show a backup account's empty wallet.
 */

import { API_BACKENDS } from "./apiConfig";
import { getToken, ApiError } from "./api";

const REF_COOKIE = "ref_by";
const REF_TTL_DAYS = 30;

export interface ReferralDay {
  date: string;
  visits: number;
  earned: number;
  settled: boolean;
}

export interface ReferralSummary {
  enabled: boolean;
  code: string | null;
  sharePct: number;
  todayVisits: number;
  todayPending: number;
  balance: number;
  pendingBalance: number;
  totalEarned: number;
  lifetimeVisits: number;
  lastSettled: { date: string; earnings: number; visits: number; perVisit: number } | null;
  days: ReferralDay[];
}

export function isReferralCode(value: string): boolean {
  return /^[A-Z0-9]{4,16}$/.test(value);
}

/** The `ref_by` cookie the link sets — 30 days, site-wide. */
export function readRefCode(): string | null {
  try {
    const match = new RegExp(`(?:^|;\\s*)${REF_COOKIE}=([^;]+)`).exec(document.cookie);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function saveRefCode(code: string) {
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  if (!isReferralCode(normalized)) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${REF_COOKIE}=${encodeURIComponent(normalized)}; Max-Age=${REF_TTL_DAYS * 86_400}` +
    `; Path=/; SameSite=Lax${secure}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BACKENDS[0].url}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  /* A Worker that predates this feature answers with a plain-text "404 Not
     Found"; an edge error page is HTML. Neither parses, and neither should
     surface as a JSON syntax error in the panel. */
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiError(502, "Referral service returned an unreadable response.");
    }
  }
  if (!res.ok) {
    if (res.status === 404) throw new ApiError(404, "Referral service is not deployed yet.");
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const referralApi = {
  summary: () => request<ReferralSummary>("GET", "/referrals/me"),
  /** Fire-and-forget: a counted visit returns `counted: true`, everything else
   *  (own click, same IP inside 24 h, dead code) explains why it was ignored. */
  visit: (code: string, movieId?: string) =>
    request<{ counted: boolean; reason?: string }>("POST", "/referrals/visit", {
      code,
      movieId,
    }),
};

export function referralLink(code: string): string {
  return `${window.location.origin}/?ref=${code}`;
}
