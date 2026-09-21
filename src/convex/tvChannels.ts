import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
    order: v.optional(v.number()),
  },
  handler: async (ctx, { name, logoUrl, streamUrl, order }) => {
    await requireAdmin(ctx);
    return await ctx.db.insert("tvChannels", {
      name: name.trim(),
      logoUrl: logoUrl?.trim() || undefined,
      streamUrl: streamUrl.trim(),
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
    order: v.optional(v.number()),
  },
  handler: async (ctx, { id, name, logoUrl, streamUrl, order }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(id, {
      name: name.trim(),
      logoUrl: logoUrl?.trim() || undefined,
      streamUrl: streamUrl.trim(),
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
