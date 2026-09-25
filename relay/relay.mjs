#!/usr/bin/env node
/**
 * FilmFlix Relay — zero-dependency HLS re-streamer (Node 18+).
 *
 * Takes local / private-IP HLS streams (e.g. http://10.200.13.14/live/ch1/index.m3u8)
 * and re-serves them from this relay's own public origin, so they play over HTTPS
 * from ANY network (mobile data, other ISPs, networks that block private IPs/FTP).
 *
 * Routes:
 *   /c/<channel>        -> channel entry from channels.json (nice URLs for the app)
 *   /r/<base64url(url)> -> generic hop to any upstream playlist or segment
 *   /healthz            -> ok
 *
 * How it works:
 *   - Playlists (.m3u8) are fetched upstream and rewritten so EVERY nested URI
 *     (segments, variant playlists, keys, maps) points back at this relay.
 *   - Segments (.ts/.m4s/...) are proxied and cached in an in-memory LRU, so
 *     N simultaneous viewers still cost the upstream roughly one playback.
 *   - Byte-range requests are streamed straight through without caching.
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
  upstreamTimeoutMs: int(process.env.RELAY_UPSTREAM_TIMEOUT_MS, 10000),
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

function fetchUpstream(url, extraHeaders = {}, req) {
  const headers = { "user-agent": "FilmFlixRelay/1.0", ...extraHeaders };
  if (req?.headers?.range) headers.range = req.headers.range;
  return fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(CFG.upstreamTimeoutMs),
  });
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
  return serveSegment(upstreamUrl, extraHeaders, req, res);
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