import { Hono } from "hono";
import { cors } from "hono/cors";
import { sha256 } from "./crypto";
import { probeUrl, collectMovieUrls, collectTvUrls } from "./linkcheck";
import { resolveRedirect, isShortLink } from "./shortlinks";
import { dubbingRoutes } from "./dubbing";
import { sendOtpEmail } from "./email";

export interface Bindings {
  DB: D1Database;
  DUBS: R2Bucket;
  ADMIN_ACCESS_CODE?: string;
  ELEVENLABS_API_KEY?: string;
  RESEND_API_KEY?: string;
  OTP_FROM_NAME?: string;
}

export type Env = { Bindings: Bindings } & { Variables: { userId?: string; role?: string | null } };

const app = new Hono<Env>();

app.use("*", cors({
  origin: [
    "https://film.freebuff.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400,
}));

const DAY_MS = 86_400_000;
const SESSION_TTL_MS = 30 * DAY_MS;

const id = () => crypto.randomUUID();

/* ------------------------------------------------------------------ */
/* auth helpers                                                        */
/* ------------------------------------------------------------------ */

async function userForToken(db: D1Database, authHeader: string | undefined) {
  const raw = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!raw) return null;
  const hash = await sha256(raw);
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.is_anonymous, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .bind(hash)
    .first<{
      id: string; email: string | null; name: string | null;
      role: string | null; is_anonymous: number; expires_at: number;
    }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(hash).run();
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isAnonymous: !!row.is_anonymous,
  };
}

export async function requireUser(c: any) {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  if (!user) throw new HttpError(401, "Not authenticated");
  c.set("userId", user.id);
  c.set("role", user.role);
  return user;
}

export async function requireAdmin(c: any) {
  const user = await requireUser(c);
  if (user.role !== "admin") throw new HttpError(403, "Admin access required");
  return user;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const onError = (err: unknown, c: any) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Internal error";
  return c.json({ error: message }, { status });
};

/** Shape a movies row like the Convex doc the frontend expects. */
function movieOut(r: any) {
  return {
    _id: r.id,
    _creationTime: r.created_at,
    title: r.title,
    description: r.description ?? undefined,
    posterUrl: r.poster_url ?? undefined,
    backdropUrl: r.backdrop_url ?? undefined,
    videoUrl: r.video_url ?? undefined,
    genre: r.genre ?? undefined,
    category: r.category ?? undefined,
    categories: r.categories ? JSON.parse(r.categories) : undefined,
    year: r.year ?? undefined,
    rating: r.rating ?? undefined,
    kind: r.kind ?? undefined,
    qualities: r.qualities ? JSON.parse(r.qualities) : undefined,
    subtitles: r.subtitles ? JSON.parse(r.subtitles) : undefined,
    episodes: r.episodes ? JSON.parse(r.episodes) : undefined,
    dubs: r.dubs ? JSON.parse(r.dubs) : undefined,
    seasons: r.seasons ? JSON.parse(r.seasons) : undefined,
    order: r.sort_order ?? undefined,
    contributorId: r.contributor_id ?? undefined,
  };
}

async function getMovieRow(db: D1Database, mid: string) {
  return db.prepare(`SELECT * FROM movies WHERE id = ?`).bind(mid).first<any>();
}

/* ------------------------------------------------------------------ */
/* auth: OTP + sessions                                                */
/* ------------------------------------------------------------------ */

app.post("/auth/request-otp", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address");
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + 15 * 60_000;
  await c.env.DB.prepare(
    `INSERT INTO otp_codes (email, code, expires_at, used) VALUES (?, ?, ?, 0)`,
  ).bind(email.toLowerCase(), code, expires).run();
  await sendOtpEmail(c.env, email, code);
  return c.json({ sent: true });
});

