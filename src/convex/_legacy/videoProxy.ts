import { httpAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { resolveMovieBoxSigned } from "./mbWeb";

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
  // HLS manifests are served with cache headers tuned for their CDN — a
  // locally cached playlist goes stale when the signed token rotates.
  "cache-control",
];

/**
 * File-locker hosts (gofile, katfile, etc.) never serve raw bytes to
 * hotlinking players — they redirect to an expiring download page or a
 * browser-check page, which arrives here as `text/html`. Peek at the first
 * chunk so admins get a clear message instead of a player that silently
 * fails to decode.
 */
const HTML_SNIFF_BYTES = 512;

function isHtmlHead(bytes: Uint8Array | undefined): boolean {
  if (!bytes) return false;
  const head = new TextDecoder()
    .decode(bytes.slice(0, HTML_SNIFF_BYTES))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Reads the first body chunk (to sniff it) and returns the remainder. */
async function peekFirstChunk(
  upstream: Response,
): Promise<{ first: Uint8Array | undefined; rest: ReadableStream<Uint8Array> }> {
  const reader = (upstream.body ?? new ReadableStream<Uint8Array>()).getReader();
  const { value, done } = await reader.read();
  const first = done ? undefined : value;
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async () => {
        try {
          for (;;) {
            const { done: d, value: v } = await reader.read();
            if (d) break;
            controller.enqueue(v);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      };
      void pump();
    },
  });
  return { first, rest };
}

/**
 * `&download=1` turns the proxy into a file download.
 *
 * Why it exists: the CDNs behind these links (macdn.aoneroom.com,
 * content.elaach.com, …) answer with `Content-Type: video/mp4` and **no**
 * `Content-Disposition`, so a plain `<a href>` either opens a new tab and
 * plays the movie (cross-origin `download` attributes are ignored) or does
 * nothing at all. With `attachment` set, one click saves the file instead.
 */
const DOWNLOAD_TYPES: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/mpeg": ".mpg",
  "video/avi": ".avi",
};

/** Guesses a file extension the response body actually deserves. */
function extensionFor(contentType: string, upstreamUrl: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (DOWNLOAD_TYPES[type]) return DOWNLOAD_TYPES[type];
  try {
    const path = new URL(upstreamUrl).pathname;
    const dot = path.lastIndexOf(".");
    if (dot > -1 && /^[A-Za-z0-9]{2,5}$/.test(path.slice(dot + 1))) {
      return "." + path.slice(dot + 1).toLowerCase();
    }
  } catch {
    // not an http(s) URL (mbres:// references) — fall through
  }
  return ".mp4";
}

/** Characters that must never appear in a saved file name. */
const UNSAFE_FILENAME_CHARS = new Set(["/", "\\", '"', ":", "*", "?", "<", ">", "|"]);

/**
 * Builds the saved file name: the label the UI sent (movie title + quality),
 * else the upstream file name, plus a matching extension. Control characters
 * and path separators are stripped so a crafted label cannot escape the
 * download folder or break the header.
 */
function buildDownloadFilename(
  wanted: string | null,
  upstreamUrl: string,
  contentType: string,
): string {
  let name = "";
  for (const ch of wanted ?? "") {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && !UNSAFE_FILENAME_CHARS.has(ch)) {
      name += ch;
    }
  }
  name = name.trim();
  if (!name) {
    try {
      const path = new URL(upstreamUrl).pathname;
      name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    } catch {
      name = "";
    }
  }
  if (!name) name = "video";
  if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) {
    name += extensionFor(contentType, upstreamUrl);
  }
  return name.slice(0, 150);
}

