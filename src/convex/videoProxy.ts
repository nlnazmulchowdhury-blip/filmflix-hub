import { httpAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * HTTPS streaming proxy for admin-registered video links.
 *
 * Why: admins paste direct movie links that may be plain `http://` (e.g. an
 * FTP server's HTTP directory). Browsers block `http://` media on an HTTPS
 * page (mixed content) and some networks cannot reach the origin at all.
 * The player therefore requests
 *   https://<site>/video-proxy?url=<encoded upstream>
 * and this action fetches the upstream server-side and streams the bytes
 * back with Range passthrough, so seeking works and every ISP can play it.
 *
 * Only URLs that are actually registered on a movie (main video, episode,
 * dub, or quality rendition) may be proxied, so this is not an open proxy.
 */

/** Returns a human-readable rejection reason, or null when acceptable. */
function blockReason(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Invalid video URL";
  }
  if (u.protocol === "ftp:" || u.port === "21") {
    return (
      "FTP links cannot be proxied — paste the FTP server's HTTP directory " +
      "link instead (http://host/path/file.mp4)"
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "Only http/https video URLs can be proxied";
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  ) {
    return "Cannot proxy localhost addresses";
  }
  if (/^127\./.test(host)) {
    return "Cannot proxy loopback addresses";
  }
  // Private-network ranges: the Convex cloud cannot route to LAN machines,
  // so attempt-then-fail would only confuse. Say so up front.
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local")
  ) {
    return (
      "This is a private/LAN address (e.g. 10.x or 192.168.x). The cloud " +
      "proxy cannot reach machines inside a local network. Use a publicly " +
      "reachable URL, or upload the file to cloud storage instead."
    );
  }
  return null;
}

const PASS_THROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
];

function errorResponse(status: number, error: string, detail?: string) {
  return new Response(JSON.stringify({ error, detail }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

/** The set of upstream URLs currently registered on any movie. */
export const registeredVideoUrls = internalQuery({
  args: {},
  handler: async (ctx) => {
    const urls = new Set<string>();
    for (const m of await ctx.db.query("movies").collect()) {
      if (m.videoUrl) urls.add(m.videoUrl);
      for (const e of m.episodes ?? []) if (e.videoUrl) urls.add(e.videoUrl);
      for (const d of m.dubs ?? []) if (d.videoUrl) urls.add(d.videoUrl);
      for (const q of m.qualities ?? []) if (q.videoUrl) urls.add(q.videoUrl);
    }
    return [...urls];
  },
});

export const handleVideoProxy = httpAction(async (ctx, request) => {
  const upstreamUrl = new URL(request.url).searchParams.get("url");
  if (!upstreamUrl) {
    return errorResponse(400, "Missing ?url= parameter");
  }
  if (upstreamUrl.length > 2048) {
    return errorResponse(400, "Video URL is too long");
  }
  const problem = blockReason(upstreamUrl);
  if (problem) return errorResponse(400, problem);

  // Not an open proxy: the URL must be registered on a movie.
  const allowed = await ctx.runQuery(internal.videoProxy.registeredVideoUrls, {});
  if (!allowed.includes(upstreamUrl)) {
    return errorResponse(
      403,
      "This video URL is not registered in the catalog",
    );
  }

  const range = request.headers.get("range") ?? undefined;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        // Many file servers (nginx dirs, Google sample buckets, some FTP
        // HTTP gateways) reject requests without a browser-like UA.
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "*/*",
        ...(range ? { Range: range } : {}),
      },
      redirect: "follow",
    });
  } catch (err) {
    return errorResponse(
      502,
      "Could not reach the video server",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    const body = await upstream.text().catch(() => "");
    return errorResponse(
      upstream.status >= 500 ? 502 : upstream.status,
      `Upstream server responded ${upstream.status} ${upstream.statusText}`,
      body.slice(0, 300) || undefined,
    );
  }

  const headers = new Headers();
  for (const h of PASS_THROUGH_HEADERS) {
    const value = upstream.headers.get(h);
    if (value) headers.set(h, value);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "video/mp4");
  }
  if (!headers.has("accept-ranges")) {
    headers.set("accept-ranges", "bytes");
  }
  headers.set("Access-Control-Allow-Origin", "*");

  // Stream the body straight through — no buffering of the whole movie.
  return new Response(upstream.body, { status: upstream.status, headers });
});