app.post("/auth/verify-otp", async (c) => {
  const { email, code, name } = await c.req.json<{ email: string; code: string; name?: string }>();
  const mail = (email ?? "").toLowerCase();
  const row = await c.env.DB.prepare(
    `SELECT rowid, code, expires_at, used FROM otp_codes
     WHERE email = ? AND used = 0 ORDER BY rowid DESC LIMIT 1`,
  ).bind(mail).first<any>();
  if (!row || row.code !== (code ?? "").trim() || row.expires_at < Date.now()) {
    throw new HttpError(400, "The verification code you entered is incorrect.");
  }
  await c.env.DB.prepare(`UPDATE otp_codes SET used = 1 WHERE rowid = ?`).bind(row.rowid).run();

  let user = await c.env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(mail).first<any>();
  if (!user) {
    const uid = id();
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, role, is_anonymous, created_at)
       VALUES (?, ?, ?, NULL, 0, ?)`,
    ).bind(uid, mail, name ?? mail.split("@")[0], Date.now()).run();
    user = { id: uid, role: null };
  } else if (name && !user.name) {
    await c.env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(name, user.id).run();
  }

  const raw = crypto.randomUUID() + "." + crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  ).bind(await sha256(raw), user.id, Date.now() + SESSION_TTL_MS).run();
  return c.json({ token: raw, userId: user.id });
});

app.post("/auth/guest", async (c) => {
  const uid = id();
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, role, is_anonymous, created_at)
     VALUES (?, NULL, 'Guest member', NULL, 1, ?)`,
  ).bind(uid, Date.now()).run();
  const raw = crypto.randomUUID() + "." + crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  ).bind(await sha256(raw), uid, Date.now() + SESSION_TTL_MS).run();
  return c.json({ token: raw, userId: uid });
});

app.post("/auth/sign-out", async (c) => {
  const raw = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (raw) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE token = ?`)
      .bind(await sha256(raw)).run();
  }
  return c.json({ ok: true });
});

app.get("/auth/me", async (c) => {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  return c.json({ user });
});

/* ------------------------------------------------------------------ */
/* users / admin roles                                                 */
/* ------------------------------------------------------------------ */

app.get("/users/me", async (c) => {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  return c.json({ user });
});

app.get("/admin/users", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, name, role, is_anonymous FROM users ORDER BY email`,
  ).all();
  return c.json((results ?? []).map((u) => ({
    _id: u.id, email: u.email ?? null, name: u.name ?? null,
    role: u.role ?? null, isAnonymous: !!u.is_anonymous,
  })));
});

app.patch("/admin/users/:uid/role", async (c) => {
  const me = await requireAdmin(c);
  const { role } = await c.req.json<{ role: "admin" | "member" | null }>();
  if (me.id === c.req.param("uid") && role !== "admin") {
    throw new HttpError(400, "You can't remove your own admin access");
  }
  await c.env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`)
    .bind(role ?? null, c.req.param("uid")).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* admin unlock code                                                   */
/* ------------------------------------------------------------------ */

app.post("/movies/verify-admin-code", async (c) => {
  const user = await requireUser(c);
  if (user.role === "admin") return c.json({ result: "already-admin" });
  const expected = c.env.ADMIN_ACCESS_CODE;
  if (!expected) throw new HttpError(500, "ADMIN_ACCESS_CODE is not configured on the worker");
  const { code } = await c.req.json<{ code: string }>();
  if ((code ?? "").trim() !== expected) throw new HttpError(400, "Incorrect admin access code");
  await c.env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(user.id).run();
  return c.json({ result: "claimed" });
});

/* ------------------------------------------------------------------ */
/* movies                                                              */
/* ------------------------------------------------------------------ */

app.get("/movies", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM movies ORDER BY COALESCE(sort_order, 999999), created_at`,
  ).all();
  return c.json((results ?? []).map(movieOut));
});

app.get("/movies/:mid", async (c) => {
  const row = await getMovieRow(c.env.DB, c.req.param("mid"));
  if (!row) throw new HttpError(404, "Movie not found");
  return c.json(movieOut(row));
});

const movieFields = [
  "title", "description", "posterUrl", "backdropUrl", "videoUrl", "genre",
  "year", "rating", "kind", "order", "qualities", "subtitles", "episodes",
  "dubs", "seasons",
];

function normalizeCategories(input: { category?: string; categories?: string[] }): string[] {
  return [...new Set(
    [...(input.categories ?? []), input.category ?? ""]
      .map((s) => (s ?? "").trim())
      .filter(Boolean),
  )];
}

