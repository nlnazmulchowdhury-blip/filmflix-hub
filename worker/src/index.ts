import { Hono } from "hono";
import { cors } from "hono/cors";
import { sha256, HttpError } from "./crypto";
export { HttpError };
import { probeUrl, collectMovieUrls, collectTvUrls } from "./linkcheck";
import { resolveRedirect, isShortLink } from "./shortlinks";
import { dubbingRoutes } from "./dubbing";
import { sendOtpEmail } from "./email";
import { vidsrcRoutes } from "./vidsrc";
import { tmdbRoutes } from "./tmdb";
import { embedResolveRoutes } from "./embedresolve";
import { supportRoutes } from "./support";
import { tvCategoryRoutes } from "./tvCategories";
import { appBuildRoutes } from "./appbuilds";
import { uploadRoutes } from "./uploads";
import { hashPassword, verifyPassword, newSalt, newToken, SESSION_TTL_SECONDS } from "./password";

export interface Bindings {
  DB: D1Database;
  /* R2: optional — until the bucket is enabled, the /uploads routes degrade. */
  DUBS?: R2Bucket;
  UPLOADS?: R2Bucket;
  ADMIN_ACCESS_CODE?: string;
  ELEVENLABS_API_KEY?: string;
  RESEND_API_KEY?: string;
  OTP_FROM_NAME?: string;
  MOVIE_API_BASE?: string;
  MOVIE_API_KEY?: string;
  MOVIEBOX_WEB_PROXY?: string;
  /* TMDB v3 API key (read token or api_key) — powers the landing "All Movies"
     browse grid. */
  TMDB_API_KEY?: string;
}

export type Env = { Bindings: Bindings } & { Variables: { userId?: string; role?: string | null } };

const app = new Hono<Env>();

app.use("*", cors({
  origin: [
    "https://film.freebuff.app",
    "https://filmbd.pages.dev",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5199",
    "http://127.0.0.1:5199",
  ],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400,
}));

const DAY_MS = 86_400_000;
const SESSION_TTL_MS = 30 * DAY_MS;

const id = () => crypto.randomUUID();

/* ------------------------------------------------------------------ */
/* shared session helper (used by OTP + password flows)                 */
/* ------------------------------------------------------------------ */

async function createSession(db: D1Database, userId: string) {
  const raw = newToken();
  await db
    .prepare(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    )
    .bind(await sha256(raw), userId, Date.now() + SESSION_TTL_SECONDS * 1000)
    .run();
  return raw;
}

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

const onError = (err: unknown, c: any) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Internal error";
  return c.json({ error: message }, { status });
};
app.onError(onError);

