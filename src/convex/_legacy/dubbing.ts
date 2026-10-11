import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { DUB_LANGUAGES } from "../lib/dub-languages";

const API_BASE = "https://api.elevenlabs.io";

async function requireAdminId(ctx: { db: any } & Parameters<typeof getAuthUserId>[0]) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (user?.role !== "admin") throw new Error("Admin access required");
  return user;
}

/* ------------------------------------------------------------------ */
/* Queries & mutations used by the admin UI                            */
/* ------------------------------------------------------------------ */

export const listJobsForMovie = query({
  args: { movieId: v.id("movies") },
  handler: async (ctx, { movieId }) => {
    return await ctx.db
      .query("dubJobs")
      .withIndex("by_movie", (q) => q.eq("movieId", movieId))
      .collect();
  },
});

/** Start a dubbing job on ElevenLabs for the movie's main video URL. */
export const startDub = mutation({
  args: { movieId: v.id("movies"), targetLang: v.string() },
  handler: async (ctx, { movieId, targetLang }) => {
    await requireAdminId(ctx);
    const movie: Doc<"movies"> | null = await ctx.db.get(movieId);
    if (!movie) throw new Error("Movie not found");
    if (!movie.videoUrl) {
      throw new Error("This movie has no main video URL to dub");
    }
    const now = Date.now();
    return await ctx.db.insert("dubJobs", {
      movieId,
      movieTitle: movie.title,
      targetLang,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setJobStatus = mutation({
  args: {
    jobId: v.id("dubJobs"),
    status: v.string(),
    dubbingId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, status, dubbingId, error }) => {
    await requireAdminId(ctx);
    await ctx.db.patch(jobId, {
      status,
      updatedAt: Date.now(),
      ...(dubbingId !== undefined ? { dubbingId } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return jobId;
  },
});

export const removeJob = mutation({
  args: { jobId: v.id("dubJobs") },
  handler: async (ctx, { jobId }) => {
    await requireAdminId(ctx);
    await ctx.db.delete(jobId);
  },
});

/* ------------------------------------------------------------------ */
/* Internal: the ElevenLabs polling/finishing logic                    */
/* ------------------------------------------------------------------ */

export const jobById = internalQuery({
  args: { jobId: v.id("dubJobs") },
  handler: async (ctx, { jobId }) => await ctx.db.get(jobId),
});

export const saveJob = internalMutation({
  args: {
    jobId: v.id("dubJobs"),
    status: v.string(),
    dubbingId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, status, dubbingId, error }) => {
    await ctx.db.patch(jobId, {
      status,
      updatedAt: Date.now(),
      ...(dubbingId !== undefined ? { dubbingId } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  },
});

/** Attach the finished dub to the movie's dubs list (language menu). */
export const attachDubToMovie = internalMutation({
  args: {
    movieId: v.id("movies"),
    label: v.string(),
    videoUrl: v.string(),
  },
  handler: async (ctx, { movieId, label, videoUrl }) => {
    const movie: Doc<"movies"> | null = await ctx.db.get(movieId);
    if (!movie) return;
    const dubs = (movie.dubs ?? []).filter((d) => d.label !== label);
    dubs.push({ label, videoUrl });
    await ctx.db.patch(movieId, { dubs });
  },
});

async function elevenLabsFetch(path: string, init?: RequestInit) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error(
      "ELEVENLABS_API_KEY is not configured. Add it in the project's API keys page.",
    );
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "xi-api-key": key,
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

/**
 * Kick off the ElevenLabs dub for a queued job. The dub runs remotely for
 * (potentially) a long time — the action just submits the job and returns.
 */
export const submitDub = action({
  args: { jobId: v.id("dubJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runQuery(internal.dubbing.jobById, { jobId });
    if (!job) throw new Error("Dubbing job not found");
    const movie: Doc<"movies"> | null = await ctx.runQuery(api.movies.get, {
      id: job.movieId,
    });
    if (!movie?.videoUrl) throw new Error("Movie has no main video URL");

    // Fail fast and visibly when the key is missing — never leave the job
    // stuck in "dubbing" without an id.
    if (!process.env.ELEVENLABS_API_KEY) {
      await ctx.runMutation(internal.dubbing.saveJob, {
        jobId,
        status: "failed",
        error:
          "ELEVENLABS_API_KEY is not configured. Add the key in the project's API keys page, then press “send now”.",
      });
      throw new Error(
        "ELEVENLABS_API_KEY is not configured. Add the key in the project's API keys page, then retry.",
      );
    }

    await ctx.runMutation(internal.dubbing.saveJob, {
      jobId,
      status: "dubbing",
    });

    const form = new FormData();
    form.append("source_url", movie.videoUrl);
    form.append("target_lang", job.targetLang);
    form.append("name", `${movie.title} — ${job.targetLang}`);
    form.append("watermark", "false");
    form.append("drop_background_audio", "false");

    const res = await elevenLabsFetch("/v1/dubbing", {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      // 401 = the stored key is wrong/revoked — say exactly what to do.
      const friendly =
        res.status === 401
          ? "ElevenLabs says the API key is invalid. Paste a valid key (starts with sk_) in chat so it can be replaced, then press “send now”."
          : `ElevenLabs rejected the job (${res.status}): ${text.slice(0, 300)}`;
      await ctx.runMutation(internal.dubbing.saveJob, {
        jobId,
        status: "failed",
        error: friendly,
      });
      throw new Error(friendly);
    }
    const data = (await res.json()) as { dubbing_id: string };
    await ctx.runMutation(internal.dubbing.saveJob, {
      jobId,
      status: "dubbing",
      dubbingId: data.dubbing_id,
    });
    return data.dubbing_id;
  },
});

/**
 * Poll ElevenLabs; when the dub is finished, build a direct playback URL for
 * the dubbed audio/video and attach it to the movie's language list.
 *
 * The returned URL embeds the API key server-side? No — ElevenLabs audio
 * downloads require the xi-api-key header, which browsers can't send on a
 * plain <video src>. So we stream the file through this action once and
 * store it in Convex file storage, then use that permanent public URL.
 */
export const pollDub = action({
  args: { jobId: v.id("dubJobs") },
  handler: async (ctx, { jobId }): Promise<{ status: "dubbed" | "dubbing" | "failed"; url?: string }> => {
    const job = await ctx.runQuery(internal.dubbing.jobById, { jobId });
    if (!job) throw new Error("Dubbing job not found");
    if (!job.dubbingId) {
      // The submit never completed (usually a missing API key or network
      // failure). Mark the job failed instead of crashing the UI.
      await ctx.runMutation(internal.dubbing.saveJob, {
        jobId,
        status: "failed",
        error:
          "The job was never submitted to ElevenLabs — press “send now” after the API key is configured.",
      });
      return { status: "failed" as const };
    }

    const res = await elevenLabsFetch(`/v1/dubbing/${job.dubbingId}`);
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
    const data = (await res.json()) as {
      status: string;
      error?: string | null;
    };

    if (data.status === "dubbing" || data.status === "pending") {
      await ctx.runMutation(internal.dubbing.saveJob, {
        jobId,
        status: "dubbing",
      });
      return { status: "dubbing" as const };
    }

    if (data.status === "failed") {
      await ctx.runMutation(internal.dubbing.saveJob, {
        jobId,
        status: "failed",
        error: data.error ?? "ElevenLabs reported the dub failed",
      });
      return { status: "failed" as const };
    }

    // status === "dubbed": download the dubbed file. Prefer Supabase
    // Storage (permanent direct playback URL); fall back to Convex file
    // storage when Supabase is not configured.
    let publicUrl: string | null = null;
    try {
      publicUrl = await ctx.runAction(internal.supabaseStorage.uploadDubAudio, {
        dubbingId: job.dubbingId,
        targetLang: job.targetLang,
      });
    } catch (err) {
      console.warn(
        "Supabase dub storage failed, falling back to Convex storage:",
        err instanceof Error ? err.message : err,
      );
    }

    if (!publicUrl) {
      const audioRes = await elevenLabsFetch(
        `/v1/dubbing/${job.dubbingId}/audio/${job.targetLang}`,
      );
      if (!audioRes.ok || !audioRes.body) {
        await ctx.runMutation(internal.dubbing.saveJob, {
          jobId,
          status: "failed",
          error: `Could not download the dub (${audioRes.status})`,
        });
        return { status: "failed" as const };
      }

      const blob = await audioRes.blob();
      const storageId = await ctx.storage.store(
        new Blob([blob], { type: blob.type || "video/mp4" }),
      );
      publicUrl = await ctx.storage.getUrl(storageId);
    }
    if (!publicUrl) {
      await ctx.runMutation(internal.dubbing.saveJob, {
        jobId,
        status: "failed",
        error: "Dub finished but the file could not be stored",
      });
      return { status: "failed" as const };
    }

    const label = DUB_LANGUAGES.find((l) => l.code === job.targetLang)?.label ?? job.targetLang;
    await ctx.runMutation(internal.dubbing.attachDubToMovie, {
      movieId: job.movieId,
      label: `${label} (AI dub)`,
      videoUrl: publicUrl,
    });
    await ctx.runMutation(internal.dubbing.saveJob, {
      jobId,
      status: "dubbed",
    });
    return { status: "dubbed" as const, url: publicUrl };
  },
});

/**
 * Manual finish: paste a hosted URL for the dub if you downloaded the file
 * and uploaded it to your own hosting instead of using storage.
 */
export const finishDubManually = mutation({
  args: {
    jobId: v.id("dubJobs"),
    videoUrl: v.string(),
  },
  handler: async (ctx, { jobId, videoUrl }) => {
    await requireAdminId(ctx);
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Job not found");
    const label =
      DUB_LANGUAGES.find((l) => l.code === job.targetLang)?.label ?? job.targetLang;
    await ctx.db.patch(jobId, { status: "dubbed", updatedAt: Date.now() });
    await ctx.runMutation(internal.dubbing.attachDubToMovie, {
      movieId: job.movieId,
      label: `${label} (AI dub)`,
      videoUrl,
    });
    return jobId;
  },
});

/** Remove a finished dub from the movie's language list. */
export const removeDubFromMovie = mutation({
  args: { movieId: v.id("movies"), label: v.string() },
  handler: async (ctx, { movieId, label }) => {
    await requireAdminId(ctx);
    const movie: Doc<"movies"> | null = await ctx.db.get(movieId);
    if (!movie) return;
    await ctx.db.patch(movieId, {
      dubs: (movie.dubs ?? []).filter((d) => d.label !== label),
    });
  },
});
