#!/usr/bin/env node
/**
 * FilmFlix Relay — zero-dependency HLS re-streamer (Node 18+).
 *
 * Takes local / private-IP HLS streams (e.g. http://10.200.13.14/live/ch1/index.m3u8)
 * and re-serves them from this relay's own public origin, so they play over HTTPS
 * from ANY network (mobile data, other ISPs, networks that block private IPs/FTP).
 *
 * Routes:
 *   /api/stream/<ch>    -> range-aware progressive video streaming (seek/resume,
 *                          HTTP 206 Partial Content, Accept-Ranges: bytes)
 *   /c/<channel>        -> channel entry from channels.json (nice URLs for the app)
 *   /r/<base64url(url)> -> generic hop to any upstream playlist or segment
 *   /healthz            -> ok
 *
 * How it works:
 *   - Playlists (.m3u8) are fetched upstream and rewritten so EVERY nested URI
 *     (segments, variant playlists, keys, maps) points back at this relay.
 *   - Segments (.ts/.m4s/...) are proxied and cached in an in-memory LRU, so
 *     N simultaneous viewers still cost the upstream roughly one playback.
 *   - Video files (.mp4/.mkv/...) and /api/stream requests are streamed chunk
 *     by chunk with full HTTP Range support: the upstream timeout only covers
 *     response HEADERS — once headers arrive the body streams without a hard
 *     deadline (an idle watchdog replaces it), so long playback never dies
 *     mid-stream and players can seek/resume via Range requests.
 *
 * Run:   node relay.mjs        (config via .env next to this file or env vars)
 * Test:  node selftest.mjs     (offline self-test, no real stream needed)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Minimal .env loader (no dependency): fills process.env if not already set. */
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    /* no .env file is fine */
  }
}
loadEnvFile(path.join(HERE, ".env"));

const int = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

const CFG = {
  host: process.env.RELAY_HOST || "127.0.0.1",
  port: int(process.env.RELAY_PORT, 8077),
  // Optional shared secret: when set, every URL must carry ?k=<token>.
  token: process.env.RELAY_TOKEN || "",
  channelsPath:
    process.env.RELAY_CHANNELS_PATH || path.join(HERE, "channels.json"),
  cacheMaxBytes: int(process.env.RELAY_CACHE_MAX_MB, 600) * 1024 * 1024,
  playlistTtlMs: int(process.env.RELAY_PLAYLIST_TTL_MS, 1000),
  /** HEADERS timeout only — never kills a streaming body. */
  upstreamTimeoutMs: int(process.env.RELAY_UPSTREAM_TIMEOUT_MS, 10000),
  /** Kill a stream when no bytes flow for this long (stalled upstream). */
  streamIdleTimeoutMs: int(process.env.RELAY_STREAM_IDLE_TIMEOUT_MS, 30000),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// channels.json — { "<name>": "<upstream m3u8 url>" | { url, headers } }
// Hot-reloaded whenever the file's mtime changes (no restart needed).
// ---------------------------------------------------------------------------

let channelsCache = { mtimeMs: -1, data: new Map() };

function getChannels() {
  try {
    const st = fs.statSync(CFG.channelsPath);
    if (st.mtimeMs !== channelsCache.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(CFG.channelsPath, "utf8"));
      const data = new Map();
      for (const [name, val] of Object.entries(raw)) {
        const entry =
          typeof val === "string"
            ? { url: String(val).trim(), headers: {} }
            : { url: String(val?.url ?? "").trim(), headers: val?.headers ?? {} };
        if (entry.url) data.set(name, entry);
      }
      channelsCache = { mtimeMs: st.mtimeMs, data };
      log(`channels.json loaded (${data.size} channel${data.size === 1 ? "" : "s"})`);
    }
  } catch (err) {
    channelsCache = { mtimeMs: -1, data: new Map() };
    log("channels.json error:", err.message);
  }
  return channelsCache.data;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const enc = (u) => Buffer.from(u, "utf8").toString("base64url");
const dec = (s) => Buffer.from(s, "base64url").toString("utf8");

function resolveRef(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

function looksLikePlaylist(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return p.endsWith(".m3u8") || p.endsWith(".m3u");
  } catch {
    return false;
  }
}

const VIDEO_EXTS = [".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".flv", ".3gp", ".ogv"];

/** Big progressive video files must stream, never buffer whole into the LRU. */
function looksLikeVideoFile(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return VIDEO_EXTS.some((ext) => p.endsWith(ext));
  } catch {
    return false;
  }
}

function guessVideoType(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".webm")) return "video/webm";
    if (p.endsWith(".mkv")) return "video/x-matroska";
    if (p.endsWith(".mov")) return "video/quicktime";
    if (p.endsWith(".ogv")) return "video/ogg";
    return "video/mp4";
  } catch {
    return "video/mp4";
  }
}