/** Defensive JSON-column parse: NULL or legacy "null" strings -> undefined. */
function parseJsonArray(col: unknown): any[] | undefined {
  if (typeof col !== "string" || !col) return undefined;
  try {
    const v = JSON.parse(col);
    return Array.isArray(v) && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

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
    categories: parseJsonArray(r.categories),
    year: r.year ?? undefined,
    rating: r.rating ?? undefined,
    kind: r.kind ?? undefined,
    qualities: parseJsonArray(r.qualities),
    subtitles: parseJsonArray(r.subtitles),
    episodes: parseJsonArray(r.episodes),
    dubs: parseJsonArray(r.dubs),
    seasons: parseJsonArray(r.seasons),
    order: r.sort_order ?? undefined,
    contributorId: r.contributor_id ?? undefined,
    /* External ids let the player rebuild Servers 1/3/4 for admin-created
       titles; the rest are per-movie embed overrides the inspector edits. */
    tmdbId: r.tmdb_id ?? undefined,
    imdbId: r.imdb_id ?? undefined,
    embedUrl: r.embed_url ?? undefined,
    disabledServers: parseJsonArray(r.disabled_servers),
    defaultServer: r.default_server ?? undefined,
    downloads: parseJsonArray(r.downloads),
    hidden: !!r.hidden,
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
/* password auth: register / login / forgot / reset (PBKDF2)            */
/* ------------------------------------------------------------------ */

const MIN_PASSWORD_LENGTH = 8;

app.post("/auth/register", async (c) => {
  const { email, password, name } = await c.req.json<{
    email: string; password: string; name?: string;
  }>();
  const mail = (email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
  }
  const existing = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(mail).first();
  if (existing) {
    throw new HttpError(409, "That email already has an account — sign in instead.");
  }
  const uid = id();
  const salt = newSalt();
  const hash = await hashPassword(password, salt);
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, role, is_anonymous, created_at, password_hash, password_salt)
     VALUES (?, ?, ?, NULL, 0, ?, ?, ?)`,
  ).bind(uid, mail, (name ?? "").trim() || mail.split("@")[0], Date.now(), hash, salt).run();
  const raw = await createSession(c.env.DB, uid);
  return c.json({ token: raw, userId: uid });
});

app.post("/auth/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const mail = (email ?? "").trim().toLowerCase();
  const row = await c.env.DB.prepare(
    `SELECT id, password_hash, is_anonymous FROM users WHERE email = ?`,
  ).bind(mail).first<{ id: string; password_hash: string | null; is_anonymous: number }>();
  if (!row || !(await verifyPassword(password ?? "", row.password_hash))) {
    throw new HttpError(401, "Incorrect email or password.");
  }
  // Retired guest accounts that set a password become real members.
  if (row.is_anonymous) {
    await c.env.DB.prepare(`UPDATE users SET is_anonymous = 0, email = ? WHERE id = ?`)
      .bind(mail, row.id).run();
  }
  const raw = await createSession(c.env.DB, row.id);
  return c.json({ token: raw, userId: row.id });
});

/** Forgotten password: mail a 6-digit reset code (same otp_codes table). */
app.post("/auth/forgot", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  const mail = (email ?? "").trim().toLowerCase();
  const row = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(mail).first();
  // Same response whether or not the account exists (no account enumeration).
  if (row) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Date.now() + 15 * 60_000;
    await c.env.DB.prepare(
      `INSERT INTO otp_codes (email, code, expires_at, used) VALUES (?, ?, ?, 0)`,
    ).bind(mail, code, expires).run();
    await sendOtpEmail(c.env, mail, code);
  }
  return c.json({ sent: true });
});

/** Reset: verify the emailed code, then set the new password. */
app.post("/auth/reset", async (c) => {
  const { email, code, password } = await c.req.json<{
    email: string; code: string; password: string;
  }>();
  const mail = (email ?? "").trim().toLowerCase();
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const row = await c.env.DB.prepare(
    `SELECT rowid, code, expires_at, used FROM otp_codes
     WHERE email = ? AND used = 0 ORDER BY rowid DESC LIMIT 1`,
  ).bind(mail).first<any>();
  if (!row || row.code !== (code ?? "").trim() || row.expires_at < Date.now()) {
    throw new HttpError(400, "That code isn't right. Check the email and try again.");
  }
  await c.env.DB.prepare(`UPDATE otp_codes SET used = 1 WHERE rowid = ?`).bind(row.rowid).run();
  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(mail).first<{ id: string }>();
  if (!user) throw new HttpError(404, "We couldn't find an account with that email address.");
  const salt = newSalt();
  const hash = await hashPassword(password, salt);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, is_anonymous = 0 WHERE id = ?`,
  ).bind(hash, salt, user.id).run();
  const raw = await createSession(c.env.DB, user.id);
  return c.json({ token: raw, userId: user.id });
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
  /* Admins see everything; the public catalog omits titles the inspector has
     unpublished (hidden = 1). */
  const me = await userForToken(c.env.DB, c.req.header("Authorization"));
  const sql = me?.role === "admin"
    ? `SELECT * FROM movies ORDER BY COALESCE(sort_order, 999999), created_at`
    : `SELECT * FROM movies WHERE hidden = 0 ORDER BY COALESCE(sort_order, 999999), created_at`;
  const { results } = await c.env.DB.prepare(sql).all();
  return c.json((results ?? []).map(movieOut));
});

app.get("/movies/:mid", async (c) => {
  const row = await getMovieRow(c.env.DB, c.req.param("mid"));
  if (!row) throw new HttpError(404, "Movie not found");
  return c.json(movieOut(row));
});

