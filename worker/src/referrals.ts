/**
 * Referral earnings.
 *
 * One referred visitor = one row in `referral_visits` (deduped per IP per 24 h,
 * never the referrer's own click). HilltopAds only ever reports a single
 * site-wide revenue figure, so the nightly job divides that pool across the
 * day's referred visits and pays each referrer their share of the visits they
 * brought. Nobody is paid from the owner's pocket: the pot is always what the
 * ad network actually earned that day, multiplied by the share percentage.
 *
 * The tables are created on first use because the live D1 database predates
 * this feature and `schema.sql` is applied by hand, never on deploy.
 */

import { Hono } from "hono";
import {
  HttpError,
  requireAdmin,
  requireUser,
  userForToken,
  type Bindings,
  type Env,
} from "./index";

const DAY_MS = 86_400_000;
/** Asia/Dhaka is UTC+6 all year — no DST, so a fixed offset is exact. */
const DHAKA_OFFSET_MS = 6 * 60 * 60_000;
const VISIT_DEDUPE_MS = DAY_MS;
const DEFAULT_SHARE_PCT = 50;
/** Placeholder until HILLTOP_API_KEY/HILLTOP_API_URL are set on the Worker. */
const DEFAULT_DAILY_EARNING = 10;
const CODE_LENGTH = 8;
/** No 0/O/1/I — a code gets typed by hand and pasted into chats. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ------------------------------------------------------------------ */
/* dates (all earning days are Asia/Dhaka calendar days)               */
/* ------------------------------------------------------------------ */

