import { Hono } from "hono";
import { requireAdmin, HttpError, type Env } from "./index";

/**
 * Which operating systems the installable FilmFlix app exists for.
 *
 * A row means "there is a real file behind this button" — the landing cards
 * fall back to browser install (PWA) guidance when their platform is absent,
 * so the UI can never advertise a download that 404s.
 */
export const appBuildRoutes = new Hono<Env>();

const PLATFORMS = ["android", "ios", "windows", "macos", "tv"] as const;
type Platform = (typeof PLATFORMS)[number];

/** Where the binary lives: a public http(s) URL (release asset, Drive mirror,
 *  or an R2 object URL once that bucket is enabled). */
function safeDownloadUrl(raw: string): string {
  const url = (raw ?? "").trim();
  if (!url) throw new HttpError(400, "Download URL is required");
  if (url.length > 500) throw new HttpError(400, "Download URL is too long (max 500 characters)");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "Download URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new HttpError(400, "Download URL must be http(s)");
  return parsed.href;
}

function platformOf(raw: string | undefined): Platform {
  const p = (raw ?? "").trim().toLowerCase() as Platform;
  if (!PLATFORMS.includes(p))
    throw new HttpError(400, `Unknown platform — use one of: ${PLATFORMS.join(", ")}`);
  return p;
}

appBuildRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT platform, url, version, size_bytes, notes, updated_at FROM app_builds`,
  ).all<any>();
  return c.json({
    builds: (results ?? []).map((r) => ({
      platform: r.platform as Platform,
      url: r.url as string,
      version: (r.version as string | null) ?? "",
      sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
      notes: (r.notes as string | null) ?? "",
      updatedAt: Number(r.updated_at),
    })),
  });
});

appBuildRoutes.put("/:platform", async (c) => {
  await requireAdmin(c);
  const platform = platformOf(c.req.param("platform"));
  const body = await c.req
    .json<{ url?: string; version?: string; sizeBytes?: number | null; notes?: string }>()
    .catch(() => {
      throw new HttpError(400, "Body must be JSON");
    });
  const url = safeDownloadUrl(body.url ?? "");
  const version = (body.version ?? "").trim().slice(0, 40);
  const notes = (body.notes ?? "").trim().slice(0, 200);
  const size = Number(body.sizeBytes);
  const sizeBytes = Number.isFinite(size) && size > 0 ? Math.floor(size) : null;
  await c.env.DB.prepare(
    `INSERT INTO app_builds (platform, url, version, size_bytes, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET
       url = excluded.url, version = excluded.version, size_bytes = excluded.size_bytes,
       notes = excluded.notes, updated_at = excluded.updated_at`,
  )
    .bind(platform, url, version, sizeBytes, notes, Date.now())
    .run();
  return c.json({ platform, url, version, sizeBytes, notes });
});

appBuildRoutes.delete("/:platform", async (c) => {
  await requireAdmin(c);
  const platform = platformOf(c.req.param("platform"));
  await c.env.DB.prepare(`DELETE FROM app_builds WHERE platform = ?`).bind(platform).run();
  return c.json({ ok: true, platform });
});
