import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

/**
 * Direct-to-storage uploads for the admin movie form.
 *
 * Why: admins used to paste URLs only, but LAN addresses (10.x/192.168.x)
 * cannot be reached by the cloud proxy, so movies hosted on the office
 * file server never played. These mutations let an admin pick a local file
 * (a movie, poster, backdrop, dub, quality rendition, subtitle or episode)
 * in the form and stream it straight into Convex file storage — no size
 * limit — and store its permanent public URL on the movie.
 *
 * Flow (Convex standard 3-step upload):
 *   1. createUploadUrl  → short-lived upload URL (admin-only)
 *   2. client POSTs the raw file to that URL → { storageId }
 *   3. finishUpload     → resolves the permanent public URL (admin-only)
 */

async function requireAdmin(ctx: MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (user?.role !== "admin") throw new Error("Admin access required");
  return user;
}

export const createUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const finishUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await requireAdmin(ctx);
    const url = await ctx.storage.getUrl(storageId);
    if (!url) throw new Error("Uploaded file could not be resolved — try again");
    return url;
  },
});
