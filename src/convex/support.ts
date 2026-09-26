import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Help-center chat: visitors message the admin from the floating widget;
 *  admins reply from the admin panel. One row per message. */

const MAX_LEN = 1000;

async function currentUserId(ctx: { auth: unknown }) {
  const userId = await getAuthUserId(ctx as never);
  if (userId === null) throw new Error("Not authenticated");
  return userId;
}

/** All messages of the signed-in visitor's conversation, oldest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("supportMessages")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows.map((r) => ({
      _id: r._id,
      sender: r.sender,
      text: r.text,
      createdAt: r.createdAt,
    }));
  },
});

/** Unread admin replies for the signed-in visitor (widget badge). */
export const unreadForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return 0;
    const rows = await ctx.db
      .query("supportMessages")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.filter((r) => r.sender === "admin" && !r.seenByUser).length;
  },
});

/** Visitor sends a message from the widget. */
export const sendFromUser = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const userId = await currentUserId(ctx);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Message cannot be empty");
    await ctx.db.insert("supportMessages", {
      userId,
      sender: "user",
      text: trimmed.slice(0, MAX_LEN),
      createdAt: Date.now(),
      seenByAdmin: false,
    });
  },
});

/** Mark the visitor's side as having read the admin's replies. */
export const markSeenByUser = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return;
    const rows = await ctx.db
      .query("supportMessages")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const r of rows) {
      if (r.sender === "admin" && !r.seenByUser) {
        await ctx.db.patch(r._id, { seenByUser: true });
      }
    }
  },
});

/* ------------------------- admin side ------------------------- */

async function requireAdmin(ctx: { db: unknown; auth: unknown }) {
  const userId = await getAuthUserId(ctx as never);
  if (userId === null) throw new Error("Not authenticated");
  const me = await (
    ctx.db as never as { get(id: unknown): Promise<{ role?: string } | null> }
  ).get(userId);
  if (me?.role !== "admin") throw new Error("Admin access required");
  return userId;
}

/** One summary row per conversation (latest message + unread count). */
export const listConversations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") throw new Error("Admin access required");

    const rows = await ctx.db.query("supportMessages").collect();
    rows.sort((a, b) => a.createdAt - b.createdAt);

    const byUser = new Map<
      string,
      {
        userId: string;
        lastText: string;
        lastSender: string;
        lastAt: number;
        unread: number;
        messageCount: number;
      }
    >();
    for (const r of rows) {
      const entry = byUser.get(r.userId) ?? {
        userId: r.userId,
        lastText: "",
        lastSender: "user",
        lastAt: 0,
        unread: 0,
        messageCount: 0,
      };
      entry.lastText = r.text;
      entry.lastSender = r.sender;
      entry.lastAt = r.createdAt;
      entry.messageCount++;
      if (r.sender === "user" && !r.seenByAdmin) entry.unread++;
      byUser.set(r.userId, entry);
    }

    const out = [];
    for (const entry of byUser.values()) {
      const user = (await ctx.db.get(entry.userId as never)) as {
        name?: string;
        email?: string;
        isAnonymous?: boolean;
      } | null;
      out.push({
        ...entry,
        userName: user?.name ?? user?.email ?? "Guest member",
        userEmail: user?.email ?? null,
        isAnonymous: user?.isAnonymous ?? false,
      });
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    return out;
  },
});

/** Full thread of one conversation (admin only). */
export const listThread = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) throw new Error("Not authenticated");
    const me = await ctx.db.get(adminId);
    if (me?.role !== "admin") throw new Error("Admin access required");
    const rows = await ctx.db
      .query("supportMessages")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows.map((r) => ({
      _id: r._id,
      sender: r.sender,
      text: r.text,
      createdAt: r.createdAt,
    }));
  },
});

/** Unread user messages across all conversations (admin badge). */
export const unreadForAdmin = query({
  args: {},
  handler: async (ctx) => {
    const adminId = await getAuthUserId(ctx);
    if (adminId === null) return 0;
    const me = await ctx.db.get(adminId);
    if (me?.role !== "admin") return 0;
    const rows = await ctx.db.query("supportMessages").collect();
    return rows.filter((r) => r.sender === "user" && !r.seenByAdmin).length;
  },
});

/** Admin replies to a conversation. */
export const replyFromAdmin = mutation({
  args: { userId: v.id("users"), text: v.string() },
  handler: async (ctx, { userId, text }) => {
    await requireAdmin(ctx);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Message cannot be empty");
    await ctx.db.insert("supportMessages", {
      userId,
      sender: "admin",
      text: trimmed.slice(0, MAX_LEN),
      createdAt: Date.now(),
      seenByUser: false,
    });
  },
});

/** Mark the admin side as having read a conversation. */
export const markSeenByAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("supportMessages")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const r of rows) {
      if (r.sender === "user" && !r.seenByAdmin) {
        await ctx.db.patch(r._id, { seenByAdmin: true });
      }
    }
  },
});