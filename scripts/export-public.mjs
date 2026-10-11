#!/usr/bin/env node
/**
 * Convex → D1 data export without Convex CLI credentials.
 *
 * `npx convex export` needs a logged-in CLI, but the catalog tables are exposed
 * as public Convex queries, so anything reaching the browser can be exported
 * here over plain HTTPS. It writes the same layout as a Convex snapshot export,
 * so the existing importer picks it up unchanged:
 *
 *   1. node scripts/export-public.mjs        (writes scripts/export/<table>/documents.jsonl)
 *   2. node scripts/import-d1.mjs            (dry-run: generates SQL)
 *      node scripts/import-d1.mjs --apply    (pushes to the remote D1)
 *
 * Tables needing an identity or the admin role (users, sessions, otp_codes,
 * orders, watchlist, screenings, shortlinks, link_health, dub_jobs, page_views)
 * are NOT reachable anonymously — use `npx convex export` for those.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPORT = path.join(here, "export");

/** VITE_CONVEX_URL from .env.production, so we never hit the local dev backend. */
function productionConvexUrl() {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
  const file = path.join(here, "..", ".env.production");
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("VITE_CONVEX_URL="));
  if (!line) throw new Error("VITE_CONVEX_URL not found in .env.production");
  return line.slice("VITE_CONVEX_URL=".length).trim().replace(/\/$/, "");
}

const BASE = productionConvexUrl();

async function query(fnPath, args = {}) {
  const res = await fetch(`${BASE}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.status !== "success") {
    const why = data?.errorMessage?.trim().split("\n").pop() ?? `HTTP ${res.status}`;
    throw new Error(`${fnPath}: ${why}`);
  }
  return data.value;
}

/** Writes <table>/documents.jsonl exactly like a Convex snapshot export. */
function write(table, docs) {
  const dir = path.join(EXPORT, table);
  fs.mkdirSync(dir, { recursive: true });
  const body = docs.map((d) => JSON.stringify(d)).join("\n");
  fs.writeFileSync(path.join(dir, "documents.jsonl"), docs.length ? `${body}\n` : "");
  console.log(`  ${table}: ${docs.length} rows`);
}

const movies = await query("movies:list");
const categories = await query("categories:listAll");
const tvChannels = await query("tvChannels:list");

console.log(`exporting from ${BASE}`);
write("movies", movies);
write("categories", categories);
write("tvChannels", tvChannels);

/* Comments are only readable per movie (the full list is admin-only), so walk
   the catalog and tag each row with the movie it belongs to. */
const comments = [];
let skippedMovies = 0;
for (const m of movies) {
  try {
    const rows = await query("comments:listByMovie", { movieId: m._id });
    for (const c of rows) comments.push({ ...c, movieId: m._id });
  } catch {
    skippedMovies += 1;
  }
}
write("comments", comments);
if (skippedMovies) console.log(`  (comments skipped for ${skippedMovies} movie(s))`);

console.log(`\nwrote ${path.relative(path.join(here, ".."), EXPORT)}/ — now run: node scripts/import-d1.mjs`);
