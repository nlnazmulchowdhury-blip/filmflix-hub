import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";

async function requireAdmin(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const me = await ctx.db.get(userId);
  if (me?.role !== "admin") throw new Error("Admin access required");
  return { me, meId: userId };
}

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query("users").collect();
    return users
      .map((u) => ({
        _id: u._id,
        name: u.name ?? null,
        email: u.email ?? null,
        role: u.role ?? null,
        isAnonymous: u.isAnonymous ?? false,
      }))
      .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
  },
});

export const setRole = mutation({
  args: {
    userId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("member"), v.null()),
  },
  handler: async (ctx, { userId, role }) => {
    const { meId } = await requireAdmin(ctx);
    if (meId === userId && role !== "admin") {
      throw new Error("You can't remove your own admin access");
    }
    const target = await ctx.db.get(userId);
    if (!target) throw new Error("User not found");
    await ctx.db.patch(userId, { role: role ?? undefined });
  },
});
