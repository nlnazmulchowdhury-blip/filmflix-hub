import { Hono } from "hono";
import type { Env } from "./index";
import { requireAdmin, requireUser } from "./index";
import { HttpError } from "./crypto";

const DUB_LANGS: Record<string, string> = {
  bn: "Bengali", hi: "Hindi", ur: "Urdu", ta: "Tamil", te: "Telugu",
  mr: "Marathi", ne: "Nepali", en: "English",
};
const API_BASE = "https://api.elevenlabs.io";

type C = any; // Hono context with Env typing comes through the route mount
// The helpers accept a generic context; cast through unknown to keep strict
// mode happy without threading full generics through every handler.
const admin = (c: C) => requireAdmin(c as never) as Promise<any>;
const user = (c: C) => requireUser(c as never) as Promise<any>;

export const dubbingRoutes = new Hono<Env>()

  .get("/jobs/:movieId", async (c: C) => {
    await admin(c);
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM dub_jobs WHERE movie_id = ? ORDER BY created_at`,
    ).bind(c.req.param("movieId")).all();
    return c.json(results ?? []);
  })

  .post("/jobs", async (c: C) => {
    await admin(c);
    const { movieId, targetLang } = await c.req.json();
    const movie = await c.env.DB.prepare(`SELECT id, title, video_url FROM movies WHERE id = ?`)
      .bind(movieId).first();
    if (!movie) throw new HttpError(404, "Movie not found");
    if (!movie.video_url) throw new HttpError(400, "This movie has no main video URL to dub");
    const now = Date.now();
    const jid = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO dub_jobs (id, movie_id, movie_title, target_lang, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(jid, movieId, movie.title, targetLang, now, now).run();
    return c.json({ id: jid });
  })

  .post("/jobs/:jobId/submit", async (c: C) => {
    await admin(c);
    const jobId = c.req.param("jobId");
    const job = await c.env.DB.prepare(`SELECT * FROM dub_jobs WHERE id = ?`).bind(jobId).first();
    if (!job) throw new HttpError(404, "Dubbing job not found");
    const movie = await c.env.DB.prepare(`SELECT video_url, title FROM movies WHERE id = ?`)
      .bind(job.movie_id).first();
    if (!movie?.video_url) throw new HttpError(400, "Movie has no main video URL");

    const key = c.env.ELEVENLABS_API_KEY;
    if (!key) {
      await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .bind("ELEVENLABS_API_KEY is not configured on the worker.", Date.now(), jobId).run();
      throw new HttpError(500, "ELEVENLABS_API_KEY is not configured. Set it with `wrangler secret put ELEVENLABS_API_KEY`, then retry.");
    }
    await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'dubbing', updated_at = ? WHERE id = ?`)
      .bind(Date.now(), jobId).run();

    const form = new FormData();
    form.append("source_url", movie.video_url);
    form.append("target_lang", job.target_lang);
    form.append("name", `${movie.title} — ${job.target_lang}`);
    form.append("watermark", "false");
    form.append("drop_background_audio", "false");

    const res = await fetch(`${API_BASE}/v1/dubbing`, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      const friendly = res.status === 401
        ? "ElevenLabs says the API key is invalid — replace the secret and retry."
        : `ElevenLabs rejected the job (${res.status}): ${text.slice(0, 300)}`;
      await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .bind(friendly, Date.now(), jobId).run();
      throw new HttpError(502, friendly);
    }
    const data = (await res.json()) as { dubbing_id: string };
    await c.env.DB.prepare(`UPDATE dub_jobs SET dubbing_id = ?, status = 'dubbing', updated_at = ? WHERE id = ?`)
      .bind(data.dubbing_id, Date.now(), jobId).run();
    return c.json({ dubbingId: data.dubbing_id });
  })

  .post("/jobs/:jobId/poll", async (c: C): Promise<Response> => {
    await admin(c);
    const jobId = c.req.param("jobId");
    const job = await c.env.DB.prepare(`SELECT * FROM dub_jobs WHERE id = ?`).bind(jobId).first();
    if (!job) throw new HttpError(404, "Dubbing job not found");
    if (!job.dubbing_id) {
      await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .bind("The job was never submitted to ElevenLabs — press send now after the key is configured.", Date.now(), jobId).run();
      return c.json({ status: "failed" });
    }
    const key = c.env.ELEVENLABS_API_KEY;
    const res = await fetch(`${API_BASE}/v1/dubbing/${job.dubbing_id}`, {
      headers: key ? { "xi-api-key": key } : {},
    });
    if (!res.ok) throw new HttpError(502, `Status check failed: ${res.status}`);
    const data = (await res.json()) as { status: string; error?: string | null };

    if (data.status === "dubbing" || data.status === "pending") {
      return c.json({ status: "dubbing" });
    }
    if (data.status === "failed") {
      await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .bind(data.error ?? "ElevenLabs reported the dub failed", Date.now(), jobId).run();
      return c.json({ status: "failed" });
    }

    // dubbed: download and store in R2 for a permanent direct URL
    const audio = await fetch(`${API_BASE}/v1/dubbing/${job.dubbing_id}/audio/${job.target_lang}`, {
      headers: { "xi-api-key": key ?? "" },
    });
    if (!audio.ok || !audio.body) {
      await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .bind(`Could not download the dub (${audio.status})`, Date.now(), jobId).run();
      return c.json({ status: "failed" });
    }
    const key2 = `dubs/${job.movie_id}/${job.dubbing_id}-${job.target_lang}.mp4`;
    await c.env.DUBS.put(key2, audio.body, {
      httpMetadata: { contentType: "video/mp4" },
    });
    const publicUrl = `https://dubs.filmflix-api.workers.dev/${key2}`;

    const label = `${DUB_LANGS[job.target_lang] ?? job.target_lang} (AI dub)`;
    const movie = await c.env.DB.prepare(`SELECT dubs FROM movies WHERE id = ?`)
      .bind(job.movie_id).first();
    if (movie) {
      const dubs = (movie.dubs ? JSON.parse(movie.dubs) : []).filter((d: any) => d.label !== label);
      dubs.push({ label, videoUrl: publicUrl });
      await c.env.DB.prepare(`UPDATE movies SET dubs = ? WHERE id = ?`)
        .bind(JSON.stringify(dubs), job.movie_id).run();
    }
    await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'dubbed', updated_at = ? WHERE id = ?`)
      .bind(Date.now(), jobId).run();
    return c.json({ status: "dubbed", url: publicUrl });
  })

  .delete("/jobs/:jobId", async (c: C) => {
    await admin(c);
    await c.env.DB.prepare(`DELETE FROM dub_jobs WHERE id = ?`).bind(c.req.param("jobId")).run();
    return c.json({ ok: true });
  })

  .post("/jobs/:jobId/finish-manually", async (c: C) => {
    await admin(c);
    const { videoUrl } = await c.req.json();
    const jobId = c.req.param("jobId");
    const job = await c.env.DB.prepare(`SELECT * FROM dub_jobs WHERE id = ?`).bind(jobId).first();
    if (!job) throw new HttpError(404, "Job not found");
    const label = `${DUB_LANGS[job.target_lang] ?? job.target_lang} (AI dub)`;
    await c.env.DB.prepare(`UPDATE dub_jobs SET status = 'dubbed', updated_at = ? WHERE id = ?`)
      .bind(Date.now(), jobId).run();
    const movie = await c.env.DB.prepare(`SELECT dubs FROM movies WHERE id = ?`)
      .bind(job.movie_id).first();
    if (movie) {
      const dubs = (movie.dubs ? JSON.parse(movie.dubs) : []).filter((d: any) => d.label !== label);
      dubs.push({ label, videoUrl });
      await c.env.DB.prepare(`UPDATE movies SET dubs = ? WHERE id = ?`)
        .bind(JSON.stringify(dubs), job.movie_id).run();
    }
    return c.json({ ok: true });
  })

  .delete("/movies/:movieId/dubs", async (c: C) => {
    await admin(c);
    const { label } = await c.req.json();
    const movie = await c.env.DB.prepare(`SELECT dubs FROM movies WHERE id = ?`)
      .bind(c.req.param("movieId")).first();
    if (movie) {
      await c.env.DB.prepare(`UPDATE movies SET dubs = ? WHERE id = ?`).bind(
        JSON.stringify((movie.dubs ? JSON.parse(movie.dubs) : []).filter((d: any) => d.label !== label)),
        c.req.param("movieId"),
      ).run();
    }
    return c.json({ ok: true });
  });