app.post("/movies", async (c) => {
  await requireAdmin(c);
  const body = await c.req.json<any>();
  const names = normalizeCategories(body);
  const mid = id();
  const order = body.order ?? (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM movies`).first<any>()).n;
  await c.env.DB.prepare(
    `INSERT INTO movies (id, title, description, poster_url, backdrop_url, video_url,
       genre, category, categories, year, rating, kind, qualities, subtitles,
       episodes, dubs, seasons, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    mid, body.title ?? "Untitled", body.description ?? null,
    body.posterUrl ?? null, body.backdropUrl ?? null, body.videoUrl ?? null,
    body.genre ?? null, names[0] ?? null, names.length ? JSON.stringify(names) : null,
    body.year ?? null, body.rating ?? null, body.kind ?? null,
    body.qualities ? JSON.stringify(body.qualities) : null,
    body.subtitles ? JSON.stringify(body.subtitles) : null,
    body.episodes ? JSON.stringify(body.episodes) : null,
    body.dubs ? JSON.stringify(body.dubs) : null,
    body.seasons ? JSON.stringify(body.seasons) : null,
    order, Date.now(),
  ).run();
  return c.json({ id: mid });
});

app.patch("/movies/:mid", async (c) => {
  await requireAdmin(c);
  const body = await c.req.json<any>();
  const row = await getMovieRow(c.env.DB, c.req.param("mid"));
  if (!row) throw new HttpError(404, "Movie not found");
  const names = normalizeCategories(body);

  const sets: string[] = [];
  const binds: any[] = [];
  const col = (name: string, colName: string, val: any, json = false) => {
    if (val === undefined) return;
    sets.push(`${colName} = ?`);
    binds.push(json ? JSON.stringify(val) : val === null ? null : val);
  };
  col(body.title, "title", body.title);
  col(body.description, "description", body.description ?? null);
  col(body.posterUrl, "poster_url", body.posterUrl ?? null);
  col(body.backdropUrl, "backdrop_url", body.backdropUrl ?? null);
  col(body.videoUrl, "video_url", body.videoUrl ?? null);
  col(body.genre, "genre", body.genre ?? null);
  col(body.year, "year", body.year ?? null);
  col(body.rating, "rating", body.rating ?? null);
  col(body.kind, "kind", body.kind ?? null);
  col(body.order, "sort_order", body.order ?? null);
  col(body.qualities, "qualities", body.qualities ?? null, true);
  col(body.subtitles, "subtitles", body.subtitles ?? null, true);
  col(body.episodes, "episodes", body.episodes ?? null, true);
  col(body.dubs, "dubs", body.dubs ?? null, true);
  col(body.seasons, "seasons", body.seasons ?? null, true);
  if (names.length > 0 || body.categories !== undefined || body.category !== undefined) {
    sets.push(`category = ?`, `categories = ?`);
    binds.push(names[0] ?? null, names.length ? JSON.stringify(names) : null);
  }
  if (sets.length > 0) {
    await c.env.DB.prepare(
      `UPDATE movies SET ${sets.join(", ")} WHERE id = ?`,
    ).bind(...binds, row.id).run();
  }
  return c.json({ id: row.id });
});

app.delete("/movies/:mid", async (c) => {
  await requireAdmin(c);
  await c.env.DB.prepare(`DELETE FROM movies WHERE id = ?`)
    .bind(c.req.param("mid")).run();
  return c.json({ ok: true });
});

/** Admin: strip a category name from every movie (keep movies). */
app.post("/movies/remove-category", async (c) => {
  await requireAdmin(c);
  const { category } = await c.req.json<{ category: string }>();
  const trimmed = (category ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Category name is required");
  const { results } = await c.env.DB.prepare(`SELECT id, categories FROM movies`).all<{ id: string; categories: string | null }>();
  let changed = 0;
  for (const r of results ?? []) {
    const names: string[] = r.categories ? JSON.parse(r.categories) : [];
    if (!names.includes(trimmed)) continue;
    const rest = names.filter((n) => n !== trimmed);
    await c.env.DB.prepare(`UPDATE movies SET categories = ?, category = ? WHERE id = ?`)
      .bind(rest.length ? JSON.stringify(rest) : null, rest[0] ?? null, r.id).run();
    changed++;
  }
  return c.json({ changed });
});

/* ------------------------------------------------------------------ */
/* categories                                                          */
/* ------------------------------------------------------------------ */

app.get("/categories", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, created_at FROM categories`,
  ).all();
  return c.json((results ?? [])
    .map((r: any) => ({ _id: r.id, name: r.name as string, createdAt: r.created_at as number }))
    .sort((a, b) => a.name.localeCompare(b.name)));
});

app.post("/categories", async (c) => {
  await requireAdmin(c);
  const { name } = await c.req.json<{ name: string }>();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Category name is required");
  if (trimmed.length > 60) throw new HttpError(400, "Category name is too long (max 60 characters)");
  const exists = await c.env.DB.prepare(`SELECT id FROM categories WHERE name = ?`)
    .bind(trimmed).first();
  if (exists) throw new HttpError(409, `Category "${trimmed}" already exists`);
  await c.env.DB.prepare(`INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)`)
    .bind(id(), trimmed, Date.now()).run();
  return c.json({ name: trimmed });
});

app.delete("/categories/:cid", async (c) => {
  await requireAdmin(c);
  const cid = c.req.param("cid");
  const row = await c.env.DB.prepare(`SELECT name FROM categories WHERE id = ?`).bind(cid).first<{ name: string }>();
  if (!row) throw new HttpError(404, "Category not found");
  await c.env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(cid).run();
  const { results } = await c.env.DB.prepare(`SELECT id, categories FROM movies`).all<{ id: string; categories: string | null }>();
  for (const r of results ?? []) {
    const names: string[] = r.categories ? JSON.parse(r.categories) : [];
    if (!names.includes(row.name)) continue;
    const rest = names.filter((n) => n !== row.name);
    await c.env.DB.prepare(`UPDATE movies SET categories = ?, category = ? WHERE id = ?`)
      .bind(rest.length ? JSON.stringify(rest) : null, rest[0] ?? null, r.id).run();
  }
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* comments                                                            */
/* ------------------------------------------------------------------ */

app.get("/movies/:mid/comments", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT cm.id, cm.text, cm.created_at, cm.user_id, u.name, u.email
     FROM comments cm LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.movie_id = ? ORDER BY cm.created_at`,
  ).bind(c.req.param("mid")).all();
  return c.json((results ?? []).map((r) => ({
    _id: r.id, text: r.text, createdAt: r.created_at, userId: r.user_id,
    authorName: r.name ?? r.email ?? null,
  })));
});

