import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser } from "./users";

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

const movieFields = {
  title: v.string(),
  description: v.optional(v.string()),
  posterUrl: v.optional(v.string()),
  backdropUrl: v.optional(v.string()),
  videoUrl: v.optional(v.string()),
  genre: v.optional(v.string()),
  year: v.optional(v.number()),
  rating: v.optional(v.number()),
  kind: v.optional(v.union(v.literal("movie"), v.literal("series"))),
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
    return await ctx.db.insert("movies", { ...args, order });
  },
});

export const update = mutation({
  args: { id: v.id("movies"), ...movieFields },
  handler: async (ctx, { id, ...patch }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(id, patch);
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

/** Any signed-in team member can contribute a title to the catalog. */
export const contribute = mutation({
  args: movieFields,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const order =
      args.order ??
      (await ctx.db.query("movies").withIndex("order").collect()).length;
    return await ctx.db.insert("movies", {
      ...args,
      order,
      contributorId: userId,
    });
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

export const claimAdmin = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    if (user.role === "admin") return "already-admin";
    await ctx.db.patch(user._id, { role: "admin" });
    return "claimed";
  },
});
