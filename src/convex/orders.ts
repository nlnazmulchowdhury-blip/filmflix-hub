import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const PLANS: Record<string, { name: string; amountCents: number }> = {
  crew: { name: "Crew", amountCents: 900 },
  premiere: { name: "Premiere", amountCents: 2400 },
};

/** Anti-spam cap: how many orders one user may create per rate window. */
const MAX_ORDERS_PER_WINDOW = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Create a plan order. Orders ALWAYS start as "pending" — nothing in this
 * mutation can grant a plan. An order only becomes "paid" through the
 * admin-only `markPaid` mutation below (the seam where a real payment
 * provider's webhook will land), so a signed-in user can never self-grant
 * Crew/Premiere by calling this.
 */
export const create = mutation({
  args: { plan: v.string() },
  handler: async (ctx, { plan }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("Not authenticated");
    // Throwaway guest accounts must not be able to spam order records.
    if (user.isAnonymous) {
      throw new Error(
        "Guest accounts cannot place plan orders. Sign in with your email first.",
      );
    }
    const def = PLANS[plan];
    if (!def) throw new Error("Unknown plan");

    const mine = await ctx.db
      .query("orders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    // Idempotency: reuse an existing pending order for the same plan
    // instead of piling up duplicates on double-clicks / retries.
    const existingPending = mine.find(
      (o) => o.plan === plan && o.status === "pending",
    );
    if (existingPending) {
      return {
        id: existingPending._id,
        plan: existingPending.plan,
        amountCents: existingPending.amountCents,
        createdAt: existingPending.createdAt,
        status: existingPending.status,
      };
    }

    // Rate limit: cap order creation per user per window.
    const now = Date.now();
    const recentCount = mine.filter(
      (o) => now - o.createdAt < RATE_WINDOW_MS,
    ).length;
    if (recentCount >= MAX_ORDERS_PER_WINDOW) {
      throw new Error("Too many orders — please try again later.");
    }

    const id = await ctx.db.insert("orders", {
      userId,
      plan,
      amountCents: def.amountCents,
      status: "pending",
      createdAt: now,
    });
    return {
      id,
      plan,
      amountCents: def.amountCents,
      createdAt: now,
      status: "pending" as const,
    };
  },
});

/**
 * Flip an order to "paid" — the only path that grants a plan. Admin-only
 * until a payment provider is wired up; when that happens this gets replaced
 * by a signature-verified webhook mutation, and `create` above still never
 * grants anything on its own.
 */
export const markPaid = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") throw new Error("Admin access required");
    const order = await ctx.db.get(orderId);
    if (!order) throw new Error("Order not found");
    // Idempotent: re-marking a paid order is a no-op.
    if (order.status !== "paid") {
      await ctx.db.patch(orderId, { status: "paid", paidAt: Date.now() });
    }
    return orderId;
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
