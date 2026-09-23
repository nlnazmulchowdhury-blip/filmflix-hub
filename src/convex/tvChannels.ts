import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Trimmed, de-duplicated, lowercase-clean category list (or undefined). */
function normalizeCategories(categories?: string[]): string[] | undefined {
  if (!categories) return undefined;
  const seen = new Set<string>();
  for (const raw of categories) {
    const name = raw.trim();
    if (name) seen.add(name);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/** Public: all live TV channels, ordered. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("tvChannels").collect();
    return rows.sort((a, b) => {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.createdAt - b.createdAt;
    });
  },
});

async function requireAdmin(ctx: { db: unknown; auth: unknown }) {
  const userId = await getAuthUserId(ctx as never);
  if (userId === null) throw new Error("Not authenticated");
  const me = await (ctx.db as never as { get(id: unknown): Promise<{ role?: string } | null> }).get(userId);
  if (me?.role !== "admin") throw new Error("Admin access required");
  return userId;
}

export const add = mutation({
  args: {
    name: v.string(),
    logoUrl: v.optional(v.string()),
    streamUrl: v.string(),
    categories: v.optional(v.array(v.string())),
    order: v.optional(v.number()),
  },
  handler: async (ctx, { name, logoUrl, streamUrl, categories, order }) => {
    await requireAdmin(ctx);
    return await ctx.db.insert("tvChannels", {
      name: name.trim(),
      logoUrl: logoUrl?.trim() || undefined,
      streamUrl: streamUrl.trim(),
      categories: normalizeCategories(categories),
      order,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("tvChannels"),
    name: v.string(),
    logoUrl: v.optional(v.string()),
    streamUrl: v.string(),
    categories: v.optional(v.array(v.string())),
    order: v.optional(v.number()),
  },
  handler: async (ctx, { id, name, logoUrl, streamUrl, categories, order }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(id, {
      name: name.trim(),
      logoUrl: logoUrl?.trim() || undefined,
      streamUrl: streamUrl.trim(),
      categories: normalizeCategories(categories),
      order,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("tvChannels") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(id);
  },
});
