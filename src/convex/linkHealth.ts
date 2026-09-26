import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/** Everything that references a media URL, so a broken URL can be traced
 *  back to the exact movie / TV channel in the admin notification. */
interface Target {
  kind: "movie" | "tv";
  name: string;
  movieId?: Id<"movies">;
  channelId?: Id<"tvChannels">;
}

interface MovieRow {
  _id: Id<"movies">;
  title: string;
  videoUrl?: string;
  qualities?: { label: string; videoUrl: string }[];
  dubs?: { label: string; videoUrl: string }[];
  episodes?: { title: string; videoUrl: string }[];
  seasons?: {
    id: Id<"movies">;
    title: string;
    episodes: { id: string; title: string; videoUrl: string }[];
  }[];
}

interface TvRow {
  _id: Id<"tvChannels">;
  name: string;
  streamUrl: string;
  backupUrls?: string[];
}

interface ProbeResult {
  status: "ok" | "fail";
  httpStatus?: number;
  error?: string;
}

const PROBE_TIMEOUT_MS = 8_000;
/** Parallel probes so a large catalog still finishes inside the action. */
const PROBE_CONCURRENCY = 8;

async function requireAdmin(ctx: unknown) {
  const userId = await getAuthUserId(ctx as never);
  if (userId === null) throw new Error("Not authenticated");
  const me = await (
    ctx as { db: { get(id: unknown): Promise<{ role?: string } | null> } }
  ).db.get(userId);
  if (me?.role !== "admin") throw new Error("Admin access required");
  return userId;
}

/** One URL must be checked by exactly one row — fan the targets in. */
function addTarget(map: Map<string, Target[]>, url: string, target: Target): void {
  const key = url.trim();
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(target);
  map.set(key, list);
}

/** Build url -> targets from movies + TV channels. One probe per unique URL. */
export const collectTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const map = new Map<string, Target[]>();

    for (const m of (await ctx.db.query("movies").collect()) as unknown as MovieRow[]) {
      const t: Target = { kind: "movie", name: m.title, movieId: m._id };
      if (m.videoUrl) addTarget(map, m.videoUrl, t);
      for (const q of m.qualities ?? []) addTarget(map, q.videoUrl, t);
      for (const d of m.dubs ?? []) addTarget(map, d.videoUrl, t);
      for (const e of m.episodes ?? []) addTarget(map, e.videoUrl, t);
      for (const s of m.seasons ?? [])
        for (const e of s.episodes ?? []) addTarget(map, e.videoUrl, t);
    }

    for (const c of (await ctx.db.query("tvChannels").collect()) as unknown as TvRow[]) {
      addTarget(map, c.streamUrl, { kind: "tv", name: c.name, channelId: c._id });
      for (const b of c.backupUrls ?? [])
        addTarget(map, b, { kind: "tv", name: c.name, channelId: c._id });
    }

    return [...map.entries()].map(([url, targets]) => ({ url, targets }));
  },
});

/** HEAD first (cheap); fall back to a ranged GET when HEAD is rejected
 *  (405/501) or forbidden (403). A 4xx/5xx response still proves the server
 *  is alive only for the fallback cases — everything else counts as failure. */
async function probeUrl(url: string): Promise<ProbeResult> {
  try {
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "FilmFlixLinkCheck/1.0" },
    });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { "user-agent": "FilmFlixLinkCheck/1.0", range: "bytes=0-1" },
      });
    }
    if (res.ok) return { status: "ok", httpStatus: res.status };
    return { status: "fail", httpStatus: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      status: "fail",
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

/** Upsert the probe result (preserves the admin's ignored flag). */
export const saveResult = internalMutation({
  args: {
    url: v.string(),
    status: v.union(v.literal("ok"), v.literal("fail")),
    httpStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    targets: v.array(
      v.object({
        kind: v.union(v.literal("movie"), v.literal("tv")),
        name: v.string(),
        movieId: v.optional(v.id("movies")),
        channelId: v.optional(v.id("tvChannels")),
      }),
    ),
  },
  handler: async (ctx, { url, status, httpStatus, error, targets }) => {
    const existing = await ctx.db
      .query("linkHealth")
      .withIndex("by_url", (q) => q.eq("url", url))
      .unique();
    const row = { status, httpStatus, error, checkedAt: Date.now(), targets };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("linkHealth", { url, ...row });
  },
});

/** Admin toggles the ignored flag on one URL. */
export const setIgnored = mutation({
  args: { url: v.string(), ignored: v.boolean() },
  handler: async (ctx, { url, ignored }) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("linkHealth")
      .withIndex("by_url", (q) => q.eq("url", url))
      .unique();
    if (!row) throw new Error("URL not tracked yet — run a check first");
    await ctx.db.patch(row._id, { ignored });
  },
});

