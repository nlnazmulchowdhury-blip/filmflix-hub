import { action } from "./_generated/server";
import { v } from "convex/values";

/**
 * Shortens URLs server-side so the database stores compact links instead of
 * long streaming/CDN URLs. Uses the free TinyURL API with is.gd as a
 * fallback. Called from the admin form before saving a movie.
 *
 * Runs without auth because it only performs outbound shortening of
 * URLs the admin is about to save; every write to the movies table itself
 * remains admin-gated.
 */
export const shortenBatch = action({
  args: { urls: v.array(v.string()) },
  handler: async (_ctx, { urls }) => {
    const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];

    const results = await Promise.all(
      unique.map(async (url) => {
        try {
          const res = await fetch(
            `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
            { redirect: "follow" },
          );
          if (res.ok) {
            const text = (await res.text()).trim();
            if (text.startsWith("https://")) return { url, short: text };
          }
        } catch {
          // fall through to is.gd
        }
        try {
          const res = await fetch("https://is.gd/create.php", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              format: "json",
              url,
            }).toString(),
          });
          if (res.ok) {
            const data = (await res.json()) as { shorturl?: string };
            if (data.shorturl) {
              return { url, short: data.shorturl.startsWith("http") ? data.shorturl : `https://${data.shorturl}` };
            }
          }
        } catch {
          // give up on this one
        }
        // Shortening failed — keep the original so saving never breaks.
        return { url, short: url };
      }),
    );

    const map: Record<string, string> = {};
    for (const r of results) map[r.url] = r.short;
    return map;
  },
});
