import { Hono } from "hono";
import { requireAdmin, HttpError, type Env } from "./index";

/** TV category chips for the /tv page (same semantics as Convex tvCategories):
 *  chips exist with zero channels attached, renaming rewrites every channel
 *  that lists the old name, deleting strips the name from channels. */
export const tvCategoryRoutes = new Hono<Env>();

tvCategoryRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, created_at FROM tv_categories`,
  ).all<any>();
  return c.json(
    (results ?? [])
      .map((r) => ({ _id: r.id, name: r.name as string, createdAt: r.created_at as number }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});

tvCategoryRoutes.post("/", async (c) => {
  await requireAdmin(c);
  const { name } = await c.req.json<{ name: string }>();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Category name is required");
  if (trimmed.length > 60) throw new HttpError(400, "Category name is too long (max 60 characters)");
  const dupe = await c.env.DB.prepare(`SELECT id FROM tv_categories WHERE name = ?`)
    .bind(trimmed).first();
  if (dupe) throw new HttpError(409, `Category "${trimmed}" already exists`);
  await c.env.DB.prepare(`INSERT INTO tv_categories (id, name, created_at) VALUES (?, ?, ?)`)
    .bind(crypto.randomUUID(), trimmed, Date.now()).run();
  return c.json({ name: trimmed });
});

tvCategoryRoutes.patch("/:tid", async (c) => {
  await requireAdmin(c);
  const tid = c.req.param("tid");
  const { name } = await c.req.json<{ name: string }>();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new HttpError(400, "Category name is required");
  if (trimmed.length > 60) throw new HttpError(400, "Category name is too long (max 60 characters)");
  const row = await c.env.DB.prepare(`SELECT name FROM tv_categories WHERE id = ?`)
    .bind(tid).first<{ name: string }>();
  if (!row) throw new HttpError(404, "Category not found");
  if (row.name === trimmed) return c.json({ name: trimmed });
  const dupe = await c.env.DB.prepare(`SELECT id FROM tv_categories WHERE name = ?`)
    .bind(trimmed).first();
  if (dupe) throw new HttpError(409, `Category "${trimmed}" already exists`);

  await c.env.DB.prepare(`UPDATE tv_categories SET name = ? WHERE id = ?`)
    .bind(trimmed, tid).run();

  // Mirror the rename onto every channel that lists the old name.
  const { results } = await c.env.DB.prepare(`SELECT id, categories FROM tv_channels`).all<any>();
  for (const ch of results ?? []) {
    let cats: string[] = [];
    try { cats = JSON.parse(ch.categories ?? "[]"); } catch { cats = []; }
    if (!Array.isArray(cats) || !cats.includes(row.name)) continue;
    const next = [...new Set(cats.map((n) => (n === row.name ? trimmed : n)))];
    await c.env.DB.prepare(`UPDATE tv_channels SET categories = ? WHERE id = ?`)
      .bind(JSON.stringify(next), ch.id).run();
  }
  return c.json({ name: trimmed });
});

tvCategoryRoutes.delete("/:tid", async (c) => {
  await requireAdmin(c);
  const tid = c.req.param("tid");
  const row = await c.env.DB.prepare(`SELECT name FROM tv_categories WHERE id = ?`)
    .bind(tid).first<{ name: string }>();
  if (!row) throw new HttpError(404, "Category not found");
  await c.env.DB.prepare(`DELETE FROM tv_categories WHERE id = ?`).bind(tid).run();
  // Strip the name from every channel that references it.
  const { results } = await c.env.DB.prepare(`SELECT id, categories FROM tv_channels`).all<any>();
  for (const ch of results ?? []) {
    let cats: string[] = [];
    try { cats = JSON.parse(ch.categories ?? "[]"); } catch { cats = []; }
    if (!Array.isArray(cats) || !cats.includes(row.name)) continue;
    const rest = cats.filter((n) => n !== row.name);
    await c.env.DB.prepare(`UPDATE tv_channels SET categories = ? WHERE id = ?`)
      .bind(rest.length > 0 ? JSON.stringify(rest) : null, ch.id).run();
  }
  return c.json({ ok: true });
});