function normalizeCategories(input: { category?: string; categories?: string[] }): string[] {
  return [...new Set(
    [...(input.categories ?? []), input.category ?? ""]
      .map((s) => (s ?? "").trim())
      .filter(Boolean),
  )];
}

/** JSON columns must hold real JSON arrays or SQL NULL — never the string
 *  "null" (which JSON.parse turns into a non-iterable null). */
function toJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return null;
  return v.length > 0 ? JSON.stringify(v) : null;
}

app.post("/movies", async (c) => {
  const admin = await requireAdmin(c);
  const body = await c.req.json<any>();
  const names = normalizeCategories(body);
  const mid = id();
  const order = body.order ?? (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM movies`).first<any>()).n;
  await c.env.DB.prepare(
    `INSERT INTO movies (id, title, description, poster_url, backdrop_url, video_url,
       genre, category, categories, year, rating, kind, qualities, subtitles,
       episodes, dubs, seasons, tmdb_id, imdb_id, embed_url, disabled_servers,
       default_server, downloads, hidden, sort_order, contributor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    mid, body.title ?? "Untitled", body.description ?? null,
    body.posterUrl ?? null, body.backdropUrl ?? null, body.videoUrl ?? null,
    body.genre ?? null, names[0] ?? null, names.length ? JSON.stringify(names) : null,
    body.year ?? null, body.rating ?? null, body.kind ?? null,
    toJson(body.qualities),
    toJson(body.subtitles),
    toJson(body.episodes),
    toJson(body.dubs),
    toJson(body.seasons),
    body.tmdbId ?? null, body.imdbId ?? null, body.embedUrl ?? null,
    toJson(body.disabledServers), body.defaultServer ?? null,
    toJson(body.downloads), body.hidden ? 1 : 0,
    order, admin.id, Date.now(),
  ).run();
  return c.json({ id: mid });
});

app.patch("/movies/:mid", async (c) => {
  await requireAdmin(c);
  const body = await c.req.json<any>();
  const row = await getMovieRow(c.env.DB, c.req.param("mid"));
  if (!row) throw new HttpError(404, "Movie not found");

  /* Reorder actions carry only their own key, so handle and return before the
     field loop. moveToTop drops the title below the current minimum; move
     swaps sort_order with the on-screen neighbour. */
  if (body.toTop) {
    const m = await c.env.DB.prepare(
      `SELECT COALESCE(MIN(COALESCE(sort_order, 999999)), 0) AS m FROM movies`,
    ).first<any>();
    await c.env.DB.prepare(`UPDATE movies SET sort_order = ? WHERE id = ?`)
      .bind((m?.m ?? 0) - 1, row.id).run();
    return c.json({ id: row.id, moved: true });
  }
  if (body.move === "up" || body.move === "down") {
    const { results } = await c.env.DB.prepare(
      `SELECT id, COALESCE(sort_order, 999999) AS so FROM movies
       ORDER BY COALESCE(sort_order, 999999), created_at`,
    ).all<any>();
    const list = results ?? [];
    const i = list.findIndex((x: any) => x.id === row.id);
    const j = body.move === "up" ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < list.length) {
      await c.env.DB.prepare(`UPDATE movies SET sort_order = ? WHERE id = ?`)
        .bind(list[j].so, list[i].id).run();
      await c.env.DB.prepare(`UPDATE movies SET sort_order = ? WHERE id = ?`)
        .bind(list[i].so, list[j].id).run();
    }
    return c.json({ id: row.id, moved: true });
  }

  const names = normalizeCategories(body);
  const sets: string[] = [];
  const binds: any[] = [];
  /* Only touch columns the caller actually sent. A PATCH body with just
     {title} used to null out description/poster/video/order because the old
     helper read `body.x ?? null` for keys that were never present — checking
     `key in body` keeps a partial update genuinely partial. */
  const scalar = (key: string, colName: string) => {
    if (!(key in body)) return;
    sets.push(`${colName} = ?`);
    binds.push(body[key] ?? null);
  };
  const jsonCol = (key: string, colName: string) => {
    if (!(key in body)) return;
    sets.push(`${colName} = ?`);
    binds.push(toJson(body[key]));
  };
  scalar("title", "title");
  scalar("description", "description");
  scalar("posterUrl", "poster_url");
  scalar("backdropUrl", "backdrop_url");
  scalar("videoUrl", "video_url");
  scalar("genre", "genre");
  scalar("year", "year");
  scalar("rating", "rating");
  scalar("kind", "kind");
  scalar("order", "sort_order");
  scalar("tmdbId", "tmdb_id");
  scalar("imdbId", "imdb_id");
  scalar("embedUrl", "embed_url");
  scalar("defaultServer", "default_server");
  jsonCol("qualities", "qualities");
  jsonCol("subtitles", "subtitles");
  jsonCol("episodes", "episodes");
  jsonCol("dubs", "dubs");
  jsonCol("seasons", "seasons");
  jsonCol("disabledServers", "disabled_servers");
  jsonCol("downloads", "downloads");
  if ("hidden" in body) {
    sets.push("hidden = ?");
    binds.push(body.hidden ? 1 : 0);
  }
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
    const names: string[] = parseJsonArray(r.categories) ?? [];
    if (!names.includes(trimmed)) continue;
    const rest = names.filter((n) => n !== trimmed);
    await c.env.DB.prepare(`UPDATE movies SET categories = ?, category = ? WHERE id = ?`)
      .bind(rest.length ? JSON.stringify(rest) : null, rest[0] ?? null, r.id).run();
    changed++;
  }
  return c.json({ changed });
});

