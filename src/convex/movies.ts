import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser } from "./users";
import { movieCategoryNames } from "../lib/categories";

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
  seasons: v.optional(v.array(seasonObj)),
  order: v.optional(v.number()),
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("movies").withIndex("order").collect();
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
    return id;
  },
});

export const remove = mutation({
  args: { id: v.id("movies") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(id);
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
