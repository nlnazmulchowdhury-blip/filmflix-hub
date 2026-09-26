import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUser } from "./users";
import { movieCategoryNames } from "../lib/categories";

/** Every media URL referenced by a movie row (main + arrays). Mirrors the
 *  collector in storageCleanup.ts so purge-before-delete stays exact. */
function movieMediaUrls(m: {
  videoUrl?: string;
  posterUrl?: string;
  backdropUrl?: string;
  episodes?: { videoUrl: string }[];
  dubs?: { videoUrl: string }[];
  qualities?: { videoUrl: string }[];
  subtitles?: { url: string }[];
  seasons?: { episodes?: { videoUrl: string }[] }[];
}): string[] {
  const urls: string[] = [];
  if (m.videoUrl) urls.push(m.videoUrl);
  if (m.posterUrl) urls.push(m.posterUrl);
  if (m.backdropUrl) urls.push(m.backdropUrl);
  for (const e of m.episodes ?? []) if (e.videoUrl) urls.push(e.videoUrl);
  for (const d of m.dubs ?? []) if (d.videoUrl) urls.push(d.videoUrl);
  for (const q of m.qualities ?? []) if (q.videoUrl) urls.push(q.videoUrl);
  for (const s of m.subtitles ?? []) if (s.url) urls.push(s.url);
  for (const s of m.seasons ?? [])
    for (const e of s.episodes ?? []) if (e.videoUrl) urls.push(e.videoUrl);
  return urls;
}

const episodeObj = v.object({
  id: v.string(),
  title: v.string(),
  videoUrl: v.string(),
  durationSec: v.optional(v.number()),
});
const seasonObj = v.object({
  id: v.id("movies"),
  title: v.string(),
  episodes: v.array(episodeObj),
});

const episodeInput = v.object({
  title: v.string(),
  videoUrl: v.string(),
  durationSec: v.optional(v.number()),
});
const dubInput = v.object({
  label: v.string(),
  videoUrl: v.string(),
});
const qualityInput = v.object({
  label: v.string(),
  videoUrl: v.string(),
});
const subtitleInput = v.object({
  label: v.string(),
  url: v.string(),
});

const movieFields = {
  title: v.string(),
  description: v.optional(v.string()),
  posterUrl: v.optional(v.string()),
  backdropUrl: v.optional(v.string()),
  videoUrl: v.optional(v.string()),
  genre: v.optional(v.string()),
  category: v.optional(v.string()),
  /** One movie can belong to multiple categories. */
  categories: v.optional(v.array(v.string())),
  year: v.optional(v.number()),
  rating: v.optional(v.number()),
  kind: v.optional(v.union(v.literal("movie"), v.literal("series"))),
  episodes: v.optional(v.array(episodeInput)),
  dubs: v.optional(v.array(dubInput)),
  qualities: v.optional(v.array(qualityInput)),
  subtitles: v.optional(v.array(subtitleInput)),
  seasons: v.optional(v.array(seasonObj)),
  order: v.optional(v.number()),
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("movies").withIndex("order").collect();
    // Newest uploads first: `add` assigns a growing `order`, so sorting
    // descending puts the latest upload at the very top of the catalog.
    return rows.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  },
});

