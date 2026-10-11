import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const schedule = mutation({
  args: {
    movieId: v.id("movies"),
    scheduledFor: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { movieId, scheduledFor, note }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    if (movieId === undefined || movieId === null) {
      throw new Error("Pick a movie first");
    }
    if (!(await ctx.db.get(movieId))) throw new Error("Movie not found");
    const createdAt = Date.now();
    const id = await ctx.db.insert("screenings", {
      movieId,
      userId,
      scheduledFor,
      note: note || undefined,
      createdAt,
    });
    return id;
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("screenings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return await Promise.all(
      rows.map(async (s) => {
        const movie = await ctx.db.get(s.movieId);
        return {
          _id: s._id,
          scheduledFor: s.scheduledFor,
          note: s.note ?? null,
          createdAt: s.createdAt,
          movieId: s.movieId,
          movieTitle: movie?.title ?? "Removed movie",
          moviePoster: movie?.posterUrl ?? null,
        };
      }),
    );
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    if (user?.role !== "admin") throw new Error("Admin access required");
    const rows = await ctx.db.query("screenings").collect();
    return await Promise.all(
      rows.map(async (s) => {
        const movie = await ctx.db.get(s.movieId);
        const owner = await ctx.db.get(s.userId);
        return {
          _id: s._id,
          scheduledFor: s.scheduledFor,
          note: s.note ?? null,
          movieTitle: movie?.title ?? "Removed movie",
          ownerName: owner?.name ?? owner?.email ?? "Member",
        };
      }),
    );
  },
});

export const cancel = mutation({
  args: { id: v.id("screenings") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const screening = await ctx.db.get(id);
    if (!screening) throw new Error("Screening not found");
    if (screening.userId !== userId) throw new Error("Not your screening");
    await ctx.db.delete(id);
  },
});