/* ------------------------------------------------------------------ */
/* admin movie inspector: full read + live link probe                 */
/* ------------------------------------------------------------------ */

/** Everything the inspector shows for one title: the full doc, engagement
 *  roll-ups, recent dub jobs, and which embed servers its current ids unlock. */
app.get("/movies/:mid/inspect", async (c) => {
  await requireAdmin(c);
  const row = await getMovieRow(c.env.DB, c.req.param("mid"));
  if (!row) throw new HttpError(404, "Movie not found");
  const m = movieOut(row);
  const db = c.env.DB;
  const count = (sql: string) => db.prepare(sql).bind(row.id).first<any>();
  const [comments, watchlist, screenings, views, dubs] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM comments WHERE movie_id = ?`),
    count(`SELECT COUNT(*) AS n FROM watchlist WHERE movie_id = ?`),
    count(`SELECT COUNT(*) AS n FROM screenings WHERE movie_id = ?`),
    count(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM page_views WHERE movie_id = ?`),
    db.prepare(
      `SELECT id, target_lang, status, created_at FROM dub_jobs WHERE movie_id = ?
       ORDER BY created_at DESC LIMIT 10`,
    ).bind(row.id).all(),
  ]);
  return c.json({
    movie: m,
    engagement: {
      comments: comments?.n ?? 0,
      watchlist: watchlist?.n ?? 0,
      screenings: screenings?.n ?? 0,
      views: views?.n ?? 0,
      lastViewed: views?.last ?? null,
    },
    dubJobs: (dubs.results ?? []).map((r: any) => ({
      id: r.id, lang: r.target_lang, status: r.status, createdAt: r.created_at,
    })),
    /* Which player servers this title can currently reach, derived from the
       stored ids so the inspector's availability matrix matches the player. */
    servers: {
      vidbox: !!(m.tmdbId || m.embedUrl),
      vidapi: !!m.tmdbId,
      nxsha: !!m.tmdbId,
      anime: !!m.tmdbId,
      viduki: !!m.tmdbId,
      drama: !!m.tmdbId,
      original: !!m.videoUrl,
    },
  });
});

/** Probe every URL this title references (media + downloads + embeds) and
 *  mirror the outcome into link_health so the global panel sees it too. */
