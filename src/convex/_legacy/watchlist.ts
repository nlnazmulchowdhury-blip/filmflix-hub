import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, MutationCtx } from "./_generated/server";

/**
 * The per-user watchlist: movies a viewer saved to watch later.
 * All functions require a signed-in user.
 */

async function currentUserId(ctx: MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Sign in to use the watchlist");
  return userId;
}

/** Movie ids on this user's watchlist, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("watchlist")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const out = [];
    for (const row of rows) {
      const movie = await ctx.db.get(row.movieId);
      if (movie) out.push(movie);
    }
    return out;
  },
});

/** Whether the signed-in user has the movie saved. */
export const hasMovie = query({
  args: { movieId: v.id("movies") },
  handler: async (ctx, { movieId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;
    const row = await ctx.db
      .query("watchlist")
      .withIndex("by_user_movie", (q) =>
        q.eq("userId", userId).eq("movieId", movieId),
      )
      .first();
    return row !== null;
  },
});

/** Add a movie to the watchlist (idempotent). */
export const add = mutation({
  args: { movieId: v.id("movies") },
  handler: async (ctx, { movieId }) => {
    const userId = await currentUserId(ctx);
    const existing = await ctx.db
      .query("watchlist")
      .withIndex("by_user_movie", (q) =>
        q.eq("userId", userId).eq("movieId", movieId),
      )
      .first();
    if (existing) return existing._id;
    await ctx.db.get(movieId); // validates the id
    return await ctx.db.insert("watchlist", {
      userId,
      movieId,
      createdAt: Date.now(),
    });
  },
});

/** Remove a movie from the watchlist (no-op if absent). */
export const remove = mutation({
  args: { movieId: v.id("movies") },
  handler: async (ctx, { movieId }) => {
    const userId = await currentUserId(ctx);
    const row = await ctx.db
      .query("watchlist")
      .withIndex("by_user_movie", (q) =>
        q.eq("userId", userId).eq("movieId", movieId),
      )
      .first();
    if (row) await ctx.db.delete(row._id);
  },
});
