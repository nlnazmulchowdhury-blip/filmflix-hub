#!/usr/bin/env node
/**
 * Convex → Cloudflare D1 import.
 *
 * Usage:
 *   1. npx convex export --path scripts/data-export.zip
 *   2. cd scripts && unzip -o data-export.zip -d export
 *   3. node import-d1.mjs            (dry-run by default: writes SQL, no apply)
 *      node import-d1.mjs --apply    (pushes to the remote D1 via wrangler)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPORT = path.join(here, "export");
const APPLY = process.argv.includes("--apply");

const readJsonl = (table) => {
  const file = path.join(EXPORT, table, "documents.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

/** SQL literal with minimal escaping. */
const q = (v) => {
  if (v === undefined || v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
};
const j = (v) => (v === undefined ? null : JSON.stringify(v));

const stmts = [];
const push = (sql) => stmts.push(sql.replace(/\s+/g, " ").trim());

/* ---------------- users ---------------- */
for (const u of readJsonl("users")) {
  push(
    `INSERT OR REPLACE INTO users (id, email, name, role, is_anonymous, created_at)
     VALUES (${q(u._id)}, ${q(u.email ?? null)}, ${q(u.name ?? null)}, ${q(u.role ?? null)}, ${u.isAnonymous ? 1 : 0}, ${Math.round(u._creationTime)})`,
  );
}

/* ---------------- categories ---------------- */
for (const c of readJsonl("categories")) {
  push(
    `INSERT OR REPLACE INTO categories (id, name, created_at)
     VALUES (${q(c._id)}, ${q(c.name)}, ${Math.round(c.createdAt)})`,
  );
}

/* ---------------- movies ---------------- */
for (const m of readJsonl("movies")) {
  push(
    `INSERT OR REPLACE INTO movies (id, title, description, poster_url, backdrop_url, video_url,
       genre, category, categories, year, rating, kind, qualities, subtitles, episodes, dubs, seasons, sort_order, created_at)
     VALUES (
       ${q(m._id)}, ${q(m.title)}, ${q(m.description ?? null)}, ${q(m.posterUrl ?? null)},
       ${q(m.backdropUrl ?? null)}, ${q(m.videoUrl ?? null)}, ${q(m.genre ?? null)},
       ${q(m.category ?? null)}, ${q(j(m.categories))}, ${q(m.year ?? null)}, ${q(m.rating ?? null)},
       ${q(m.kind ?? null)}, ${q(j(m.qualities))}, ${q(j(m.subtitles))}, ${q(j(m.episodes))},
       ${q(j(m.dubs))}, ${q(j(m.seasons))}, ${q(m.order ?? null)}, ${Math.round(m._creationTime)}
     )`,
  );
}

/* ---------------- tv channels ---------------- */
for (const t of readJsonl("tvChannels")) {
  push(
    `INSERT OR REPLACE INTO tv_channels (id, name, logo_url, stream_url, backup_urls, categories, sort_order, created_at)
     VALUES (
       ${q(t._id)}, ${q(t.name)}, ${q(t.logoUrl ?? null)}, ${q(t.streamUrl)},
       ${q(j(t.backupUrls))}, ${q(j(t.categories))}, ${q(t.order ?? null)}, ${Math.round(t.createdAt)}
     )`,
  );
}

/* ---------------- comments ---------------- */
for (const c of readJsonl("comments")) {
  push(
    `INSERT OR REPLACE INTO comments (id, movie_id, user_id, text, created_at)
     VALUES (${q(c._id)}, ${q(c.movieId)}, ${q(c.userId)}, ${q(c.text)}, ${Math.round(c.createdAt)})`,
  );
}

/* ---------------- screenings ---------------- */
for (const s of readJsonl("screenings")) {
  push(
    `INSERT OR REPLACE INTO screenings (id, movie_id, user_id, scheduled_for, note, created_at)
     VALUES (${q(s._id)}, ${q(s.movieId)}, ${q(s.userId)}, ${Math.round(s.scheduledFor)}, ${q(s.note ?? null)}, ${Math.round(s.createdAt)})`,
  );
}

/* ---------------- orders ---------------- */
for (const o of readJsonl("orders")) {
  push(
    `INSERT OR REPLACE INTO orders (id, user_id, plan, amount_cents, status, created_at, paid_at)
     VALUES (${q(o._id)}, ${q(o.userId)}, ${q(o.plan)}, ${Math.round(o.amountCents)}, ${q(o.status)}, ${Math.round(o.createdAt)}, ${o.paidAt ? Math.round(o.paidAt) : "NULL"})`,
  );
}

/* ---------------- watchlist ---------------- */
for (const w of readJsonl("watchlist")) {
  push(
    `INSERT OR IGNORE INTO watchlist (id, user_id, movie_id, created_at)
     VALUES (${q(w._id)}, ${q(w.userId)}, ${q(w.movieId)}, ${Math.round(w.createdAt)})`,
  );
}

/* ---------------- shortlinks cache ---------------- */
for (const s of readJsonl("shortlinks")) {
  push(
    `INSERT OR REPLACE INTO shortlinks (short_url, real_url, resolved_at)
     VALUES (${q(s.shortUrl)}, ${q(s.realUrl)}, ${Math.round(s.resolvedAt)})`,
  );
}

/* ---------------- dubJobs ---------------- */
for (const d of readJsonl("dubJobs")) {
  push(
    `INSERT OR REPLACE INTO dub_jobs (id, movie_id, movie_title, target_lang, status, dubbing_id, error, created_at, updated_at)
     VALUES (${q(d._id)}, ${q(d.movieId)}, ${q(d.movieTitle)}, ${q(d.targetLang)}, ${q(d.status)}, ${q(d.dubbingId ?? null)}, ${q(d.error ?? null)}, ${Math.round(d.createdAt)}, ${Math.round(d.updatedAt)})`,
  );
}

/* ---------------- linkHealth ---------------- */
for (const l of readJsonl("linkHealth")) {
  push(
    `INSERT OR REPLACE INTO link_health (url, status, http_status, error, checked_at, targets)
     VALUES (${q(l.url)}, ${q(l.status)}, ${q(l.httpStatus ?? null)}, ${q(l.error ?? null)}, ${Math.round(l.checkedAt)}, ${q(j(l.targets))})`,
  );
}

/* ---------------- pageViews (large: bulk insert) ---------------- */
for (const v of readJsonl("pageViews")) {
  push(
    `INSERT INTO page_views (id, path, movie_id, user_id, referrer, device, created_at)
     VALUES (${q(v._id)}, ${q(v.path)}, ${q(v.movieId ?? null)}, ${q(v.userId ?? null)}, ${q(v.referrer ?? null)}, ${q(v.device ?? null)}, ${Math.round(v.createdAt)})`,
  );
}

// NOTE: no BEGIN/COMMIT — D1 remote execution rejects explicit transactions.
// Each statement runs atomically on its own; re-runs are safe (INSERT OR REPLACE).
const sqlText =
  `-- Generated by scripts/import-d1.mjs from Convex snapshot export\n` +
  stmts.join(";\n") +
  `;\n`;

fs.writeFileSync(path.join(here, "d1-import.sql"), sqlText);
console.log(`statements: ${stmts.length}`);
console.log(`SQL written to scripts/d1-import.sql (${(sqlText.length / 1024).toFixed(1)} KiB)`);

if (APPLY) {
  console.log("Applying to remote D1 …");
  execSync(
    "npx wrangler d1 execute filmflix-hub --remote --file=./d1-import.sql -y",
    { cwd: path.join(here, "..", "worker"), stdio: "inherit" },
  );
  console.log("Done.");
} else {
  console.log("Dry run — re-run with --apply to push to the remote database.");
}