export const get = query({
  args: { id: v.id("movies") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (user?.role !== "admin") throw new Error("Admin access required");
  return user;
}

export const add = mutation({
  args: movieFields,
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const order =
      args.order ??
      (await ctx.db.query("movies").withIndex("order").collect()).length;
    // Single source of truth is the categories array; mirror the first name
    // into the legacy field so older reads keep working.
    const { category, categories, ...rest } = args;
    const names = [
      ...new Set(
        [...(categories ?? []), category ?? ""]
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    ];
    return await ctx.db.insert("movies", {
      ...rest,
      categories: names.length > 0 ? names : undefined,
      category: names[0],
      order,
    });
  },
});

export const update = mutation({
  args: { id: v.id("movies"), ...movieFields },
  handler: async (ctx, { id, ...args }) => {
    await requireAdmin(ctx);
    const before = await ctx.db.get(id);
    if (!before) throw new Error("Movie not found");
    const { category, categories, ...rest } = args;
    const names = [
      ...new Set(
        [...(categories ?? []), category ?? ""]
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    ];
    await ctx.db.patch(id, {
      ...rest,
      categories: names.length > 0 ? names : undefined,
      category: names[0],
    });
    /* Files the edit dropped (replaced poster/video, removed dub…) are
       orphaned in cloud storage — purge them unless another movie still
       uses the same URL. */
    const dropped = movieMediaUrls(before).filter(
      (u) => !movieMediaUrls({ ...before, ...rest }).includes(u),
    );
    if (dropped.length > 0) {
      await ctx.runMutation(internal.storageCleanup.purgeUrlsIfUnreferenced, {
        urls: dropped,
      });
    }
    return id;
  },
});

export const remove = mutation({
  args: { id: v.id("movies") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const movie = await ctx.db.get(id);
    await ctx.db.delete(id);
    /* Delete the movie's uploaded files from cloud storage too, unless
       another movie still references the same URL. */
    if (movie) {
      await ctx.runMutation(internal.storageCleanup.purgeUrlsIfUnreferenced, {
        urls: movieMediaUrls(movie),
      });
    }
  },
});

/** Admin: pin a movie to the very front of the catalog (shows first). */
export const moveToTop = mutation({
  args: { id: v.id("movies") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("movies").withIndex("order").collect();
    const max = rows.reduce((acc, r) => Math.max(acc, r.order ?? 0), 0);
    await ctx.db.patch(id, { order: max + 1 });
  },
});

/** Admin: nudge a movie one slot up/down in the displayed order. */
export const moveInOrder = mutation({
  args: { id: v.id("movies"), dir: v.union(v.literal("up"), v.literal("down")) },
  handler: async (ctx, { id, dir }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("movies").withIndex("order").collect();
    rows.sort((a, b) => (b.order ?? 0) - (a.order ?? 0)); // display order
    const idx = rows.findIndex((r) => r._id === id);
    if (idx === -1) throw new Error("Movie not found");
    const neighborIdx = dir === "up" ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= rows.length) return; // at the edge
    const me = rows[idx];
    const other = rows[neighborIdx];
    const myOrder = me.order ?? 0;
    const otherOrder = other.order ?? 0;
    if (myOrder === otherOrder) {
      // Rare legacy tie — nudge the neighbor so the display order is strict.
      await ctx.db.patch(other._id, {
        order: dir === "up" ? otherOrder + 1 : otherOrder - 1,
      });
    } else {
      await ctx.db.patch(me._id, { order: otherOrder });
      await ctx.db.patch(other._id, { order: myOrder });
    }
  },
});

/**
 * Delete a category: strips that name from every movie's category list.
 * The movies themselves stay in the catalog — they just lose this one
 * section. Admin-only.
 */
export const removeCategory = mutation({
  args: { category: v.string() },
  handler: async (ctx, { category }) => {
    await requireAdmin(ctx);
    const trimmed = category.trim();
    if (!trimmed) throw new Error("Category name is required");
    const rows = await ctx.db.query("movies").withIndex("order").collect();
    let changed = 0;
    for (const m of rows) {
      const names = movieCategoryNames(m);
      if (!names.includes(trimmed)) continue;
      const rest = names.filter((n) => n !== trimmed);
      await ctx.db.patch(m._id, {
        categories: rest.length > 0 ? rest : undefined,
        category: rest[0],
      });
      changed++;
    }
    return changed;
  },
});

export const listByContributor = query({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) =>
    ctx.db
      .query("movies")
      .withIndex("by_contributor", (q) => q.eq("contributorId", userId))
      .collect(),
});

/**
 * Verify the shared admin access code. The code lives only on the server
 * (ADMIN_ACCESS_CODE env var, set from the project's Keys/API keys page).
 * On success the signed-in user is promoted to the admin role.
 */
export const verifyAdminCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Sign in first, then enter the admin code");
    if (user.role === "admin") return "already-admin";

    const expected = process.env.ADMIN_ACCESS_CODE;
    if (!expected) {
      throw new Error(
        "ADMIN_ACCESS_CODE is not configured. Set it in the project's API keys page.",
      );
    }
    if (code.trim() !== expected) {
      throw new Error("Incorrect admin access code");
    }
    await ctx.db.patch(user._id, { role: "admin" });
    return "claimed";
  },
});
