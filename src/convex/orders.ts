import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const PLANS: Record<string, { name: string; amountCents: number }> = {
  crew: { name: "Crew", amountCents: 900 },
  premiere: { name: "Premiere", amountCents: 2400 },
};

export const create = mutation({
  args: { plan: v.string() },
  handler: async (ctx, { plan }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const def = PLANS[plan];
    if (!def) throw new Error("Unknown plan");
    const createdAt = Date.now();
    const id = await ctx.db.insert("orders", {
      userId,
      plan,
      amountCents: def.amountCents,
      status: "paid", // placeholder until a payment provider is wired up
      createdAt,
    });
    return { id, plan, amountCents: def.amountCents, createdAt };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows;
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") throw new Error("Admin access required");
    const rows = await ctx.db.query("orders").collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return await Promise.all(
      rows.map(async (o) => {
        const member = await ctx.db.get(o.userId);
        return {
          _id: o._id,
          plan: o.plan,
          amountCents: o.amountCents,
          status: o.status,
          createdAt: o.createdAt,
          memberName: member?.name ?? member?.email ?? "Member",
        };
      }),
    );
  },
});
