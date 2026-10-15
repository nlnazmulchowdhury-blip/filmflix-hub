/**
 * Client for the installable-app catalogue (`/app/builds`).
 *
 * FilmFlix ships as a web app first: a platform row exists here only when a
 * real binary is published for it, which is what lets the "Get the app" cards
 * promise a download instead of lying about one.
 */
import { api } from "@/lib/api";

export type AppPlatform = "android" | "ios" | "windows" | "macos" | "tv";

export interface AppBuild {
  platform: AppPlatform;
  url: string;
  version: string;
  sizeBytes: number | null;
  notes: string;
  updatedAt: number;
}

/** Display order + wording for every card the section can render. */
export const PLATFORMS: {
  key: AppPlatform;
  label: string;
  file: string;
  howTo: string;
}[] = [
  {
    key: "android",
    label: "Android",
    file: "APK",
    howTo: "Android 8+ · installs from the browser",
  },
  {
    key: "ios",
    label: "iPhone & iPad",
    file: "PWA",
    howTo: "Safari → Share → Add to Home Screen",
  },
  { key: "windows", label: "Windows", file: "EXE", howTo: "Windows 10 or 11, 64-bit" },
  { key: "macos", label: "macOS", file: "DMG", howTo: "Apple silicon and Intel" },
  { key: "tv", label: "Android TV", file: "APK", howTo: "Shield, Xiaomi Box, Sony/TP Vision TVs" },
];

export async function listAppBuilds(): Promise<AppBuild[]> {
  const r = await api.get<{ builds?: AppBuild[] }>(`/app/builds`);
  return r.builds ?? [];
}

export function saveAppBuild(
  platform: AppPlatform,
  body: { url: string; version?: string; sizeBytes?: number | null; notes?: string },
) {
  return api.put<AppBuild>(`/app/builds/${platform}`, body);
}

export function removeAppBuild(platform: AppPlatform) {
  return api.del<{ ok: boolean }>(`/app/builds/${platform}`);
}

/** Which card to highlight for whoever is reading the page. */
export function detectPlatform(): AppPlatform | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  const plat = ((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "").toLowerCase();
  if (/android/i.test(ua)) return /\btv\b|googletv|smarttv|umi|box|stick/i.test(ua) ? "tv" : "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (plat.includes("mac")) return "macos";
  if (plat.includes("win")) return "windows";
  if (plat.includes("linux")) return "windows";
  return null;
}

export function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