/** Public origin the player will see (behind Nginx we trust X-Forwarded-*). */
function publicBase(req) {
  const proto = (
    req.headers["x-forwarded-proto"] ||
    (req.socket.encrypted ? "https" : "http")
  )
    .split(",")[0]
    .trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function refFor(base, upstreamUrl) {
  const suffix = CFG.token ? `?k=${encodeURIComponent(CFG.token)}` : "";
  return `${base}/r/${enc(upstreamUrl)}${suffix}`;
}

// ---------------------------------------------------------------------------
// HLS playlist rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite every URI in an M3U8 so it points back at this relay:
 *  - bare lines (segments / variant playlists)  -> /r/<b64url(resolved)>
 *  - URI="..." attributes (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, ...)
 * Relative refs are resolved against the UPSTREAM playlist URL first.
 */
function rewritePlaylist(text, playlistUrl, base) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI=(?:"([^"]*)"|'([^']*)')/g, (_m, dq, sq) => {
          const u = dq !== undefined ? dq : sq;
          return `URI="${refFor(base, resolveRef(playlistUrl, u))}"`;
        });
      }
      // Non-comment, non-empty line = a URI (segment or nested playlist).
      return refFor(base, resolveRef(playlistUrl, t));
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Simple byte-bounded LRU for segment buffers ({ body, type }). */
class Lru {
  constructor(maxBytes) {
    this.max = maxBytes;
    this.map = new Map();
    this.bytes = 0;
  }
  get(key) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    this.map.delete(key);
    this.map.set(key, v); // touch for LRU order
    return v;
  }
  set(key, val) {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.body.length;
      this.map.delete(key);
    }
    this.map.set(key, val);
    this.bytes += val.body.length;
    while (this.bytes > this.max && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      this.bytes -= this.map.get(oldest).body.length;
      this.map.delete(oldest);
    }
  }
}

const segCache = new Lru(CFG.cacheMaxBytes); // upstream segment URL -> { body, type }
const playlistCache = new Map(); // upstream URL -> { text, finalUrl, at }

function playlistCacheSet(key, val) {
  if (playlistCache.size > 1000) {
    const oldest = playlistCache.keys().next().value;
    playlistCache.delete(oldest);
  }
  playlistCache.set(key, val);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range, Origin, Content-Type",
};

function cors(extra) {
  return { ...CORS, "cache-control": "no-store", ...extra };
}

function sendText(res, status, text) {
  res.writeHead(status, cors({ "content-type": "text/plain; charset=utf-8" }));
  res.end(text);
}

function sendPlaylist(res, body, extra = {}) {
  res.writeHead(
    200,
    cors({
      "content-type": "application/vnd.apple.mpegurl",
      ...extra,
    }),
  );
  res.end(body);
}

/**
 * Fetch an upstream with a HEADERS-ONLY timeout: AbortSignal.timeout would
 * also kill a healthy mid-stream body after 10s, so instead we arm a timer
 * that is cleared the moment response headers arrive. The body then streams
 * freely (callers add their own idle watchdog when streaming).
 */
function fetchUpstream(url, extraHeaders = {}, req) {
  const headers = { "user-agent": "FilmFlixRelay/1.0", ...extraHeaders };
  if (req?.headers?.range) headers.range = req.headers.range;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("upstream headers timeout")),
    CFG.upstreamTimeoutMs,
  );
  return fetch(url, { headers, redirect: "follow", signal: controller.signal }).then(
    (res) => {
      clearTimeout(timer);
      return res;
    },
    (err) => {
      clearTimeout(timer);
      throw err;
    },
  );
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

