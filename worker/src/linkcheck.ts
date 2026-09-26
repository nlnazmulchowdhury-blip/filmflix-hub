/** Link-health probing, ported from Convex linkHealth.ts. */
import type { Target } from "./types";

const PROBE_TIMEOUT_MS = 8_000;

export async function probeUrl(url: string): Promise<{
  status: "ok" | "fail";
  httpStatus?: number;
  error?: string;
}> {
  try {
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "FilmFlixLinkCheck/1.0" },
    });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { "user-agent": "FilmFlixLinkCheck/1.0", range: "bytes=0-1" },
      });
    }
    if (res.ok) return { status: "ok", httpStatus: res.status };
    return { status: "fail", httpStatus: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      status: "fail",
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

function addTarget(map: Map<string, Target[]>, url: string | null | undefined, target: Target) {
  const key = url?.trim();
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(target);
  map.set(key, list);
}

export async function collectMovieUrls(db: D1Database) {
  const { results } = await db.prepare(`SELECT id, title, video_url, qualities, dubs, episodes, seasons FROM movies`).all();
  const out: { url: string; target: Target }[] = [];
  for (const r of results ?? []) {
    const t: Target = { kind: "movie", name: r.title as string, movieId: r.id as string };
    for (const u of [r.video_url]) if (u) out.push({ url: u as string, target: t });
    for (const arr of ["qualities", "dubs"] as const) {
      for (const q of r[arr] ? JSON.parse(r[arr] as string) : []) {
        if (q.videoUrl) out.push({ url: q.videoUrl, target: t });
      }
    }
    for (const e of r.episodes ? JSON.parse(r.episodes as string) : []) {
      if (e.videoUrl) out.push({ url: e.videoUrl, target: t });
    }
    for (const s of r.seasons ? JSON.parse(r.seasons as string) : []) {
      for (const e of s.episodes ?? []) {
        if (e.videoUrl) out.push({ url: e.videoUrl, target: t });
      }
    }
  }
  return out;
}

export async function collectTvUrls(db: D1Database) {
  const { results } = await db.prepare(`SELECT id, name, stream_url, backup_urls FROM tv_channels`).all();
  const out: { url: string; target: Target }[] = [];
  for (const r of results ?? []) {
    const t: Target = { kind: "tv", name: r.name as string, channelId: r.id as string };
    if (r.stream_url) out.push({ url: r.stream_url as string, target: t });
    for (const b of r.backup_urls ? JSON.parse(r.backup_urls as string) : []) {
      out.push({ url: b, target: t });
    }
  }
  return out;
}