app.get("/comments", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    `SELECT cm.id, cm.text, cm.created_at, cm.movie_id, u.name, u.email,
            m.title AS movie_title
     FROM comments cm
     LEFT JOIN users u ON u.id = cm.user_id
     LEFT JOIN movies m ON m.id = cm.movie_id
     ORDER BY cm.created_at DESC`,
  ).all();
  return c.json((results ?? []).map((r) => ({
    _id: r.id, text: r.text, createdAt: r.created_at, movieId: r.movie_id,
    movieTitle: r.movie_title ?? "Removed movie",
    authorName: r.name ?? r.email ?? "Member",
  })));
});

app.post("/movies/:mid/comments", async (c) => {
  const user = await requireUser(c);
  const { text } = await c.req.json<{ text: string }>();
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Comment cannot be empty");
  await c.env.DB.prepare(
    `INSERT INTO comments (id, movie_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(id(), c.req.param("mid"), user.id, trimmed.slice(0, 1000), Date.now()).run();
  return c.json({ ok: true });
});

app.delete("/comments/:cid", async (c) => {
  const user = await requireUser(c);
  const cid = c.req.param("cid");
  const row = await c.env.DB.prepare(`SELECT user_id FROM comments WHERE id = ?`).bind(cid).first<any>();
  if (!row) throw new HttpError(404, "Comment not found");
  if (row.user_id !== user.id && user.role !== "admin") {
    throw new HttpError(403, "Not allowed to delete this comment");
  }
  await c.env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(cid).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* screenings                                                          */
/* ------------------------------------------------------------------ */

app.post("/screenings", async (c) => {
  const user = await requireUser(c);
  const { movieId, scheduledFor, note } = await c.req.json<any>();
  if (!movieId) throw new HttpError(400, "Pick a movie first");
  if (!(await getMovieRow(c.env.DB, movieId))) throw new HttpError(404, "Movie not found");
  const sid = id();
  await c.env.DB.prepare(
    `INSERT INTO screenings (id, movie_id, user_id, scheduled_for, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(sid, movieId, user.id, scheduledFor, note || null, Date.now()).run();
  return c.json({ id: sid });
});

app.get("/screenings/mine", async (c) => {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  if (!user) return c.json([]);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.scheduled_for, s.note, s.created_at, s.movie_id,
            m.title AS movie_title, m.poster_url AS movie_poster
     FROM screenings s LEFT JOIN movies m ON m.id = s.movie_id
     WHERE s.user_id = ?`,
  ).bind(user.id).all();
  return c.json((results ?? []).map((r) => ({
    _id: r.id, scheduledFor: r.scheduled_for, note: r.note ?? null,
    createdAt: r.created_at, movieId: r.movie_id,
    movieTitle: r.movie_title ?? "Removed movie", moviePoster: r.movie_poster ?? null,
  })));
});

app.get("/screenings", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.scheduled_for, s.note, u.name, u.email, m.title AS movie_title
     FROM screenings s
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN movies m ON m.id = s.movie_id`,
  ).all();
  return c.json((results ?? []).map((r) => ({
    _id: r.id, scheduledFor: r.scheduled_for, note: r.note ?? null,
    movieTitle: r.movie_title ?? "Removed movie",
    ownerName: r.name ?? r.email ?? "Member",
  })));
});

app.delete("/screenings/:sid", async (c) => {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare(`SELECT user_id FROM screenings WHERE id = ?`)
    .bind(c.req.param("sid")).first<any>();
  if (!row) throw new HttpError(404, "Screening not found");
  if (row.user_id !== user.id) throw new HttpError(403, "Not your screening");
  await c.env.DB.prepare(`DELETE FROM screenings WHERE id = ?`).bind(c.req.param("sid")).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* orders                                                              */
/* ------------------------------------------------------------------ */

const PLANS: Record<string, number> = { crew: 900, premiere: 2400 };
const MAX_ORDERS_PER_WINDOW = 5;
const RATE_WINDOW_MS = 3_600_000;

app.post("/orders", async (c) => {
  const user = await requireUser(c);
  if (user.isAnonymous) {
    throw new HttpError(403, "Guest accounts cannot place plan orders. Sign in with your email first.");
  }
  const { plan } = await c.req.json<{ plan: string }>();
  const amount = PLANS[plan];
  if (!amount) throw new HttpError(400, "Unknown plan");

  const { results: mine } = await c.env.DB.prepare(
    `SELECT * FROM orders WHERE user_id = ?`,
  ).bind(user.id).all();
  const pending = (mine ?? []).find((o: any) => o.plan === plan && o.status === "pending");
  if (pending) {
    return c.json({ id: pending.id, plan: pending.plan, amountCents: pending.amount_cents, createdAt: pending.created_at, status: pending.status });
  }
  const now = Date.now();
  if ((mine ?? []).filter((o: any) => now - o.created_at < RATE_WINDOW_MS).length >= MAX_ORDERS_PER_WINDOW) {
    throw new HttpError(429, "Too many orders — please try again later.");
  }
  const oid = id();
  await c.env.DB.prepare(
    `INSERT INTO orders (id, user_id, plan, amount_cents, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).bind(oid, user.id, plan, amount, now).run();
  return c.json({ id: oid, plan, amountCents: amount, createdAt: now, status: "pending" });
});

app.post("/orders/:oid/mark-paid", async (c) => {
  await requireAdmin(c);
  const oid = c.req.param("oid");
  const row = await c.env.DB.prepare(`SELECT status FROM orders WHERE id = ?`).bind(oid).first<any>();
  if (!row) throw new HttpError(404, "Order not found");
  if (row.status !== "paid") {
    await c.env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?`)
      .bind(Date.now(), oid).run();
  }
  return c.json({ ok: true });
});

app.get("/orders/mine", async (c) => {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  if (!user) return c.json([]);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
  ).bind(user.id).all();
  return c.json((results ?? []).map((o: any) => ({
    _id: o.id, plan: o.plan, amountCents: o.amount_cents, status: o.status, createdAt: o.created_at,
  })));
});

app.get("/orders", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    `SELECT o.*, u.name, u.email FROM orders o
     LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC`,
  ).all();
  return c.json((results ?? []).map((o: any) => ({
    _id: o.id, plan: o.plan, amountCents: o.amount_cents, status: o.status,
    createdAt: o.created_at, memberName: o.name ?? o.email ?? "Member",
  })));
});