async function servePlaylist(upstreamUrl, extraHeaders, req, res) {
  const base = publicBase(req);

  const cached = playlistCache.get(upstreamUrl);
  if (cached && Date.now() - cached.at < CFG.playlistTtlMs) {
    return sendPlaylist(res, rewritePlaylist(cached.text, cached.finalUrl, base));
  }

  let r;
  try {
    r = await fetchUpstream(upstreamUrl, extraHeaders, req);
  } catch (err) {
    log("playlist fetch failed:", upstreamUrl, "-", err.message);
    return sendText(res, 502, "Upstream playlist unreachable");
  }
  if (!r.ok) {
    return sendText(res, r.status, `Upstream returned HTTP ${r.status}`);
  }

  const finalUrl = r.url || upstreamUrl;
  const text = await r.text();
  if (!/^#EXTM3U/.test(text.trim())) {
    return sendText(res, 502, "Upstream did not return an M3U8 playlist");
  }
  playlistCacheSet(upstreamUrl, { text, finalUrl, at: Date.now() });
  sendPlaylist(res, rewritePlaylist(text, finalUrl, base));
}

async function serveSegment(upstreamUrl, extraHeaders, req, res) {
  // Byte-range: stream straight through, no caching.
  if (req.headers.range) {
    let r;
    try {
      r = await fetchUpstream(upstreamUrl, extraHeaders, req);
    } catch (err) {
      log("range fetch failed:", upstreamUrl, "-", err.message);
      return sendText(res, 502, "Upstream unreachable");
    }
    const headers = {
      "content-type": r.headers.get("content-type") || "video/mp2t",
      "accept-ranges": "bytes",
    };
    const cl = r.headers.get("content-length");
    if (cl) headers["content-length"] = cl;
    const cr = r.headers.get("content-range");
    if (cr) headers["content-range"] = cr;
    res.writeHead(r.status, cors(headers));
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
    return;
  }

  const hit = segCache.get(upstreamUrl);
  if (hit) {
    res.writeHead(
      200,
      cors({ "content-type": hit.type, "content-length": hit.body.length }),
    );
    return res.end(hit.body);
  }

  let r;
  try {
    r = await fetchUpstream(upstreamUrl, extraHeaders, req);
  } catch (err) {
    log("segment fetch failed:", upstreamUrl, "-", err.message);
    return sendText(res, 502, "Upstream unreachable");
  }
  if (!r.ok) {
    return sendText(res, r.status, `Upstream returned HTTP ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const type = r.headers.get("content-type") || "video/mp2t";

  // Some upstreams serve playlists without an .m3u8 extension — sniff and rewrite.
  if (buf.subarray(0, 7).toString("utf8") === "#EXTM3U") {
    return sendPlaylist(
      res,
      rewritePlaylist(buf.toString("utf8"), r.url || upstreamUrl, publicBase(req)),
    );
  }

  segCache.set(upstreamUrl, { body: buf, type });
  res.writeHead(
    200,
    cors({ "content-type": type, "content-length": buf.length }),
  );
  res.end(buf);
}

function serveResource(upstreamUrl, extraHeaders, req, res) {
  if (looksLikePlaylist(upstreamUrl)) {
    return servePlaylist(upstreamUrl, extraHeaders, req, res);
  }
  if (looksLikeVideoFile(upstreamUrl)) {
    return serveFileStream(upstreamUrl, extraHeaders, req, res);
  }
  return serveSegment(upstreamUrl, extraHeaders, req, res);
}

// ---------------------------------------------------------------------------
// Range-aware progressive video streaming (seek / resume / 206)
// ---------------------------------------------------------------------------

/** Parse "bytes=a-b" (also open-ended "bytes=a-" and suffix "bytes=-n"). */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {
    // suffix range: last N bytes
    const n = parseInt(m[2], 10);
    if (n === 0 || size <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return { invalid: true, size };
  }
  return { start, end, size };
}

/**
 * Stream a video file through the relay with full HTTP Range semantics:
 *  - HEAD -> same headers, no body (players probe this first)
 *  - no Range -> 200 with Accept-Ranges: bytes (whole file, chunked)
 *  - Range -> 206 Partial Content + Content-Range, seek/resume anywhere
 *  - unsatisfiable range -> 416 with "Content-Range: bytes STAR/size"
 * The upstream timeout covers headers only; the body streams with an idle
 * watchdog instead of a hard deadline, so long playback never dies at 10s.
 */
async function serveFileStream(upstreamUrl, extraHeaders, req, res) {
  const rangeHeader = req.headers.range;

  // ---- HEAD preflight: cheap length/type lookup --------------------------
  if (req.method === "HEAD") {
    let r;
    try {
      r = await fetchUpstream(upstreamUrl, { ...extraHeaders, method: "HEAD" }, req);
    } catch {
      return sendText(res, 502, "Upstream unreachable");
    }
    try { await r.body?.cancel(); } catch { /* ignore */ }
    if (!r.ok) return sendText(res, r.status, `Upstream returned HTTP ${r.status}`);
    const len = r.headers.get("content-length");
    const headers = {
      "content-type": r.headers.get("content-type") || guessVideoType(upstreamUrl),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    };
    if (len) headers["content-length"] = len;
    res.writeHead(200, cors(headers));
    return res.end();
  }

  // ---- decide the byte window we need from upstream ----------------------
  // First ask the upstream (ranged when the client asked for a range) so we
  // learn the full size from Content-Range even when serving a sub-window.
  const upInit = { ...extraHeaders };
  if (rangeHeader) upInit.range = rangeHeader;

  let r;
  try {
    r = await fetchUpstream(upstreamUrl, upInit, req);
  } catch (err) {
    log("stream fetch failed:", upstreamUrl, "-", err.message);
    return sendText(res, 502, "Upstream unreachable");
  }

  const contentType = r.headers.get("content-type") || guessVideoType(upstreamUrl);
  const contentRange = r.headers.get("content-range");

  // Full size: prefer upstream Content-Range "bytes a-b/size", else Content-Length.
  let totalSize = 0;
  if (contentRange) {
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) totalSize = parseInt(m[1], 10);
  }
  if (!totalSize) {
    const cl = parseInt(r.headers.get("content-length") || "0", 10);
    if (cl) totalSize = cl + (contentRange ? parseInt(contentRange, 10) : 0);
  }
  // Fall back: probe upstream size with a 1-byte ranged request.
  if (!totalSize) {
    try {
      await r.body?.cancel();
    } catch { /* ignore */ }
    try {
      const probe = await fetchUpstream(
        upstreamUrl,
        { ...extraHeaders, range: "bytes=0-1" },
        req,
      );
      try { await probe.body?.cancel(); } catch { /* ignore */ }
      const pr = probe.headers.get("content-range");
      const pm = pr ? /\/(\d+)\s*$/.exec(pr) : null;
      if (pm) totalSize = parseInt(pm[1], 10);
    } catch { /* leave 0 */ }
    if (!totalSize) {
      return sendText(res, 502, "Upstream did not report a size (no Content-Range/Length)");
    }
    // Re-issue the client's actual range request now that we know the size.
    const retry = { ...extraHeaders };
    if (rangeHeader) retry.range = rangeHeader;
    try {
      r = await fetchUpstream(upstreamUrl, retry, req);
    } catch (err) {
      log("stream retry failed:", upstreamUrl, "-", err.message);
      return sendText(res, 502, "Upstream unreachable");
    }
  }

  const clientRange = parseRange(rangeHeader, totalSize);

  if (clientRange?.invalid) {
    return sendText(res, 416, "Requested range not satisfiable");
  }

  if (!rangeHeader) {
    // Whole file: answer 200 with the upstream body streamed through.
    const headers = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "content-length": String(totalSize),
      "cache-control": "no-store",
    };
    res.writeHead(200, cors(headers));
    if (!r.body) return res.end();
    return pipeWithWatchdog(Readable.fromWeb(r.body), res, upstreamUrl);
  }

  // ---- client asked for a range ------------------------------------------
  if (r.status !== 206 && r.status !== 200) {
    return sendText(res, r.status, `Upstream returned HTTP ${r.status}`);
  }

  // When the upstream ignored our Range (200 + full body), slice locally.
  let body = r.body;
  let start = clientRange.start;
  let end = clientRange.end;
  const upstreamHonored = r.status === 206;
  if (!upstreamHonored && start > 0) {
    // Skip the leading bytes on the wire.
    const stream = Readable.fromWeb(body);
    let skipped = 0;
    stream.on("data", function onData(chunk) {
      skipped += chunk.length;
      if (skipped < start) return; // still before the window
      const over = skipped - start;
      const head = over > 0 ? chunk.subarray(chunk.length - over) : chunk;
      stream.pause();
      const headers = {
        "content-type": contentType,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${totalSize}`,
        "content-length": String(end - start + 1),
        "cache-control": "no-store",
      };
      res.writeHead(206, cors(headers));
      res.write(head);
      stream.removeListener("data", onData);
      stream.pipe(res);
      stream.resume();
    });
    stream.on("end", () => {
      if (!res.headersSent) {
        res.writeHead(206, cors({
          "content-type": contentType,
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${totalSize}`,
          "content-length": String(end - start + 1),
          "cache-control": "no-store",
        }));
        res.end();
      }
    });
    return;
  }

  const headers = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "content-range": `bytes ${start}-${end}/${totalSize}`,
    "content-length": String(end - start + 1),
    "cache-control": "no-store",
  };
  res.writeHead(206, cors(headers));
  if (!body) return res.end();
  return pipeWithWatchdog(Readable.fromWeb(body), res, upstreamUrl);
}

/** Pipe the upstream body to the client; abort when bytes stop flowing. */
function pipeWithWatchdog(stream, res, label) {
  let idleTimer = null;
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log("stream idle timeout:", label);
      stream.destroy();
      res.destroy();
    }, CFG.streamIdleTimeoutMs);
  };
  arm();
  stream.on("data", arm);
  stream.on("close", () => clearTimeout(idleTimer));
  stream.on("error", (err) => {
    log("stream error:", label, "-", err.message);
    clearTimeout(idleTimer);
    res.destroy();
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://relay");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors({ "access-control-max-age": "600" }));
      return res.end();
    }

    if (parts[0] === "healthz") {
      return sendText(res, 200, "ok");
    }

    if (CFG.token && url.searchParams.get("k") !== CFG.token) {
      return sendText(res, 403, "Missing or invalid token (k)");
    }

    let upstreamUrl = null;
    let entryHeaders = {};

    if (parts[0] === "api" && parts[1] === "stream" && parts[2]) {
      const entry = getChannels().get(parts[2]);
      if (!entry) {
        return sendText(res, 404, `Unknown channel: ${parts[2]}`);
      }
      upstreamUrl = entry.url;
      entryHeaders = entry.headers;
      return await serveFileStream(upstreamUrl, entryHeaders, req, res);
    }

    if (parts[0] === "c" && parts[1]) {
      const entry = getChannels().get(parts[1]);
      if (!entry) return sendText(res, 404, `Unknown channel: ${parts[1]}`);
      upstreamUrl = entry.url;
      entryHeaders = entry.headers;
    } else if (parts[0] === "r" && parts[1]) {
      try {
        upstreamUrl = dec(parts[1]);
      } catch {
        return sendText(res, 400, "Bad reference");
      }
    } else {
      return sendText(res, 404, "Use /c/<channel> or /healthz");
    }

    await serveResource(upstreamUrl, entryHeaders, req, res);
  } catch (err) {
    log("request error:", err.stack || err.message);
    if (!res.headersSent) sendText(res, 500, "Relay error");
    else res.destroy();
  }
});

server.listen(CFG.port, CFG.host, () => {
  log(`FilmFlix relay listening on http://${CFG.host}:${CFG.port}`);
  log(`channels file: ${CFG.channelsPath}`);
  log(CFG.token ? "token: REQUIRED (?k=...)" : "token: open (set RELAY_TOKEN to lock it)");
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}