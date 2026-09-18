import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getFullUser } from "./usersHelpers";

export const listByMovie = query({
  args: { movieId: v.id("movies") },
  handler: async (ctx, { movieId }) => {
    const rows = await ctx.db
      .query("comments")
      .withIndex("by_movie", (q) => q.eq("movieId", movieId))
      .collect();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return await Promise.all(
      rows.map(async (c) => ({
        _id: c._id,
        text: c.text,
        createdAt: c.createdAt,
        userId: c.userId,
        authorName: (await getFullUser(ctx, c.userId))?.name ?? null,
      })),
    );
  },
});

export const add = mutation({
  args: { movieId: v.id("movies"), text: v.string() },
  handler: async (ctx, { movieId, text }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Comment cannot be empty");
    await ctx.db.insert("comments", {
      movieId,
      userId,
      text: trimmed.slice(0, 1000),
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("comments") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const comment = await ctx.db.get(id);
    if (!comment) throw new Error("Comment not found");
    if (comment.userId !== userId) throw new Error("Not your comment");
    await ctx.db.delete(id);
  },
});
