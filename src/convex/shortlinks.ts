import { action, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Hosts of known URL shorteners. Links on these hosts cannot stream video
 * (the player can't send range requests through the redirect chain), so they
 * are resolved back to their real destination URL before use.
 */
const SHORT_HOSTS = [
  "tinyurl.com",
  "is.gd",
  "bit.ly",
  "bit.do",
  "cutt.ly",
  "rb.gy",
  "t.co",
  "goo.gl",
  "shorturl.at",
  "rebrand.ly",
  "tiny.cc",
  "ow.ly",
  "buff.ly",
  "s.id",
  "urlz.fr",
  "v.gd",
];

export function isShortLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return SHORT_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

/**
 * Follows redirects until the final URL is reached, so a shortener link
 * (tinyurl/is.gd/...) becomes the real streaming URL again. Resolving
 * server-side keeps the browser out of CORS/redirect trouble.
 */
async function resolveRedirect(url: string): Promise<string> {
  try {
    // A HEAD is cheap; if the server refuses it, fall back to a ranged GET
    // that pulls almost nothing but still follows redirects.
    let res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!res.ok || !res.redirected) {
      res = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1" },
        redirect: "follow",
      });
      try {
        await res.body?.cancel();
      } catch {
        // ignore body cleanup errors
      }
    }
    return res.url || url;
  } catch {
    // Network/hostname error — give back the original so nothing breaks.
    return url;
  }
}

export const expandBatch = action({
  args: { urls: v.array(v.string()) },
  handler: async (_ctx, { urls }) => {
    const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    const entries = await Promise.all(
      unique.map(async (url) => {
        if (!isShortLink(url)) return [url, url] as const;
        const expanded = await resolveRedirect(url);
        return [url, expanded] as const;
      }),
    );
    const map: Record<string, string> = {};
    for (const [from, to] of entries) map[from] = to;
    return map;
  },
});

/* ------------------------------------------------------------------ */
/* Migration: expand every short URL already stored on movies          */
/* ------------------------------------------------------------------ */

interface EpisodePatch {
  title: string;
  videoUrl: string;
  durationSec?: number;
}

interface MoviePatch {
  id: Id<"movies">;
  posterUrl?: string;
  backdropUrl?: string;
  videoUrl?: string;
  episodes?: EpisodePatch[];
}

export const shortLinkTargets = internalQuery({
  args: {},
  handler: async (ctx): Promise<MoviePatch[]> => {
    const rows: Doc<"movies">[] = await ctx.db
      .query("movies")
      .withIndex("order")
      .collect();
    const out: MoviePatch[] = [];
    for (const m of rows) {
      const urls: string[] = [m.posterUrl, m.backdropUrl, m.videoUrl].filter(
        (u): u is string => Boolean(u),
      );
      const eps: EpisodePatch[] = m.episodes ?? [];
      for (const e of eps) urls.push(e.videoUrl);
      if (urls.some((u) => isShortLink(u))) {
        out.push({
          id: m._id,
          posterUrl: m.posterUrl,
          backdropUrl: m.backdropUrl,
          videoUrl: m.videoUrl,
          episodes: eps,
        });
      }
    }
    return out;
  },
});

export const applyExpanded = internalMutation({
  args: {
    updates: v.array(
      v.object({
        id: v.id("movies"),
        posterUrl: v.optional(v.string()),
        backdropUrl: v.optional(v.string()),
        videoUrl: v.optional(v.string()),
        episodes: v.optional(
          v.array(
            v.object({
              title: v.string(),
              videoUrl: v.string(),
              durationSec: v.optional(v.number()),
            }),
          ),
        ),
      }),
    ),
  },
  handler: async (ctx, { updates }): Promise<number> => {
    for (const { id, ...patch } of updates) {
      await ctx.db.patch(id, patch);
    }
    return updates.length;
  },
});

/**
 * One-shot admin action: rewrites every stored tinyurl/is.gd/... link back
 * to its real destination URL across the whole catalog. Safe to run more
 * than once — movies without short links are skipped.
 */
export const migrateAllShortLinks = action({
  args: {},
  handler: async (ctx) => {
    // Only admins may rewrite catalog URLs.
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const user: Doc<"users"> | null = await ctx.runQuery(
      api.users.currentUser,
      {},
    );
    if (user?.role !== "admin") throw new Error("Admin access required");

    const targets: MoviePatch[] = await ctx.runQuery(
      internal.shortlinks.shortLinkTargets,
      {},
    );
    if (targets.length === 0) return { movies: 0, links: 0 };

    let links = 0;
    const updates: MoviePatch[] = [];

    for (const m of targets) {
      const shorts: string[] = [
        m.posterUrl,
        m.backdropUrl,
        m.videoUrl,
        ...(m.episodes ?? []).map((e: EpisodePatch) => e.videoUrl),
      ].filter((u): u is string => u !== undefined && isShortLink(u));
      const map: Record<string, string> = await ctx.runAction(
        api.shortlinks.expandBatch,
        { urls: shorts },
      );
      const swap = (u?: string): string | undefined =>
        u ? (map[u] ?? u) : u;

      let changed = 0;
      const posterUrl = swap(m.posterUrl);
      const backdropUrl = swap(m.backdropUrl);
      const videoUrl = swap(m.videoUrl);
      const episodes: EpisodePatch[] | undefined = m.episodes?.map(
        (e: EpisodePatch) => {
          const resolved = swap(e.videoUrl) ?? e.videoUrl;
          if (resolved !== e.videoUrl) changed++;
          return { ...e, videoUrl: resolved };
        },
      );
      if (posterUrl !== m.posterUrl) changed++;
      if (backdropUrl !== m.backdropUrl) changed++;
      if (videoUrl !== m.videoUrl) changed++;
      if (changed === 0) continue;
      links += changed;
      updates.push({
        id: m.id,
        posterUrl,
        backdropUrl,
        videoUrl,
        episodes,
      });
    }
    await ctx.runMutation(internal.shortlinks.applyExpanded, { updates });
    return { movies: updates.length, links };
  },
});
