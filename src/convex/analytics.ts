import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const DAY_MS = 24 * 60 * 60 * 1000;

async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (user?.role !== "admin") throw new Error("Admin access required");
  return user;
}

/**
 * Record one page view. Public (any visitor) and intentionally cheap — the
 * client tracker fires it once per route change.
 */
export const track = mutation({
  args: {
    path: v.string(),
    movieId: v.optional(v.id("movies")),
    referrer: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, { path, movieId, referrer, device }) => {
    const userId = await getAuthUserId(ctx);
    await ctx.db.insert("pageViews", {
      path,
      movieId,
      userId: userId ?? undefined,
      referrer: referrer ? referrer.slice(0, 300) : undefined,
      device,
      createdAt: Date.now(),
    });
  },
});

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Full analytics summary for the admin panel. Computed in one query so the
 * dashboard stays consistent. Only admins may read it.
 */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const views = await ctx.db.query("pageViews").withIndex("by_created").collect();
    const now = Date.now();
    const todayStart = startOfToday();
    const last7Start = todayStart - 6 * DAY_MS;
    const last30Start = todayStart - 29 * DAY_MS;

    const total = views.length;
    const today = views.filter((v) => v.createdAt >= todayStart).length;
    const last7 = views.filter((v) => v.createdAt >= last7Start).length;
    const last30 = views.filter((v) => v.createdAt >= last30Start).length;

    /* Unique visitors: anonymous users share no id, so count distinct
       signed-in users + one bucket per unsigned row (best-effort). */
    const signedIn = new Set<string>();
    let anonymous = 0;
    for (const v of views) {
      if (v.userId) signedIn.add(v.userId);
      else anonymous++;
    }
    const visitors7 = new Set<string>();
    let anon7 = 0;
    for (const v of views) {
      if (v.createdAt < last7Start) continue;
      if (v.userId) visitors7.add(v.userId);
      else anon7++;
    }

    /* Per-path totals. */
    const byPath = new Map<string, number>();
    for (const v of views) byPath.set(v.path, (byPath.get(v.path) ?? 0) + 1);

    /* Movie detail views (path starts with /movie/). */
    const byMovie = new Map<Id<"movies">, number>();
    for (const v of views) {
      if (v.movieId) {
        byMovie.set(v.movieId, (byMovie.get(v.movieId) ?? 0) + 1);
      }
    }
    const topMovieIds = [...byMovie.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const topMovies = await Promise.all(
      topMovieIds.map(async ([id, count]) => {
        const m: Doc<"movies"> | null = await ctx.db.get(id);
        return { title: m?.title ?? "Deleted movie", count };
      }),
    );

    /* Devices. */
    const devices: Record<string, number> = {};
    for (const v of views) {
      const d = v.device ?? "unknown";
      devices[d] = (devices[d] ?? 0) + 1;
    }

    /* Referrers (external sites only). */
    const referrers = new Map<string, number>();
    for (const v of views) {
      if (!v.referrer) continue;
      let host: string;
      try {
        host = new URL(v.referrer).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      referrers.set(host, (referrers.get(host) ?? 0) + 1);
    }

    /* Daily series for the last 14 days (for the bar chart). */
    const series: { day: string; views: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const dayStart = todayStart - i * DAY_MS;
      const count = views.filter(
        (v) => v.createdAt >= dayStart && v.createdAt < dayStart + DAY_MS,
      ).length;
      series.push({
        day: new Date(dayStart).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        views: count,
      });
    }

    return {
      total,
      today,
      last7,
      last30,
      visitors7: visitors7.size + anon7,
      topPaths: [...byPath.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([path, count]) => ({ path, count })),
      topMovies,
      devices: Object.entries(devices)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      topReferrers: [...referrers.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([host, count]) => ({ host, count })),
      series,
    };
  },
});
