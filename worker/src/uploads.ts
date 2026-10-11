import { Hono } from "hono";
import { requireAdmin, HttpError, type Env } from "./index";

/** Direct-to-storage uploads for the admin movie form — replaces the Convex
 *  storage flow (createUploadUrl → client POST → finishUpload) with R2:
 *   1. POST /uploads/url      → { uploadUrl, storageId }
 *   2. client PUTs the file to uploadUrl
 *   3. POST /uploads/finish   → permanent public URL on the worker origin
 * The route degrades with a clear 503 until R2 is activated and the UPLOADS
 * binding exists, so the admin form's file picker shows the reason instead
 * of silently failing. */
export const uploadRoutes = new Hono<Env>();

function bucket(c: any): R2Bucket {
  const b = c.env.UPLOADS;
  if (!b) {
    throw new HttpError(
      503,
      "R2 is not activated yet. Enable R2 in the Cloudflare dashboard (R2 → Activate), then add the filmflix-uploads bucket as the UPLOADS binding on the filmflix-hub worker.",
    );
  }
  return b;
}

/** PUT target the client streams the file to. Scoped to this admin's session
 *  via the token required below, and keyed by a fresh storage id. */
uploadRoutes.post("/url", async (c) => {
  await requireAdmin(c);
  bucket(c);
  const storageId = crypto.randomUUID();
  return c.json({ storageId, path: `/uploads/object/${storageId}` });
});

uploadRoutes.put("/object/:storageId", async (c) => {
  await requireAdmin(c);
  const b = bucket(c);
  const body = await c.req.arrayBuffer();
  await b.put(c.req.param("storageId"), body, {
    httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
  });
  return c.json({ ok: true });
});

/** Resolves a finished upload to its permanent public URL. */
uploadRoutes.post("/finish", async (c) => {
  await requireAdmin(c);
  const b = bucket(c);
  const { storageId } = await c.req.json<{ storageId: string }>();
  if (!storageId) throw new HttpError(400, "storageId is required");
  const obj = await b.get(storageId);
  if (!obj) throw new HttpError(404, "Uploaded file could not be resolved — try again");
  const bytes = await obj.arrayBuffer();
  await b.put(storageId, bytes, {
    httpMetadata: { contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" },
  });
  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/uploads/object/${storageId}` });
});

/** Public GET of an uploaded object (streamed, ranged requests honored). */
uploadRoutes.get("/object/:storageId", async (c) => {
  const b = bucket(c);
  const obj = await b.get(c.req.param("storageId"));
  if (!obj) throw new HttpError(404, "Not found");
  const headers = new Headers();
  const ct = obj.httpMetadata?.contentType;
  if (ct) headers.set("content-type", ct);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (c.req.header("range")) {
    const ranged = await b.get(c.req.param("storageId"), {
      range: c.req.header("range") as any,
    });
    if (ranged) {
      const scan = ranged.range as { offset?: number; length?: number; suffix?: number } | undefined;
      const offset = scan?.offset ?? 0;
      const length = scan?.length ?? (scan?.suffix ?? ranged.size);
      const h = new Headers(headers);
      h.set("content-range", `bytes ${offset}-${offset + length - 1}/${ranged.size}`);
      h.set("content-length", String(length));
      return new Response(ranged.body, { status: 206, headers: h });
    }
  }
  return new Response(obj.body, { status: 200, headers });
});
