import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";

/** Named TV category chips for the /tv page, managed from the admin panel.
 *  Same idea as the movie "categories" table: chips exist even with zero
 *  channels attached, and renaming updates every channel that lists the old
 *  name. Channels keep a plain string[] of category names. */

async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (user?.role !== "admin") throw new Error("Admin access required");
  return user;
}

/** All TV categories, alphabetical. */
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("tvCategories").collect();
    return rows
      .map((r) => ({ _id: r._id, name: r.name, createdAt: r.createdAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Create a TV category chip — no channel required. Admin-only. */
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await requireAdmin(ctx);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Category name is required");
    if (trimmed.length > 60)
      throw new Error("Category name is too long (max 60 characters)");

    const existing = await ctx.db
      .query("tvCategories")
      .withIndex("by_name", (q) => q.eq("name", trimmed))
      .first();
    if (existing) throw new Error(`Category "${trimmed}" already exists`);

    await ctx.db.insert("tvCategories", {
      name: trimmed,
      createdAt: Date.now(),
    });
    return trimmed;
  },
});

/** Rename a TV category chip AND every channel that references the old name. */
export const rename = mutation({
  args: { id: v.id("tvCategories"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Category not found");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Category name is required");
    if (trimmed.length > 60)
      throw new Error("Category name is too long (max 60 characters)");
    if (trimmed === row.name) return trimmed;

    const dupe = await ctx.db
      .query("tvCategories")
      .withIndex("by_name", (q) => q.eq("name", trimmed))
      .first();
    if (dupe) throw new Error(`Category "${trimmed}" already exists`);

    await ctx.db.patch(id, { name: trimmed });

    // Mirror the rename onto every channel that lists the old name.
    const channels = await ctx.db.query("tvChannels").collect();
    for (const c of channels) {
      const cats = c.categories ?? [];
      if (!cats.includes(row.name)) continue;
      const next = [...new Set(cats.map((n) => (n === row.name ? trimmed : n)))];
      await ctx.db.patch(c._id, { categories: next });
    }
    return trimmed;
  },
});

/**
 * Delete a TV category chip: removes it from the tvCategories table AND
 * strips the name from every channel that references it. Channels stay —
 * they just lose this one chip.
 */
export const remove = mutation({
  args: { id: v.id("tvCategories") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Category not found");

    await ctx.db.delete(id);

    const channels = await ctx.db.query("tvChannels").collect();
    for (const c of channels) {
      const cats = c.categories ?? [];
      if (!cats.includes(row.name)) continue;
      const rest = cats.filter((n) => n !== row.name);
      await ctx.db.patch(c._id, {
        categories: rest.length > 0 ? rest : undefined,
      });
    }
    return row.name;
  },
});
