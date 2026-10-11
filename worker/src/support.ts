import { Hono } from "hono";
import { requireUser, requireAdmin, HttpError, type Env } from "./index";

const MAX_LEN = 1000;

interface MsgRow {
  id: string;
  user_id: string;
  sender: "user" | "admin";
  text: string;
  created_at: number;
  seen_by_user: number;
  seen_by_admin: number;
}

function msgOut(r: MsgRow) {
  return {
    _id: r.id,
    sender: r.sender,
    text: r.text,
    createdAt: r.created_at,
    userId: r.user_id,
  };
}

/** Visitor-side + admin-side help chat, mirroring the Convex support module
 *  so HelpCenterWidget and Admin behave identically on the REST client. */
export const supportRoutes = new Hono<Env>();

/* ---------------- user side ---------------- */

supportRoutes.get("/mine", async (c) => {
  const user = await requireUser(c);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM support_messages WHERE user_id = ? ORDER BY created_at`,
  ).bind(user.id).all<MsgRow>();
  return c.json((results ?? []).map(msgOut));
});

supportRoutes.get("/unread-for-user", async (c) => {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM support_messages
     WHERE user_id = ? AND sender = 'admin' AND seen_by_user = 0`,
  ).bind(user.id).first<{ n: number }>();
  return c.json({ count: row?.n ?? 0 });
});

supportRoutes.post("/send-from-user", async (c) => {
  const user = await requireUser(c);
  const { text } = await c.req.json<{ text: string }>();
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Message cannot be empty");
  const mid = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO support_messages (id, user_id, sender, text, created_at, seen_by_user, seen_by_admin)
     VALUES (?, ?, 'user', ?, ?, 0, 0)`,
  ).bind(mid, user.id, trimmed.slice(0, MAX_LEN), Date.now()).run();
  return c.json({ id: mid });
});

supportRoutes.patch("/from-user/:messageId", async (c) => {
  const user = await requireUser(c);
  const { text } = await c.req.json<{ text: string }>();
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Message cannot be empty");
  const row = await c.env.DB.prepare(
    `SELECT user_id, sender FROM support_messages WHERE id = ?`,
  ).bind(c.req.param("messageId")).first<{ user_id: string; sender: string }>();
  if (!row || row.user_id !== user.id || row.sender !== "user") {
    throw new HttpError(404, "Message not found");
  }
  await c.env.DB.prepare(`UPDATE support_messages SET text = ? WHERE id = ?`)
    .bind(trimmed.slice(0, MAX_LEN), c.req.param("messageId")).run();
  return c.json({ ok: true });
});

supportRoutes.delete("/from-user/:messageId", async (c) => {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare(
    `SELECT user_id, sender FROM support_messages WHERE id = ?`,
  ).bind(c.req.param("messageId")).first<{ user_id: string; sender: string }>();
  if (!row || row.user_id !== user.id || row.sender !== "user") {
    throw new HttpError(404, "Message not found");
  }
  await c.env.DB.prepare(`DELETE FROM support_messages WHERE id = ?`)
    .bind(c.req.param("messageId")).run();
  return c.json({ ok: true });
});

supportRoutes.post("/mark-seen-by-user", async (c) => {
  const user = await requireUser(c);
  await c.env.DB.prepare(
    `UPDATE support_messages SET seen_by_user = 1
     WHERE user_id = ? AND sender = 'admin' AND seen_by_user = 0`,
  ).bind(user.id).run();
  return c.json({ ok: true });
});

/* ---------------- admin side ---------------- */

supportRoutes.get("/conversations", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.user_id, m.sender, m.text, m.created_at,
            m.seen_by_user, m.seen_by_admin,
            u.name, u.email, u.is_anonymous
     FROM support_messages m LEFT JOIN users u ON u.id = m.user_id
     ORDER BY m.created_at`,
  ).all<any>();
  const byUser = new Map<string, any>();
  for (const r of results ?? []) {
    const e = byUser.get(r.user_id) ?? {
      userId: r.user_id,
      lastText: "",
      lastSender: "user",
      lastAt: 0,
      unread: 0,
      messageCount: 0,
      userName: r.name ?? r.email ?? "Guest member",
      userEmail: r.email ?? null,
      isAnonymous: !!r.is_anonymous,
    };
    e.lastText = r.text;
    e.lastSender = r.sender;
    e.lastAt = r.created_at;
    e.messageCount++;
    if (r.sender === "user" && !r.seen_by_admin) e.unread++;
    byUser.set(r.user_id, e);
  }
  return c.json([...byUser.values()].sort((a, b) => b.lastAt - a.lastAt));
});

supportRoutes.get("/thread/:userId", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM support_messages WHERE user_id = ? ORDER BY created_at`,
  ).bind(c.req.param("userId")).all<MsgRow>();
  return c.json((results ?? []).map(msgOut));
});

supportRoutes.get("/unread-for-admin", async (c) => {
  await requireAdmin(c);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM support_messages
     WHERE sender = 'user' AND seen_by_admin = 0`,
  ).first<{ n: number }>();
  return c.json({ count: row?.n ?? 0 });
});

supportRoutes.post("/reply-from-admin", async (c) => {
  await requireAdmin(c);
  const { userId, text } = await c.req.json<{ userId: string; text: string }>();
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Message cannot be empty");
  if (!userId) throw new HttpError(400, "Conversation user is required");
  const mid = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO support_messages (id, user_id, sender, text, created_at, seen_by_user, seen_by_admin)
     VALUES (?, ?, 'admin', ?, ?, 0, 0)`,
  ).bind(mid, userId, trimmed.slice(0, MAX_LEN), Date.now()).run();
  return c.json({ id: mid });
});

supportRoutes.patch("/as-admin/:messageId", async (c) => {
  await requireAdmin(c);
  const { text } = await c.req.json<{ text: string }>();
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Message cannot be empty");
  const row = await c.env.DB.prepare(
    `SELECT id FROM support_messages WHERE id = ?`,
  ).bind(c.req.param("messageId")).first();
  if (!row) throw new HttpError(404, "Message not found");
  await c.env.DB.prepare(`UPDATE support_messages SET text = ? WHERE id = ?`)
    .bind(trimmed.slice(0, MAX_LEN), c.req.param("messageId")).run();
  return c.json({ ok: true });
});

supportRoutes.delete("/as-admin/:messageId", async (c) => {
  await requireAdmin(c);
  await c.env.DB.prepare(`DELETE FROM support_messages WHERE id = ?`)
    .bind(c.req.param("messageId")).run();
  return c.json({ ok: true });
});

supportRoutes.post("/mark-seen-by-admin", async (c) => {
  await requireAdmin(c);
  const { userId } = await c.req.json<{ userId: string }>();
  if (!userId) throw new HttpError(400, "Conversation user is required");
  await c.env.DB.prepare(
    `UPDATE support_messages SET seen_by_admin = 1
     WHERE user_id = ? AND sender = 'user' AND seen_by_admin = 0`,
  ).bind(userId).run();
  return c.json({ ok: true });
});
