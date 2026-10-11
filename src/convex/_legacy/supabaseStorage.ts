"use node";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const API_BASE = "https://api.elevenlabs.io";
/** Public bucket the video player streams finished dubs from. */
const DUB_BUCKET = "dubs";

/** Service-role client for server-side uploads; null when unconfigured. */
function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function ensurePublicBucket(supabase: SupabaseClient, bucket: string) {
  const { error } = await supabase.storage.createBucket(bucket, {
    public: true,
  });
  if (error && !/exists|duplicate/i.test(error.message)) {
    throw new Error(
      `Could not create Supabase bucket "${bucket}": ${error.message}`,
    );
  }
}

/**
 * Download the finished dub from ElevenLabs and store it in Supabase
 * Storage so the player gets a permanent direct playback URL.
 * Returns null when Supabase is not configured — callers fall back to
 * Convex file storage.
 */
export const uploadDubAudio = internalAction({
  args: {
    dubbingId: v.string(),
    targetLang: v.string(),
  },
  handler: async (_ctx, { dubbingId, targetLang }): Promise<string | null> => {
    const supabase = getSupabase();
    if (!supabase) return null;

    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ELEVENLABS_API_KEY is not configured");

    await ensurePublicBucket(supabase, DUB_BUCKET);

    const res = await fetch(
      `${API_BASE}/v1/dubbing/${dubbingId}/audio/${targetLang}`,
      { headers: { "xi-api-key": key } },
    );
    if (!res.ok) {
      throw new Error(`ElevenLabs audio download failed (${res.status})`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "video/mp4";
    const path = `${dubbingId}/${targetLang}.mp4`;

    const { error } = await supabase.storage
      .from(DUB_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });
    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const { data } = supabase.storage.from(DUB_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  },
});