/** `YYYY-MM-DD` for the Dhaka calendar day a timestamp falls in. */
export function dhakaDate(ts: number): string {
  return new Date(ts + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

export function todayDhaka(): string {
  return dhakaDate(Date.now());
}

/** First millisecond of a Dhaka day, as a UTC timestamp. */
export function dhakaDayStart(date: string): number {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(midnightUtc)) throw new HttpError(400, "Date must be YYYY-MM-DD");
  return midnightUtc - DHAKA_OFFSET_MS;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/* ------------------------------------------------------------------ */
/* schema bootstrap                                                    */
/* ------------------------------------------------------------------ */

let schemaReady: Promise<void> | null = null;

function ensureReferralSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS referral_visits (
           id          TEXT PRIMARY KEY,
           referrer_id TEXT NOT NULL,
           visitor_ip  TEXT NOT NULL,
           movie_id    TEXT,
           created_at  INTEGER NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS idx_ref_visits_ref ON referral_visits(referrer_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_ref_visits_ip ON referral_visits(referrer_id, visitor_ip, created_at)`,
        `CREATE TABLE IF NOT EXISTS daily_earnings (
           id                     TEXT PRIMARY KEY,
           date                   TEXT NOT NULL UNIQUE,
           total_hilltop_earning  REAL NOT NULL DEFAULT 0,
           total_visits           INTEGER NOT NULL DEFAULT 0,
           source                 TEXT,
           settled_at             INTEGER NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS referral_earnings (
           id          TEXT PRIMARY KEY,
           referrer_id TEXT NOT NULL,
           date        TEXT NOT NULL,
           visits      INTEGER NOT NULL DEFAULT 0,
           amount      REAL NOT NULL DEFAULT 0,
           paid_at     INTEGER NOT NULL,
           UNIQUE(referrer_id, date)
         )`,
        `CREATE INDEX IF NOT EXISTS idx_ref_earn_ref ON referral_earnings(referrer_id, date)`,
      ];
      for (const sql of ddl) await db.prepare(sql).run();

      /* users gained four columns after the table already existed in
         production. D1 has no "ADD COLUMN IF NOT EXISTS", and re-running the
         whole bootstrap is the normal case after a cold start, so a duplicate
         column error is expected and swallowed. */
      for (const col of [
        "referral_code TEXT",
        "balance REAL NOT NULL DEFAULT 0",
        "pending_balance REAL NOT NULL DEFAULT 0",
        "last_ip TEXT",
      ]) {
        try {
          await db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run();
        } catch {
          /* already present */
        }
      }
      await db
        .prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`)
        .run();
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** Await this before a route touches any referral table. */
function ready(c: any) {
  return ensureReferralSchema(c.env.DB);
}

/* ------------------------------------------------------------------ */
/* referral codes                                                      */
/* ------------------------------------------------------------------ */

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** The account's code, minted on first use for accounts that predate the
 *  feature. Collisions are retried against the unique index. */
export async function assignReferralCode(db: D1Database, userId: string): Promise<string> {
  /* Sign-up calls this before any referral route has run, so the columns have
     to exist by now, not on the first dashboard visit. */
  await ensureReferralSchema(db);
  const row = await db
    .prepare(`SELECT referral_code FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ referral_code: string | null }>();
  if (row?.referral_code) return row.referral_code;

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    try {
      await db.prepare(`UPDATE users SET referral_code = ? WHERE id = ?`).bind(code, userId).run();
      const check = await db
        .prepare(`SELECT referral_code FROM users WHERE id = ?`)
        .bind(userId)
        .first<{ referral_code: string | null }>();
      if (check?.referral_code === code) return code;
    } catch {
      /* unique-index collision — try another code */
    }
  }
  throw new HttpError(500, "Could not allocate a referral code");
}

/** Remember where the account signs in from — used to refuse self-clicks made
 *  from the same connection while signed out. */
export async function noteUserIp(db: D1Database, userId: string, ip: string | null) {
  if (!ip || ip === "unknown") return;
  try {
    await db.prepare(`UPDATE users SET last_ip = ? WHERE id = ?`).bind(ip, userId).run();
  } catch {
    /* column missing until the bootstrap runs — not worth failing a login */
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function ipOf(c: any): string {
  const h = c.req.header();
  const raw =
    h["cf-connecting-ip"] ||
    h["x-real-ip"] ||
    (h["x-forwarded-for"] ? h["x-forwarded-for"].split(",")[0] : "") ||
    "";
  return raw.trim().slice(0, 64) || "unknown";
}

function sharePct(env: Bindings): number {
  const n = Number((env as any).REFERRAL_SHARE_PCT);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : DEFAULT_SHARE_PCT;
}

/** The per-visit rate of the most recent settled day — what a pending click is
 *  worth right now, until tonight's settlement sets the real number. */
async function latestRate(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT total_hilltop_earning, total_visits FROM daily_earnings
       ORDER BY date DESC LIMIT 1`,
    )
    .first<{ total_hilltop_earning: number; total_visits: number }>();
  if (!row || !row.total_visits) return null;
  return row.total_hilltop_earning / row.total_visits;
}

/** pending_balance = what today's clicks are worth at the last known rate. */
async function refreshPending(db: D1Database, referrerId: string, pct: number) {
  const start = dhakaDayStart(todayDhaka());
  const today = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM referral_visits
       WHERE referrer_id = ? AND created_at >= ?`,
    )
    .bind(referrerId, start)
    .first<{ n: number }>();
  const rate = await latestRate(db);
  const pending = round6((today?.n ?? 0) * (rate ?? 0) * (pct / 100));
  await db
    .prepare(`UPDATE users SET pending_balance = ? WHERE id = ?`)
    .bind(pending, referrerId)
    .run();
}

/* ------------------------------------------------------------------ */
/* HilltopAds revenue                                                  */
/* ------------------------------------------------------------------ */

/** Publisher stats endpoint (API docs: GET /publisher/listStats). The key
 *  travels as a query parameter, not a header, and a bare `date` returns that
 *  single day's totals for every site on the account. */
const HILLTOP_STATS_URL = "https://api.hilltopads.com/publisher/listStats";

function statsUrl(env: Bindings, key: string, date: string): string {
  const configured = ((env as any).HILLTOP_API_URL as string | undefined)?.trim();
  if (!configured) {
    const u = new URL(HILLTOP_STATS_URL);
    u.searchParams.set("key", key);
    u.searchParams.set("date", date);
    return u.toString();
  }
  if (configured.includes("{key}") || configured.includes("{date}")) {
    return configured
      .replaceAll("{key}", encodeURIComponent(key))
      .replaceAll("{date}", date);
  }
  const u = new URL(configured);
  if (!u.searchParams.has("key")) u.searchParams.set("key", key);
  if (!u.searchParams.has("date")) u.searchParams.set("date", date);
  return u.toString();
}

const REVENUE_KEYS = [
  "revenue",
  "earnings",
  "earning",
  "total_revenue",
  "today_earning",
  "todayEarning",
  "amount",
  "total",
];

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** `listStats` groups rows by whatever `group=` asks for — a single day comes
 *  back as one row, but a geo/zone breakdown is several. Sum them, because the
 *  referrers are paid from the site's whole daily pot. */
function sumRevenue(node: unknown, depth = 0): number | null {
  if (!node || typeof node !== "object" || depth > 3) return null;
  if (Array.isArray(node)) {
    let total = 0;
    let found = false;
    for (const row of node) {
      const v = sumRevenue(row, depth + 1);
      if (v !== null) {
        total += v;
        found = true;
      }
    }
    return found ? total : null;
  }
  const obj = node as Record<string, unknown>;
  for (const k of REVENUE_KEYS) {
    const n = asNumber(obj[k]);
    if (n !== null) return n;
  }
  /* Date-keyed maps (`{"2026-10-29": {revenue: …}}`) and `{data: [...]}`
     wrappers both fall through to here. */
  let total = 0;
  let found = false;
  for (const v of Object.values(obj)) {
    const n = sumRevenue(v, depth + 1);
    if (n !== null) {
      total += n;
      found = true;
    }
  }
  return found ? total : null;
}

/**
 * Today's site-wide ad revenue. With HILLTOP_API_KEY set on the Worker this is
 * the account's real number for the day; without it the settlement still runs
 * end to end, it just splits the placeholder figure.
 */
export async function todaysEarnings(env: Bindings): Promise<{ amount: number; source: string }> {
  const fallback = (() => {
    const n = Number((env as any).HILLTOP_FALLBACK_EARNING);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_EARNING;
  })();
  const key = ((env as any).HILLTOP_API_KEY as string | undefined)?.trim();
  if (!key) return { amount: fallback, source: "placeholder (no api key)" };

  /* With a key configured the settlement must never fall back to the made-up
     figure: if HilltopAds is unreachable we'd credit money the account never
     earned. Paying nothing tonight is recoverable; overpaying is not. */
  try {
    const res = await fetch(statsUrl(env, key, todayDhaka()), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`hilltop: ${res.status} from revenue API — settling at 0`);
      return { amount: 0, source: `api-failed (${res.status})` };
    }
    const amount = sumRevenue(await res.json());
    if (amount === null) {
      console.warn("hilltop: no revenue field in response — settling at 0");
      return { amount: 0, source: "api-failed (unparsed)" };
    }
    return { amount: round6(amount), source: "hilltop-api" };
  } catch (err) {
    console.warn(`hilltop: ${err instanceof Error ? err.message : err} — settling at 0`);
    return { amount: 0, source: "api-failed (error)" };
  }
}

/* ------------------------------------------------------------------ */
/* settlement                                                          */
/* ------------------------------------------------------------------ */

export interface SettlementResult {
  date: string;
  visits: number;
  earnings: number;
  perVisit: number;
  sharePct: number;
  paid: number;
  referrers: number;
  source: string;
}

/**
 * Split one day's revenue across that day's referred visits and credit each
 * referrer. Re-running a day is safe: the ledger row keeps what was already
 * credited and only the delta is added, so a late visit at 23:59:30 is picked
 * up by the next run instead of being paid twice or lost.
 */
export async function settleDay(
  env: Bindings,
  date: string,
  overrideEarnings?: number,
): Promise<SettlementResult> {
  const db = env.DB;
  await ensureReferralSchema(db);

  const start = dhakaDayStart(date);
  const end = start + DAY_MS;
  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM referral_visits WHERE created_at >= ? AND created_at < ?`)
    .bind(start, end)
    .first<{ n: number }>();
  const visits = total?.n ?? 0;
  const pct = sharePct(env);

  if (visits === 0) {
    return { date, visits: 0, earnings: 0, perVisit: 0, sharePct: pct, paid: 0, referrers: 0, source: "no-visits" };
  }

  const { amount, source } =
    overrideEarnings != null && Number.isFinite(overrideEarnings)
      ? { amount: Math.max(0, overrideEarnings), source: "manual" }
      : await todaysEarnings(env);
  const perVisit = amount / visits;

  await db
    .prepare(
      `INSERT INTO daily_earnings (id, date, total_hilltop_earning, total_visits, source, settled_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total_hilltop_earning = excluded.total_hilltop_earning,
         total_visits = excluded.total_visits,
         source = excluded.source,
         settled_at = excluded.settled_at`,
    )
    .bind(crypto.randomUUID(), date, amount, visits, source, Date.now())
    .run();

  const { results } = await db
    .prepare(
      `SELECT referrer_id, COUNT(*) AS n FROM referral_visits
       WHERE created_at >= ? AND created_at < ? GROUP BY referrer_id`,
    )
    .bind(start, end)
    .all<{ referrer_id: string; n: number }>();

  let paid = 0;
  let referrers = 0;
  for (const row of results ?? []) {
    const earned = round6(row.n * perVisit * (pct / 100));
    const prev = await db
      .prepare(`SELECT amount FROM referral_earnings WHERE referrer_id = ? AND date = ?`)
      .bind(row.referrer_id, date)
      .first<{ amount: number }>();
    /* Only ever move money forward. A late click that lands after the 23:59
       run lowers the per-visit rate for that day; recomputing would then owe
       a referrer *less* than already credited, and taking money back out of a
       visible balance is never acceptable. The overshoot is bounded by the
       last minute of click traffic. */
    const delta = Math.max(0, round6(earned - (prev?.amount ?? 0)));
    const credited = round6(Math.max(prev?.amount ?? 0, earned));

    if (prev) {
      await db
        .prepare(
          `UPDATE referral_earnings SET visits = ?, amount = ?, paid_at = ?
           WHERE referrer_id = ? AND date = ?`,
        )
        .bind(row.n, credited, Date.now(), row.referrer_id, date)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO referral_earnings (id, referrer_id, date, visits, amount, paid_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), row.referrer_id, date, row.n, credited, Date.now())
        .run();
    }
    /* The day's clicks are now money: move them out of pending. A later visit
       for the same date re-adds its own estimate on the next click. */
    await db
      .prepare(
        `UPDATE users SET balance = ROUND(COALESCE(balance, 0) + ?, 6), pending_balance = 0
         WHERE id = ?`,
      )
      .bind(delta, row.referrer_id)
      .run();
    paid = round6(paid + delta);
    referrers++;
  }

  return { date, visits, earnings: amount, perVisit, sharePct: pct, paid, referrers, source };
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

export const referralRoutes = new Hono<Env>();

/** Everything the dashboard panel shows, in one call. */
referralRoutes.get("/me", async (c) => {
  await ready(c);
  const user = await requireUser(c);
  const db = c.env.DB;

  if (user.isAnonymous) {
    return c.json({
      enabled: false,
      code: null,
      sharePct: sharePct(c.env),
      todayVisits: 0,
      todayPending: 0,
      balance: 0,
      pendingBalance: 0,
      totalEarned: 0,
      lifetimeVisits: 0,
      lastSettled: null,
      days: [],
    });
  }

  const code = await assignReferralCode(db, user.id);
  const pct = sharePct(c.env);
  const today = todayDhaka();
  const todayStart = dhakaDayStart(today);

  /* Clicks already folded into tonight's (or an earlier) payout are no longer
     pending, so the "pending" counter starts after the last settlement. */
  const settledToday = await db
    .prepare(`SELECT settled_at FROM daily_earnings WHERE date = ?`)
    .bind(today)
    .first<{ settled_at: number }>();
  const pendingSince = Math.max(todayStart, settledToday?.settled_at ?? 0);

  const todayVisits = await db
    .prepare(`SELECT COUNT(*) AS n FROM referral_visits WHERE referrer_id = ? AND created_at >= ?`)
    .bind(user.id, pendingSince)
    .first<{ n: number }>();
  const lifetime = await db
    .prepare(`SELECT COUNT(*) AS n FROM referral_visits WHERE referrer_id = ?`)
    .bind(user.id)
    .first<{ n: number }>();
  const sums = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(visits), 0) AS visits
       FROM referral_earnings WHERE referrer_id = ?`,
    )
    .bind(user.id)
    .first<{ total: number; visits: number }>();
  const wallet = await db
    .prepare(`SELECT balance, pending_balance FROM users WHERE id = ?`)
    .bind(user.id)
    .first<{ balance: number | null; pending_balance: number | null }>();
  const rate = await latestRate(db);
  const lastDay = await db
    .prepare(
      `SELECT date, total_hilltop_earning, total_visits FROM daily_earnings
       ORDER BY date DESC LIMIT 1`,
    )
    .first<{ date: string; total_hilltop_earning: number; total_visits: number }>();
  const { results: ledger } = await db
    .prepare(
      `SELECT date, visits, amount FROM referral_earnings
       WHERE referrer_id = ? ORDER BY date DESC LIMIT 60`,
    )
    .bind(user.id)
    .all<{ date: string; visits: number; amount: number }>();

  const days = (ledger ?? []).map((r) => ({
    date: r.date,
    visits: r.visits,
    earned: r.amount,
    settled: true,
  }));
  const todayCount = todayVisits?.n ?? 0;
  /* One row per date: a settled day keeps its ledger row, and clicks that
     arrived after the 23:59 run only show in the pending counter. */
  if (todayCount > 0 && !days.some((d) => d.date === today)) {
    days.unshift({
      date: today,
      visits: todayCount,
      earned: round6(todayCount * (rate ?? 0) * (pct / 100)),
      settled: false,
    });
  }

  return c.json({
    enabled: true,
    code,
    sharePct: pct,
    todayVisits: todayCount,
    todayPending: round6(todayCount * (rate ?? 0) * (pct / 100)),
    balance: round6(wallet?.balance ?? 0),
    /* The stored column is refreshed on every click; this is the same number
       recomputed from today's visits, so a stale row can never show a wallet
       that disagrees with the card above it. */
    pendingBalance: round6(todayCount * (rate ?? 0) * (pct / 100)),
    totalEarned: round6(sums?.total ?? 0),
    lifetimeVisits: lifetime?.n ?? 0,
    lastSettled: lastDay
      ? {
          date: lastDay.date,
          earnings: lastDay.total_hilltop_earning,
          visits: lastDay.total_visits,
          perVisit: lastDay.total_visits ? lastDay.total_hilltop_earning / lastDay.total_visits : 0,
        }
      : null,
    days,
  });
});

/** A referred visitor opened the site. Meant to be cheap, idempotent per IP
 *  per 24 h, and safe to call on every page load. */
referralRoutes.post("/visit", async (c) => {
  await ready(c);
  const db = c.env.DB;
  const body = await c.req.json<{ code?: string; movieId?: string }>().catch(() => ({} as any));
  const cookieCode = /(?:^|;\s*)ref_by=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
  const raw = (body.code || cookieCode || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(raw)) return c.json({ counted: false, reason: "no-code" });

  const referrer = await db
    .prepare(`SELECT id, last_ip, is_anonymous FROM users WHERE referral_code = ?`)
    .bind(raw)
    .first<{ id: string; last_ip: string | null; is_anonymous: number }>();
  if (!referrer) return c.json({ counted: false, reason: "unknown-code" });
  if (referrer.is_anonymous) return c.json({ counted: false, reason: "ineligible-referrer" });

  const visitor = await userForToken(db, c.req.header("Authorization"));
  if (visitor && visitor.id === referrer.id) return c.json({ counted: false, reason: "self" });

  const ip = ipOf(c);
  if (ip !== "unknown" && referrer.last_ip && ip === referrer.last_ip) {
    return c.json({ counted: false, reason: "self-ip" });
  }

  /* A logged-out visitor on a shared connection is indistinguishable from the
     referrer, so 24 h dedupe is keyed on the referrer as well as the IP: the
     same person reloading the link twice adds nothing, and two referrers are
     not robbed of a click by each other's shared IP. */
  if (ip !== "unknown") {
    const dupe = await db
      .prepare(
        `SELECT id FROM referral_visits
         WHERE referrer_id = ? AND visitor_ip = ? AND created_at > ? LIMIT 1`,
      )
      .bind(referrer.id, ip, Date.now() - VISIT_DEDUPE_MS)
      .first();
    if (dupe) return c.json({ counted: false, reason: "duplicate-24h" });
  }

  const movieId = typeof body.movieId === "string" ? body.movieId.slice(0, 120) : null;
  await db
    .prepare(
      `INSERT INTO referral_visits (id, referrer_id, visitor_ip, movie_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), referrer.id, ip, movieId, Date.now())
    .run();
  await refreshPending(db, referrer.id, sharePct(c.env));

  return c.json({ counted: true });
});

/** Manual settlement — the nightly cron calls the same function. */
referralRoutes.post("/settle", async (c) => {
  await ready(c);
  await requireAdmin(c);
  const body = await c.req
    .json<{ date?: string; earnings?: number }>()
    .catch(() => ({} as any));
  const date = body.date ?? todayDhaka();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  const result = await settleDay(c.env, date, body.earnings);
  return c.json(result);
});