app.post("/movies/:mid/health", async (c) => {
  await requireAdmin(c);
  const row = await getMovieRow(c.env.DB, c.req.param("mid"));
  if (!row) throw new HttpError(404, "Movie not found");
  const m = movieOut(row);
  const urls: { label: string; url: string }[] = [];
  const push = (label: string, url?: string | null) => {
    if (url && /^https?:\/\//i.test(url)) urls.push({ label, url });
  };
  push("Poster", m.posterUrl);
  push("Backdrop", m.backdropUrl);
  push("Primary video", m.videoUrl);
  push("Embed page", m.embedUrl);
  for (const q of m.qualities ?? []) push(`Quality ${q?.label ?? ""}`, q?.videoUrl);
  for (const d of m.dubs ?? []) push(`Dub ${d?.label ?? ""}`, d?.videoUrl);
  for (const ep of m.episodes ?? []) push(`Episode ${ep?.title ?? ""}`, ep?.videoUrl);
  for (const dl of m.downloads ?? []) push(`Download ${dl?.label ?? ""}`, dl?.url);

  const results = await Promise.all(urls.map(async ({ label, url }) => {
    const probe = await probeUrl(url);
    await c.env.DB.prepare(
      `INSERT INTO link_health (url, status, http_status, error, checked_at, targets)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET status = excluded.status,
         http_status = excluded.http_status, error = excluded.error,
         checked_at = excluded.checked_at, targets = excluded.targets`,
    ).bind(url, probe.status, probe.httpStatus ?? null, probe.error ?? null,
      Date.now(), JSON.stringify([{ kind: "movie", name: label, movieId: row.id }])).run();
    return { label, url, ok: probe.status === "ok", status: probe.httpStatus ?? null, error: probe.error ?? null };
  }));

  return c.json({
    movieId: row.id,
    checked: results.length,
    failed: results.filter((r) => !r.ok).length,
    checkedAt: Date.now(),
    results,
  });
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
    const names: string[] = parseJsonArray(r.categories) ?? [];
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
    backupUrls: parseJsonArray(r.backup_urls),
    categories: parseJsonArray(r.categories),
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
    toJson(b.backupUrls),
    toJson(b.categories),
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
    toJson(b.backupUrls),
    toJson(b.categories),
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

  const orders = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(amount_cents), 0) AS revenue_cents,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS paid
       FROM orders`,
  ).first<{ total: number; revenue_cents: number; paid: number }>();
  const newCustomers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`,
  ).bind(last30Start).first<{ n: number }>();

  return c.json({
    total: views.length,
    today: views.filter((v: any) => v.created_at >= todayStart).length,
    last7: views.filter((v: any) => v.created_at >= last7Start).length,
    last30: views.filter((v: any) => v.created_at >= last30Start).length,
    visitors7: signedIn7.size + anon7,
    business: {
      totalOrders: orders?.total ?? 0,
      totalRevenue: (orders?.revenue_cents ?? 0) / 100,
      sales: orders?.paid ?? 0,
      newCustomers: newCustomers?.n ?? 0,
    },
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
  if (!user || user.role !== "admin") {
    return c.json({ failures: [], ignoredFailures: [], trackedCount: 0, lastCheckedAt: null });
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM link_health WHERE status = 'fail' ORDER BY url`,
  ).all();
  const tracked = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM link_health`).first<any>();
  const last = await c.env.DB.prepare(`SELECT MAX(checked_at) AS t FROM link_health`).first<any>();
  return c.json({
    failures: (results ?? []).map((r: any) => ({
      url: r.url, httpStatus: r.http_status, error: r.error, checkedAt: r.checked_at,
      targets: JSON.parse(r.targets),
    })),
    /* Ignoring a report needs an `ignored` column that this table never grew,
       so the list is always empty — the panel reads the key unconditionally. */
    ignoredFailures: [],
    trackedCount: tracked?.n ?? 0,
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
/* vidsrc (IMDb title search for the Landing "Server 1" flow)          */
/* ------------------------------------------------------------------ */

app.route("/vidsrc", vidsrcRoutes);

/* ------------------------------------------------------------------ */
/* tmdb browse (IMDB-wide catalog grid: "All Movies" + Load More)      */
/* ------------------------------------------------------------------ */

app.route("/tmdb", tmdbRoutes);

/* ------------------------------------------------------------------ */
/* embed → m3u8 resolver (Server 3: play provider streams ad-free)     */
/* ------------------------------------------------------------------ */

app.route("/embed", embedResolveRoutes);

/* ------------------------------------------------------------------ */
/* help-center chat + tv category chips                                */
/* ------------------------------------------------------------------ */

app.route("/support", supportRoutes);
app.route("/tv/categories", tvCategoryRoutes);
app.route("/app/builds", appBuildRoutes);
app.route("/uploads", uploadRoutes);

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