/* ------------------------------------------------------------------ */
/* watchlist                                                           */
/* ------------------------------------------------------------------ */

app.get("/watchlist", async (c) => {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  if (!user) return c.json([]);
  const { results } = await c.env.DB.prepare(
    `SELECT m.* FROM watchlist w JOIN movies m ON m.id = w.movie_id
     WHERE w.user_id = ? ORDER BY w.created_at DESC`,
  ).bind(user.id).all();
  return c.json((results ?? []).map(movieOut));
});

app.post("/watchlist/:movieId", async (c) => {
  const user = await requireUser(c);
  const movieId = c.req.param("movieId");
  if (!(await getMovieRow(c.env.DB, movieId))) throw new HttpError(404, "Movie not found");
  await c.env.DB.prepare(
    `INSERT INTO watchlist (id, user_id, movie_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, movie_id) DO NOTHING`,
  ).bind(id(), user.id, movieId, Date.now()).run();
  return c.json({ ok: true });
});

app.delete("/watchlist/:movieId", async (c) => {
  const user = await requireUser(c);
  await c.env.DB.prepare(`DELETE FROM watchlist WHERE user_id = ? AND movie_id = ?`)
    .bind(user.id, c.req.param("movieId")).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* TV channels                                                         */
/* ------------------------------------------------------------------ */

function tvOut(r: any) {
  return {
    _id: r.id,
    _creationTime: r.created_at,
    name: r.name,
    logoUrl: r.logo_url ?? undefined,
    streamUrl: r.stream_url,
    backupUrls: r.backup_urls ? JSON.parse(r.backup_urls) : undefined,
    categories: r.categories ? JSON.parse(r.categories) : undefined,
    order: r.sort_order ?? undefined,
    createdAt: r.created_at,
  };
}

app.get("/tv/channels", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tv_channels ORDER BY COALESCE(sort_order, 999999), created_at`,
  ).all();
  return c.json((results ?? []).map(tvOut));
});

app.post("/tv/channels", async (c) => {
  await requireAdmin(c);
  const b = await c.req.json<any>();
  const cid = id();
  await c.env.DB.prepare(
    `INSERT INTO tv_channels (id, name, logo_url, stream_url, backup_urls, categories, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    cid, (b.name ?? "").trim(), b.logoUrl ?? null, b.streamUrl ?? "",
    Array.isArray(b.backupUrls) && b.backupUrls.length ? JSON.stringify(b.backupUrls) : null,
    Array.isArray(b.categories) && b.categories.length ? JSON.stringify(b.categories) : null,
    b.order ?? null, Date.now(),
  ).run();
  return c.json({ id: cid });
});

app.patch("/tv/channels/:cid", async (c) => {
  await requireAdmin(c);
  const b = await c.req.json<any>();
  const cid = c.req.param("cid");
  await c.env.DB.prepare(
    `UPDATE tv_channels SET name = ?, logo_url = ?, stream_url = ?, backup_urls = ?, categories = ?, sort_order = ? WHERE id = ?`,
  ).bind(
    (b.name ?? "").trim(), b.logoUrl ?? null, b.streamUrl ?? "",
    Array.isArray(b.backupUrls) && b.backupUrls.length ? JSON.stringify(b.backupUrls) : null,
    Array.isArray(b.categories) && b.categories.length ? JSON.stringify(b.categories) : null,
    b.order ?? null, cid,
  ).run();
  return c.json({ ok: true });
});

app.delete("/tv/channels/:cid", async (c) => {
  await requireAdmin(c);
  await c.env.DB.prepare(`DELETE FROM tv_channels WHERE id = ?`).bind(c.req.param("cid")).run();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* analytics                                                           */
/* ------------------------------------------------------------------ */

app.post("/analytics/track", async (c) => {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  const b = await c.req.json<any>();
  await c.env.DB.prepare(
    `INSERT INTO page_views (id, path, movie_id, user_id, referrer, device, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id(), b.path ?? "/", b.movieId ?? null, user?.id ?? null,
    (b.referrer ?? null) ? String(b.referrer).slice(0, 300) : null,
    b.device ?? null, Date.now(),
  ).run();
  return c.json({ ok: true });
});

app.get("/analytics/summary", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(`SELECT * FROM page_views`).all();
  const views = results ?? [];
  const now = Date.now();
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const todayStart = d.getTime();
  const last7Start = todayStart - 6 * DAY_MS;
  const last30Start = todayStart - 29 * DAY_MS;

  const signedIn7 = new Set<string>();
  let anon7 = 0;
  const byPath = new Map<string, number>();
  const byMovie = new Map<string, number>();
  const devices = new Map<string, number>();
  const referrers = new Map<string, number>();
  const seriesBuckets = new Map<number, number>();

  for (const v of views as any[]) {
    if (v.created_at >= last7Start) {
      if (v.user_id) signedIn7.add(v.user_id); else anon7++;
    }
    byPath.set(v.path, (byPath.get(v.path) ?? 0) + 1);
    if (v.movie_id) byMovie.set(v.movie_id, (byMovie.get(v.movie_id) ?? 0) + 1);
    const dev = v.device ?? "unknown";
    devices.set(dev, (devices.get(dev) ?? 0) + 1);
    if (v.referrer) {
      try {
        const host = new URL(v.referrer).hostname.replace(/^www\./, "");
        referrers.set(host, (referrers.get(host) ?? 0) + 1);
      } catch { /* ignore */ }
    }
    const dayStart = Math.floor(v.created_at / DAY_MS) * DAY_MS;
    seriesBuckets.set(dayStart, (seriesBuckets.get(dayStart) ?? 0) + 1);
  }

  const topMovieIds = [...byMovie.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topMovies: { title: string; count: number }[] = [];
  for (const [mid, count] of topMovieIds) {
    const m = await getMovieRow(c.env.DB, mid);
    topMovies.push({ title: m?.title ?? "Deleted movie", count });
  }

  const series: { day: string; views: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dayStart = todayStart - i * DAY_MS;
    series.push({
      day: new Date(dayStart).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      views: seriesBuckets.get(dayStart) ?? 0,
    });
  }

  return c.json({
    total: views.length,
    today: views.filter((v: any) => v.created_at >= todayStart).length,
    last7: views.filter((v: any) => v.created_at >= last7Start).length,
    last30: views.filter((v: any) => v.created_at >= last30Start).length,
    visitors7: signedIn7.size + anon7,
    topPaths: [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([path, count]) => ({ path, count })),
    topMovies,
    devices: [...devices.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    topReferrers: [...referrers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([host, count]) => ({ host, count })),
    series,
  });
});

/* ------------------------------------------------------------------ */
/* short links                                                         */
/* ------------------------------------------------------------------ */

app.post("/shortlinks/expand-batch", async (c) => {
  const { urls } = await c.req.json<{ urls: string[] }>();
  const unique = [...new Set((urls ?? []).map((u) => u.trim()).filter(Boolean))];
  const map: Record<string, string> = {};
  await Promise.all(unique.map(async (url) => {
    map[url] = isShortLink(url) ? await resolveRedirect(url) : url;
  }));
  return c.json(map);
});

app.post("/shortlinks/migrate", async (c) => {
  await requireAdmin(c);
  const { results } = await c.env.DB.prepare(`SELECT * FROM movies`).all();
  let movies = 0, links = 0;
  for (const r of results ?? []) {
    const m = movieOut(r);
    const shorts = [m.posterUrl, m.backdropUrl, m.videoUrl,
      ...(m.episodes ?? []).map((e: any) => e.videoUrl)]
      .filter((u): u is string => !!u && isShortLink(u));
    if (shorts.length === 0) continue;
    const map: Record<string, string> = {};
    await Promise.all(shorts.map(async (u) => { map[u] = await resolveRedirect(u); }));
    const swap = (u?: string) => (u ? map[u] ?? u : u);
    const posterUrl = swap(m.posterUrl), backdropUrl = swap(m.backdropUrl), videoUrl = swap(m.videoUrl);
    const episodes = m.episodes?.map((e: any) => ({ ...e, videoUrl: swap(e.videoUrl) }));
    let changed = 0;
    if (posterUrl !== m.posterUrl) changed++;
    if (backdropUrl !== m.backdropUrl) changed++;
    if (videoUrl !== m.videoUrl) changed++;
    changed += (m.episodes ?? []).filter((e: any) => swap(e.videoUrl) !== e.videoUrl).length;
    if (changed === 0) continue;
    links += changed;
    await c.env.DB.prepare(
      `UPDATE movies SET poster_url = ?, backdrop_url = ?, video_url = ?, episodes = ? WHERE id = ?`,
    ).bind(posterUrl ?? null, backdropUrl ?? null, videoUrl ?? null,
      episodes ? JSON.stringify(episodes) : null, m._id).run();
    movies++;
  }
  return c.json({ movies, links });
});

/* ------------------------------------------------------------------ */
/* link health                                                         */
/* ------------------------------------------------------------------ */

app.get("/link-health/summary", async (c) => {
  const user = await userForToken(c.env.DB, c.req.header("Authorization"));
  if (!user || user.role !== "admin") return c.json({ failures: [], lastCheckedAt: null });
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM link_health WHERE status = 'fail' ORDER BY url`,
  ).all();
  const last = await c.env.DB.prepare(`SELECT MAX(checked_at) AS t FROM link_health`).first<any>();
  return c.json({
    failures: (results ?? []).map((r: any) => ({
      url: r.url, httpStatus: r.http_status, error: r.error, checkedAt: r.checked_at,
      targets: JSON.parse(r.targets),
    })),
    lastCheckedAt: last?.t ?? null,
  });
});

app.post("/link-health/check", async (c) => {
  await requireAdmin(c);
  const res = await runLinkCheck(c.env.DB);
  return c.json(res);
});

async function runLinkCheck(db: D1Database) {
  const movieUrls = await collectMovieUrls(db);
  const tvUrls = await collectTvUrls(db);
  const map = new Map<string, any[]>();
  for (const { url, target } of [...movieUrls, ...tvUrls]) {
    const list = map.get(url) ?? [];
    list.push(target);
    map.set(url, list);
  }
  let failed = 0;
  const queue = [...map.entries()];
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [url, targets] = item;
      const res = await probeUrl(url);
      if (res.status === "fail") failed++;
      await db.prepare(
        `INSERT INTO link_health (url, status, http_status, error, checked_at, targets)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET status = excluded.status,
           http_status = excluded.http_status, error = excluded.error,
           checked_at = excluded.checked_at, targets = excluded.targets`,
      ).bind(url, res.status, res.httpStatus ?? null, res.error ?? null,
        Date.now(), JSON.stringify(targets)).run();
    }
  });
  await Promise.all(workers);
  const known = [...map.keys()];
  if (known.length > 0) {
    await db.prepare(
      `DELETE FROM link_health WHERE url NOT IN (${known.map(() => "?").join(",")})`,
    ).bind(...known).run();
  } else {
    await db.prepare(`DELETE FROM link_health`).run();
  }
  return { checked: map.size, failed };
}

/* ------------------------------------------------------------------ */
/* dubbing (ElevenLabs + R2)                                           */
/* ------------------------------------------------------------------ */

app.route("/dubbing", dubbingRoutes);

/* ------------------------------------------------------------------ */
/* cron: link health every 6h                                          */
/* ------------------------------------------------------------------ */

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings) {
    const res = await runLinkCheck(env.DB);
    if (res.failed > 0) console.log(`linkHealth: ${res.failed}/${res.checked} URLs failing`);
  },
} satisfies ExportedHandler<Bindings>;