/** RFC 6266 value: ASCII fallback + UTF-8 `filename*` for Bengali titles. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

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
      // Download-menu links live in their own array — an admin may register a
      // file there that is not the playable videoUrl, and the download button
      // must not be rejected as "not registered in the catalog".
      for (const d of m.downloads ?? []) if (d.url) urls.add(d.url);
    }
    return [...urls];
  },
});

export const handleVideoProxy = httpAction(async (ctx, request) => {
  const searchParams = new URL(request.url).searchParams;
  const upstreamUrl = searchParams.get("url");
  if (!upstreamUrl) {
    return errorResponse(400, "Missing ?url= parameter");
  }
  if (upstreamUrl.length > 2048) {
    return errorResponse(400, "Video URL is too long");
  }
  // `&download=1` = answer with `Content-Disposition: attachment` so the
  // browser saves the file instead of opening a tab that plays it.
  const wantDownload = /^(1|true|yes)$/i.test(searchParams.get("download") ?? "");
  const wantedFilename = searchParams.get("filename");

  /* MovieBox references (mbres://<subjectId>/<quality>) are stable but the
     provider's file URLs are signed and short-lived. Resolve one fresh on
     every playback request, then stream it like any other upstream. */
  const mbMatch = /^mbres:\/\/([A-Za-z0-9_-]+)\/(\d+p?)$/.exec(upstreamUrl);
  let effectiveUpstream = upstreamUrl;
  if (mbMatch) {
    try {
      effectiveUpstream = await resolveMovieBoxSigned(
        mbMatch[1],
        mbMatch[2],
      );
    } catch (err) {
      return errorResponse(
        502,
        "MovieBox stream could not be resolved",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    const problem = blockReason(upstreamUrl);
    if (problem) return errorResponse(400, problem);

    // Not an open proxy: the URL must be registered on a movie.
    const allowed = await ctx.runQuery(
      internal.videoProxy.registeredVideoUrls,
      {},
    );
    if (!allowed.includes(upstreamUrl)) {
      return errorResponse(
        403,
        "This video URL is not registered in the catalog",
      );
    }
  }

  const range = request.headers.get("range") ?? undefined;

  let upstream: Response;
  try {
    upstream = await fetch(effectiveUpstream, {
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

  // File-locker hosts (gofile, katfile, …) answer hotlinking players with an
  // HTML download page instead of video bytes — the <video> element then fails
  // with an inscrutable decode error. Catch it here with a clear message.
  // HLS playlists are TEXT manifests (#EXTM3U …) — they must skip this sniff
  // or every tokenized .m3u8 stream would be rejected as "a web page".
  const upstreamType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const isHlsPlaylist =
    upstreamType.includes("mpegurl") || /\.m3u8(\?|$)/i.test(upstreamUrl);
  const { first, rest } = await peekFirstChunk(upstream);
  if (!isHlsPlaylist && isHtmlHead(first)) {
    try {
      await upstream.body?.cancel();
    } catch {
      // ignore — upstream may already be closed
    }
    return errorResponse(
      415,
      "This link serves a web page, not a video file. File-sharing hosts " +
        "like gofile.io do not allow direct playback — download the file and " +
        "use the Upload button in the admin panel instead.",
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
  if (wantDownload) {
    headers.set(
      "Content-Disposition",
      contentDisposition(
        buildDownloadFilename(
          wantedFilename,
          effectiveUpstream,
          headers.get("content-type") ?? "",
        ),
      ),
    );
  }
  headers.set("Access-Control-Allow-Origin", "*");
  // HLS playlists regenerate per viewer (signed, short-lived URLs) — a cached
  // stale playlist would 403 after the token expires. Never cache them here.
  if (isHlsPlaylist) headers.set("Cache-Control", "no-store");

  // Re-attach the sniffed first chunk so the player still gets complete bytes.
  const body = first
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          void rest
            .pipeTo(
              new WritableStream<Uint8Array>({
                write(chunk) {
                  controller.enqueue(chunk);
                },
                close() {
                  controller.close();
                },
                abort(reason) {
                  controller.error(reason);
                },
              }),
            )
            .catch(() => {});
        },
      })
    : rest;

  // Stream the body straight through — no buffering of the whole movie.
  return new Response(body, { status: upstream.status, headers });
});