/** Remove rows whose URL vanished from the catalog (movie deleted, etc.). */
export const pruneMissing = internalMutation({
  args: { knownUrls: v.array(v.string()) },
  handler: async (ctx, { knownUrls }) => {
    const known = new Set(knownUrls);
    let removed = 0;
    for (const row of await ctx.db.query("linkHealth").collect()) {
      if (!known.has(row.url)) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return removed;
  },
});

/** Shared pipeline: collect → probe (bounded parallelism) → save → prune. */
async function runCheck(ctx: {
  runQuery: (ref: unknown, args: object) => Promise<
    { url: string; targets: Target[] }[]
  >;
  runMutation: (ref: unknown, args: object) => Promise<unknown>;
}) {
  const targets = await ctx.runQuery(internal.linkHealth.collectTargets, {});

  let failed = 0;
  const queue = [...targets];
  const workers = Array.from({ length: PROBE_CONCURRENCY }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const res = await probeUrl(item.url);
      if (res.status === "fail") failed++;
      await ctx.runMutation(internal.linkHealth.saveResult, {
        url: item.url,
        ...res,
        targets: item.targets,
      });
    }
  });
  await Promise.all(workers);

  await ctx.runMutation(internal.linkHealth.pruneMissing, {
    knownUrls: targets.map((t) => t.url),
  });
  return { checked: targets.length, failed };
}

/** Manual "Check all links now" button in the admin panel (runs live probes). */
export const checkAll = action({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await runCheck(ctx as never);
  },
});

/** Cron entry (every 6 hours via crons.ts) — same pipeline, no admin gate. */
export const checkAllCron = internalAction({
  args: {},
  handler: async (ctx) => {
    const res = await runCheck(ctx as never);
    if (res.failed > 0) console.log(`linkHealth: ${res.failed}/${res.checked} URLs failing`);
    return res;
  },
});

/** Admin banner data: every currently-failing URL and when we last checked. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const me = await ctx.db.get(userId);
    if (me?.role !== "admin") return null;

    const failing = await ctx.db
      .query("linkHealth")
      .withIndex("by_status", (q) => q.eq("status", "fail"))
      .collect();

    let lastCheckedAt = 0;
    let tracked = 0;
    for (const r of await ctx.db.query("linkHealth").collect()) {
      if (r.checkedAt > lastCheckedAt) lastCheckedAt = r.checkedAt;
      tracked++;
    }

    const toFailure = (r: (typeof failing)[number]) => ({
      url: r.url,
      httpStatus: r.httpStatus,
      error: r.error,
      checkedAt: r.checkedAt,
      ignored: r.ignored ?? false,
      targets: r.targets.map((t) => ({
        kind: t.kind,
        name: t.name,
        movieId: t.movieId,
        channelId: t.channelId,
      })),
    });

    const active = failing.filter((r) => !r.ignored);
    const ignored = failing
      .filter((r) => r.ignored)
      .sort((a, b) => a.url.localeCompare(b.url));

    return {
      failures: active
        .sort((a, b) => a.url.localeCompare(b.url))
        .map(toFailure),
      ignoredFailures: ignored.map(toFailure),
      trackedCount: tracked,
      lastCheckedAt: lastCheckedAt || null,
    };
  },
});