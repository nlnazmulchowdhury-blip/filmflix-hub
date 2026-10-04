#!/usr/bin/env node
/**
 * FilmFlix Relay — offline self-test (no real stream / internet needed).
 *
 * Spins up:
 *   - a fake HLS upstream (master playlist -> media playlist -> segment)
 *   - the real relay.mjs as a child process
 * then checks token enforcement, playlist rewriting, nested playlists,
 * segment byte pass-through and unknown-channel handling.
 *
 * Run:  node selftest.mjs
 */

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UP_PORT = 21000 + Math.floor(Math.random() * 20000);
const RELAY_PORT = 41000 + Math.floor(Math.random() * 20000);
const TOKEN = "s3cret";
const K = `?k=${TOKEN}`;
const B = `http://127.0.0.1:${RELAY_PORT}`;

const SEG = Buffer.concat([Buffer.from("FILMFLIX-SEG-"), Buffer.alloc(4096, 7)]);
const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nindex.m3u8\n";
const media =
  "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n";

const upstream = http.createServer((req, res) => {
  if (req.url === "/live/master.m3u8") {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    return res.end(master);
  }
  if (req.url === "/live/index.m3u8") {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    return res.end(media);
  }
  if (req.url === "/live/seg1.ts") {
    res.writeHead(200, {
      "content-type": "video/mp2t",
      "content-length": SEG.length,
    });
    return res.end(SEG);
  }
  res.writeHead(404);
  res.end("nope");
});

upstream.listen(UP_PORT, "127.0.0.1");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffrelay-"));
const channelsPath = path.join(tmp, "channels.json");
fs.writeFileSync(
  channelsPath,
  JSON.stringify({
    test: `http://127.0.0.1:${UP_PORT}/live/index.m3u8`,
    test_master: `http://127.0.0.1:${UP_PORT}/live/master.m3u8`,
  }),
);

const child = spawn(process.execPath, [path.join(here, "relay.mjs")], {
  env: {
    ...process.env,
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: String(RELAY_PORT),
    RELAY_TOKEN: TOKEN,
    RELAY_CHANNELS_PATH: channelsPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write("[relay] " + d));
child.stderr.on("data", (d) => process.stderr.write("[relay] " + d));

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${B}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay did not start");
}

/** Last non-comment line of an M3U8 = a URI the relay must have rewritten. */
const lastUri = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .pop();

try {
  await waitReady();
  assert((await (await fetch(`${B}/healthz`))).status === 200, "healthz");

  // 1. Token enforced
  const noTok = await fetch(`${B}/c/test`);
  assert(noTok.status === 403, `missing token must 403 (got ${noTok.status})`);

  // 2. Media playlist rewritten, segment reachable through /r/
  const pl = await (await fetch(`${B}/c/test${K}`)).text();
  assert(pl.includes("#EXTM3U"), "playlist body passes through");
  const segRef = lastUri(pl);
  assert(
    segRef?.startsWith(`${B}/r/`) && segRef.endsWith(K),
    `segment line must be rewritten to /r/ ref with token, got: ${segRef}`,
  );
  const seg = Buffer.from(await (await fetch(segRef)).arrayBuffer());
  assert(seg.equals(SEG), "segment bytes must pass through unchanged");

  // 3. Master playlist -> variant playlist (nested rewrite via /r/)
  const mpl = await (await fetch(`${B}/c/test_master${K}`)).text();
  const variantRef = lastUri(mpl);
  assert(
    variantRef?.startsWith(`${B}/r/`),
    `variant line must be rewritten, got: ${variantRef}`,
  );
  const vpl = await (await fetch(variantRef)).text();
  const segRef2 = lastUri(vpl);
  assert(segRef2?.startsWith(`${B}/r/`), "nested playlist must be rewritten too");
  const seg2 = Buffer.from(await (await fetch(segRef2)).arrayBuffer());
  assert(seg2.equals(SEG), "nested segment bytes must match");

  // 4. Unknown channel -> 404
  const nf = await fetch(`${B}/c/nope${K}`);
  assert(nf.status === 404, `unknown channel must 404 (got ${nf.status})`);

  console.log(process.exitCode ? "SELFTEST FAILED" : "SELFTEST PASSED");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  upstream.close(() => process.exit(process.exitCode || 0));
  setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
}