import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";

async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (user?.role !== "admin") throw new Error("Admin access required");
  return user;
}

/** All catalog categories, alphabetical. */
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("categories").collect();
    return rows
      .map((r) => ({ _id: r._id, name: r.name, createdAt: r.createdAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Create a category directly — no movie required. Admin-only. */
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await requireAdmin(ctx);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Category name is required");
    if (trimmed.length > 60)
      throw new Error("Category name is too long (max 60 characters)");

    const existing = await ctx.db
      .query("categories")
      .withIndex("by_name", (q) => q.eq("name", trimmed))
      .first();
    if (existing) throw new Error(`Category "${trimmed}" already exists`);

    await ctx.db.insert("categories", {
      name: trimmed,
      createdAt: Date.now(),
    });
    return trimmed;
  },
});

/**
 * Delete a category: removes it from the categories table AND strips the
 * name from every movie that references it. Movies stay in the catalog as
 * uncategorized. Admin-only.
 */
export const remove = mutation({
  args: { id: v.id("categories") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Category not found");

    await ctx.db.delete(id);

    // Also strip the name from every movie that still lists it.
    const { movieCategoryNames } = await import("../lib/categories");
    const movies = await ctx.db.query("movies").withIndex("order").collect();
    for (const m of movies) {
      const names = movieCategoryNames(m);
      if (!names.includes(row.name)) continue;
      const rest = names.filter((n) => n !== row.name);
      await ctx.db.patch(m._id, {
        categories: rest.length > 0 ? rest : undefined,
        category: rest[0],
      });
    }
    return row.name;
  },
});
