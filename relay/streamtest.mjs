#!/usr/bin/env node
/**
 * Range-streaming test for relay.mjs (offline, fake video upstream).
 *
 * Verifies on /api/stream/<ch> and /r/<b64>:
 *   1. no Range  -> 200 + Accept-Ranges: bytes + full body
 *   2. bytes=0-99    -> 206 + Content-Range + exact slice
 *   3. seek bytes=N- -> 206 + correct slice from the middle
 *   4. suffix bytes=-50 -> last 50 bytes
 *   5. out-of-range  -> 416
 *   6. HEAD          -> 200 + Accept-Ranges + content-length, no body
 *   7. body keeps flowing > headers-timeout window (no 10s cut)
 */

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UP_PORT = 22000 + Math.floor(Math.random() * 20000);
const RELAY_PORT = 42000 + Math.floor(Math.random() * 20000);
const B = `http://127.0.0.1:${RELAY_PORT}`;

// 1 MiB fake "video" with a recognizable byte pattern per KiB block.
const TOTAL = 1024 * 1024;
const VIDEO = Buffer.alloc(TOTAL);
for (let k = 0; k < TOTAL / 1024; k++) {
  VIDEO.fill(k & 0xff, k * 1024, (k + 1) * 1024);
}

let upstreamServed = 0;
const upstream = http.createServer((req, res) => {
  upstreamServed++;
  const range = req.headers.range;
  const base = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = 0, end = TOTAL - 1;
    if (m) {
      if (m[1] === "") {
        const n = parseInt(m[2], 10);
        start = Math.max(0, TOTAL - n);
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === "" ? TOTAL - 1 : Math.min(parseInt(m[2], 10), TOTAL - 1);
      }
    }
    if (start >= TOTAL || start > end) {
      res.writeHead(416, { ...base, "content-range": `bytes */${TOTAL}` });
      return res.end();
    }
    const slice = VIDEO.subarray(start, end + 1);
    res.writeHead(206, {
      ...base,
      "content-range": `bytes ${start}-${end}/${TOTAL}`,
      "content-length": slice.length,
    });
    // trickle slowly so we can prove the body outlives the headers timeout
    let pos = 0;
    const timer = setInterval(() => {
      const chunk = slice.subarray(pos, pos + 16 * 1024);
      if (chunk.length === 0) {
        clearInterval(timer);
        return res.end();
      }
      pos += chunk.length;
      res.write(chunk);
    }, 100);
    return;
  }
  res.writeHead(200, { ...base, "content-length": TOTAL });
  res.end(VIDEO);
});

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok:", msg);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffstream-"));
const channelsPath = path.join(tmp, "channels.json");
fs.writeFileSync(
  channelsPath,
  JSON.stringify({ movie: `http://127.0.0.1:${UP_PORT}/file.mp4` }),
);

upstream.listen(UP_PORT, "127.0.0.1");

const child = spawn(process.execPath, [path.join(here, "relay.mjs")], {
  env: {
    ...process.env,
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: String(RELAY_PORT),
    RELAY_CHANNELS_PATH: channelsPath,
    // deliberately SHORT headers-timeout: body must survive way beyond it
    RELAY_UPSTREAM_TIMEOUT_MS: "500",
    RELAY_STREAM_IDLE_TIMEOUT_MS: "5000",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${B}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay did not start");
}

const text = async (r) => Buffer.from(await r.arrayBuffer());

try {
  await waitReady();
  const streamUrl = `${B}/api/stream/movie`;

  // 1. full body, 200
  const full = await fetch(streamUrl);
  assert(full.status === 200, `no-range -> 200 (got ${full.status})`);
  assert(full.headers.get("accept-ranges") === "bytes", "200 carries Accept-Ranges: bytes");
  const fullBuf = await text(full);
  assert(fullBuf.length === TOTAL, `200 body is the whole file (${fullBuf.length})`);
  assert(fullBuf.equals(VIDEO), "200 body byte-exact");

  // 2. first 100 bytes
  const first = await fetch(streamUrl, { headers: { range: "bytes=0-99" } });
  assert(first.status === 206, `bytes=0-99 -> 206 (got ${first.status})`);
  assert(
    first.headers.get("content-range") === `bytes 0-99/${TOTAL}`,
    `Content-Range ok (${first.headers.get("content-range")})`,
  );
  assert(first.headers.get("accept-ranges") === "bytes", "206 carries Accept-Ranges: bytes");
  const firstBuf = await text(first);
  assert(firstBuf.length === 100 && firstBuf.equals(VIDEO.subarray(0, 100)), "0-99 slice exact");

  // 3. seek into the middle
  const mid = await fetch(streamUrl, { headers: { range: "bytes=524288-" } });
  assert(mid.status === 206, "seek bytes=524288- -> 206");
  const midBuf = await text(mid);
  assert(midBuf.equals(VIDEO.subarray(524288)), "mid seek slice byte-exact");

  // 4. suffix range
  const tail = await fetch(streamUrl, { headers: { range: "bytes=-50" } });
  assert(tail.status === 206, "suffix bytes=-50 -> 206");
  const tailBuf = await text(tail);
  assert(tailBuf.equals(VIDEO.subarray(TOTAL - 50)), "suffix slice = last 50 bytes");

  // 5. unsatisfiable
  const bad = await fetch(streamUrl, { headers: { range: "bytes=99999999-" } });
  assert(bad.status === 416, "out-of-range -> 416");

  // 6. HEAD
  const head = await fetch(streamUrl, { method: "HEAD" });
  assert(head.status === 200, "HEAD -> 200");
  assert(head.headers.get("accept-ranges") === "bytes", "HEAD advertises Accept-Ranges");
  assert(head.headers.get("content-length") === String(TOTAL), "HEAD content-length");

  // 7. the 10s-killer regression: headers timeout is 500ms here; if the old
  //    AbortSignal.timeout behaviour came back, this ~2.5s body would die.
  const slowStart = Date.now();
  const slow = await fetch(streamUrl, { headers: { range: "bytes=0-163839" } }); // 160 KB @ 16KB/100ms = 1s
  const slowBuf = await text(slow);
  const took = Date.now() - slowStart;
  assert(
    slowBuf.length === 163840 && slowBuf.equals(VIDEO.subarray(0, 163840)),
    `streamed body intact after ${took}ms (headers timeout was 500ms)`,
  );
  assert(took >= 900, `body flowed well past the headers timeout (${took}ms)`);

  console.log(process.exitCode ? "STREAMTEST FAILED" : "STREAMTEST PASSED");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  upstream.close(() => process.exit(process.exitCode || 0));
  setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
}