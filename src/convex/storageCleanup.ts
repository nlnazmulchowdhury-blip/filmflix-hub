import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/**
 * Orphan-file cleanup for admin uploads.
 *
 * Uploaded files (main videos, posters, backdrops, dubs, qualities,
 * subtitles, episodes) live in Convex file storage and are referenced from
 * movies only as public URLs. When a movie is deleted — or a URL is replaced
 * while editing — the storage object would otherwise stay in the cloud
 * forever (orphaned, still billing storage). This module maps those public
 * URLs back to their storage ids and deletes whichever files no movie
 * references anymore.
 *
 * Deletion paths:
 *   • movies.remove / movies.update — purge immediately (movies.ts)
 *   • hourly cron sweep — safety net for anything else (failed saves,
 *     abandoned form sessions, one-off errors during edit purges)
 *
 * A file is NEVER deleted while any movie still lists its URL, and the
 * sweep leaves a 24h grace period after upload so in-progress form sessions
 * (file uploaded, "Add movie" not yet clicked) are untouched.
 */

/** All media URLs a movie row references (main + arrays). */
function movieMediaUrls(m: {
  videoUrl?: string;
  posterUrl?: string;
  backdropUrl?: string;
  episodes?: { videoUrl: string }[];
  dubs?: { videoUrl: string }[];
  qualities?: { videoUrl: string }[];
  subtitles?: { url: string }[];
  seasons?: { episodes?: { videoUrl: string }[] }[];
}): string[] {
  const urls: string[] = [];
  if (m.videoUrl) urls.push(m.videoUrl);
  if (m.posterUrl) urls.push(m.posterUrl);
  if (m.backdropUrl) urls.push(m.backdropUrl);
  for (const e of m.episodes ?? []) if (e.videoUrl) urls.push(e.videoUrl);
  for (const d of m.dubs ?? []) if (d.videoUrl) urls.push(d.videoUrl);
  for (const q of m.qualities ?? []) if (q.videoUrl) urls.push(q.videoUrl);
  for (const s of m.subtitles ?? []) if (s.url) urls.push(s.url);
  for (const s of m.seasons ?? [])
    for (const e of s.episodes ?? []) if (e.videoUrl) urls.push(e.videoUrl);
  return urls;
}

/** Every media URL referenced anywhere in the catalog. */
export const allReferencedUrls = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const urls = new Set<string>();
    for (const m of await ctx.db.query("movies").collect()) {
      for (const u of movieMediaUrls(m)) urls.add(u);
    }
    return [...urls];
  },
});

/**
 * Extract the storage id embedded in a public storage URL
 * (…/api/storage/<uuid> or /storage/<uuid>). Returns null for external
 * URLs (normal pasted links) — they are skipped, never errors.
 */
function storageIdFromUrl(url: string): Id<"_storage"> | null {
  const marker = "/storage/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const key = url.slice(idx + marker.length).split(/[?#]/)[0];
  if (!/^[0-9a-f-]{36}$/i.test(key)) return null;
  return key as Id<"_storage">;
}

/**
 * Delete the storage objects behind the given URLs, skipping every URL that
 * is still referenced anywhere in the catalog (extra safety: the caller's
 * view of "its" movie's URLs may be stale while another movie shares the
 * same file). Unknown/external URLs are silently skipped.
 */
export const purgeUrlsIfUnreferenced = internalMutation({
  args: { urls: v.array(v.string()) },
  handler: async (ctx, { urls }): Promise<number> => {
    if (urls.length === 0) return 0;
    const live = new Set(
      await ctx.runQuery(internal.storageCleanup.allReferencedUrls, {}),
    );
    let purged = 0;
    for (const url of urls) {
      if (live.has(url)) continue;
      const id = storageIdFromUrl(url);
      if (!id) continue;
      try {
        await ctx.storage.delete(id);
        purged++;
      } catch {
        // Already gone (or id from another backend) — nothing to do.
      }
    }
    return purged;
  },
});

/**
 * Hourly sweep: delete any stored file whose public URL is not referenced
 * by any movie AND that was uploaded more than GRACE_MS ago. The grace
 * window keeps in-progress admin form sessions safe (file uploaded, movie
 * not saved yet).
 */
const GRACE_MS = 24 * 60 * 60 * 1000;

export const sweepOrphans = internalMutation({
  args: {},
  handler: async (ctx) => {
    const live = new Set(
      await ctx.runQuery(internal.storageCleanup.allReferencedUrls, {}),
    );
    const cutoff = Date.now() - GRACE_MS;
    let scanned = 0;
    let purged = 0;
    for (const file of await ctx.db.system.query("_storage").collect()) {
      scanned++;
      if (file._creationTime > cutoff) continue; // within grace period
      const url = await ctx.storage.getUrl(file._id);
      if (!url || live.has(url)) continue;
      await ctx.storage.delete(file._id);
      purged++;
    }
    return { scanned, purged };
  },
});
