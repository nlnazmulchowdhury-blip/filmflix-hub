/**
 * MovieBox (AOneRoom / moviebox.ph) provider integration — admin only.
 *
 * The provider's mobile-app API requires no static key: every request is
 * signed with the client's own token scheme (X-Client-Token) and an
 * HMAC-MD5 x-tr-signature computed from the gateway secret, mirroring what
 * the official app does. The signature secret is a constant bundled with
 * that app, so it lives here as a constant (never a user secret).
 *
 * Endpoints & shapes reverse-engineered from the movie-box project
 * (https://github.com/parthmax2/movie-box) and its recorded fixtures:
 *   search   POST /wefeed-mobile-bff/subject-api/search
 *            { keyword, page, perPage, subjectType } -> { items: [...] }
 *   detail   GET  /wefeed-mobile-bff/subject-api/get?subjectId=…
 *   downloads GET /wefeed-mobile-bff/subject-api/resource?subjectId=…&resolution=0&page=1&perPage=20
 *            -> { list: [{ resolution, resourceLink, size, … }] }
 */
"use node";

import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createHmac, createHash } from "node:crypto";
import {
  fetchWebDetail,
  fetchWebDownloads,
  REGION_BLOCK_HINT,
  isRegionBlock,
} from "./mbWeb";

/* ------------------------------------------------------------------ */
/* Role gate — reuses movieApi.userRoleById (queries can't live in a
   "use node" file, only actions can).                                 */
/* ------------------------------------------------------------------ */

async function requireAdminId(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const role = await ctx.runQuery(internal.movieApi.userRoleById, { userId });
  if (role !== "admin") throw new Error("Admin access required");
}

/* ------------------------------------------------------------------ */
/* Signing (mirrors the official Android client)                       */
/* ------------------------------------------------------------------ */

/** Gateway secrets embedded in the official app (public, not user secrets). */
const GATEWAY_SECRET_DEFAULT =
  "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";

const HOST_POOL = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api4sg.aoneroom.com",
  "https://api3.aoneroom.com",
  "https://api6sg.aoneroom.com",
  "https://api.inmoviebox.com",
];

const SEARCH_PATH = "/wefeed-mobile-bff/subject-api/search";
const SUBJECT_GET_PATH = "/wefeed-mobile-bff/subject-api/get";

function md5Hex(data: string): string {
  return createHash("md5").update(data, "utf8").digest("hex");
}

function xClientToken(ts: number): string {
  return `${ts},${md5Hex(String(ts).split("").reverse().join(""))}`;
}

function sortedQuery(url: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  // Values are NOT percent-encoded in the canonical string.
  return params.map(([k, v2]) => `${k}=${v2}`).join("&");
}

function xTrSignature(
  method: string,
  accept: string,
  contentType: string,
  url: string,
  body: string | null,
  ts: number,
): string {
  const u = new URL(url);
  const query = sortedQuery(url);
  const canonicalUrl = query ? `${u.pathname}?${query}` : u.pathname;
  let bodyHash = "";
  let bodyLength = "";
  if (body !== null) {
    const bytes = Buffer.from(body, "utf8");
    const truncated = bytes.subarray(0, 102_400);
    bodyHash = createHash("md5").update(truncated).digest("hex");
    bodyLength = String(bytes.length);
  }
  const canonical =
    `${method.toUpperCase()}\n` +
    `${accept}\n` +
    `${contentType}\n` +
    `${bodyLength}\n` +
    `${ts}\n` +
    `${bodyHash}\n` +
    `${canonicalUrl}`;
  const key = Buffer.from(GATEWAY_SECRET_DEFAULT, "base64");
  const mac = createHmac("md5", key).update(canonical, "utf8").digest();
  return `${ts}|2|${mac.toString("base64")}`;
}

const ANDROID_VERSIONS = [
  { version: "9", build: "PQ3A.190605.03081104" },
  { version: "10", build: "QP1A.191005.007.A3" },
  { version: "11", build: "RP1A.200720.011" },
  { version: "12", build: "S1B.220414.015" },
  { version: "13", build: "TQ2A.230405.003" },
];
const DEVICES = [
  { model: "23078RKD5C", brand: "Redmi" },
  { model: "2201117TY", brand: "Redmi" },
  { model: "22101316G", brand: "Redmi" },
  { model: "M2012K11AG", brand: "Redmi" },
  { model: "M2007J20CG", brand: "Redmi" },
];
const VERSION_CODES = [50020042, 50020043, 50020044, 50020045, 50020046];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomHex(len: number): string {
  let s = "";
  const chars = "0123456789abcdef";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

function clientIdentity(): { userAgent: string; clientInfo: string } {
  const android = pick(ANDROID_VERSIONS);
  const device = pick(DEVICES);
  const versionCode = pick(VERSION_CODES);
  const deviceId = randomHex(32);
  const gaid = crypto.randomUUID();
  const userAgent =
    `com.community.oneroom/${versionCode} (Linux; U; Android ${android.version}; ` +
    `en_US; ${device.model}; Build/${android.build}; Cronet/135.0.7012.3)`;
  const clientInfo = JSON.stringify({
    package_name: "com.community.oneroom",
    version_name: "3.0.03.0529.03",
    version_code: versionCode,
    os: "android",
    os_version: android.version,
    install_ch: "ps",
    device_id: deviceId,
    install_store: "ps",
    gaid,
    brand: device.brand,
    model: device.model,
    system_language: "en",
    net: "NETWORK_WIFI",
    region: "US",
    timezone: "Asia/Kolkata",
    sp_code: "40401",
    "X-Play-Mode": "2",
  });
  return { userAgent, clientInfo };
}

/* ------------------------------------------------------------------ */
/* Signed request helpers                                              */
/* ------------------------------------------------------------------ */

const RETRY_STATUS = new Set([403, 407, 429, 500, 502, 503, 504]);

/** Guest bearer token issued via the x-user response header by the
 *  unauthenticated bootstrap endpoint (mirrors the official app).
 *  Cached per isolate; refreshed whenever a fresh x-user shows up. */
let runtimeToken: string | null = null;

const BOOTSTRAP_PATH = "/wefeed-mobile-bff/tab-operating";

function signedHeaders(
  method: "GET" | "POST",
  finalUrl: string,
  accept: string,
  contentType: string,
  body: string | null,
  identity: { userAgent: string; clientInfo: string },
): Record<string, string> {
  const ts = Date.now();
  const headers: Record<string, string> = {
    "User-Agent": identity.userAgent,
    Accept: accept,
    "Content-Type": contentType,
    Connection: "keep-alive",
    "X-Client-Token": xClientToken(ts),
    "x-tr-signature": xTrSignature(method, accept, contentType, finalUrl, body, ts),
    "X-Client-Info": identity.clientInfo,
    "X-Client-Status": "0",
  };
  if (runtimeToken) headers.Authorization = `Bearer ${runtimeToken}`;
  return headers;
}

async function rawRequest(
  method: "GET" | "POST",
  finalUrl: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<{ status: number; statusText: string; text: string; xUser: string }> {
  const res = await fetch(finalUrl, {
    method,
    headers,
    body: method === "POST" ? (body ?? "") : undefined,
  });
  const text = await res.text();
  let xUser = "";
  try {
    xUser = res.headers.get("x-user") ?? "";
  } catch {
    xUser = "";
  }
  return { status: res.status, statusText: res.statusText, text, xUser };
}

/** Absorb a fresh guest token from an x-user response header. */
function absorbXUser(xUser: string): void {
  if (!xUser) return;
  try {
    const payload = JSON.parse(xUser);
    const token = payload?.token;
    if (token) runtimeToken = String(token);
  } catch {
    /* header wasn't JSON — ignore */
  }
}

/** One-time guest bootstrap: the home-tab endpoint is the one call the API
 *  accepts without a bearer and it issues a token via x-user. */
async function ensureGuestToken(base: string): Promise<void> {
  if (runtimeToken) return;
  const identity = clientIdentity();
  const accept = "application/json";
  const contentType = "application/json";
  const url = `${base}${BOOTSTRAP_PATH}?page=1&tabId=0&version=`;
  const res = await rawRequest(
    "GET",
    url,
    signedHeaders("GET", url, accept, contentType, null, identity),
    null,
  );
  absorbXUser(res.xUser);
}

async function mbRequest(
  method: "GET" | "POST",
  base: string,
  path: string,
  opts: { params?: Record<string, string>; body?: string } = {},
): Promise<any> {
  await ensureGuestToken(base);

  const identity = clientIdentity();
  const accept = "application/json";
  const contentType = method === "POST" ? "application/json;charset=UTF-8" : "application/json";
  const url = new URL(`${base}${path}`);
  for (const [k, v2] of Object.entries(opts.params ?? {})) {
    url.searchParams.set(k, v2);
  }
  const finalUrl = url.toString();
  const res = await rawRequest(
    method,
    finalUrl,
    signedHeaders(method, finalUrl, accept, contentType, opts.body ?? null, identity),
    opts.body ?? null,
  );
  absorbXUser(res.xUser);

  if (res.status === 441 || res.status === 401) {
    // Token rejected — refresh once via bootstrap and retry this request.
    runtimeToken = null;
    await ensureGuestToken(base);
    const retry = await rawRequest(
      method,
      finalUrl,
      signedHeaders(method, finalUrl, accept, contentType, opts.body ?? null, identity),
      opts.body ?? null,
    );
    absorbXUser(retry.xUser);
    const rJson = safeJson(retry.text);
    if (rJson !== undefined) return extractData(rJson, path);
    throw new Error(`MovieBox API ${retry.status} ${retry.statusText} @ ${path}`);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`MovieBox API ${res.status} ${res.statusText} @ ${path}`);
  }
  const json = safeJson(res.text);
  if (json === undefined) {
    throw new Error(`MovieBox API returned non-JSON from ${path}`);
  }
  return extractData(json, path);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractData(json: any, path: string): any {
  if (json && typeof json === "object" && "code" in json) {
    if (json.code !== 0) {
      throw new Error(
        `MovieBox API error (code ${json.code}): ${String(json.message ?? "").slice(0, 160)}`,
      );
    }
    return json.data ?? json;
  }
  return json;
}

/** Try each host in the pool until one answers without a retryable error.
 *  `preferred` (e.g. the host that won during search) is tried first. */
async function mbRequestAny(
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, string>; body?: string } = {},
  preferred?: string,
): Promise<{ base: string; data: any }> {
  const pool = preferred
    ? [preferred, ...HOST_POOL.filter((h) => h !== preferred)]
    : HOST_POOL;
  let lastErr: unknown = null;
  for (const base of pool) {
    try {
      const data = await mbRequest(method, base, path, opts);
      return { base, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr = err;
      // Transport-level failures and retryable statuses are worth retrying
      // on the next mirror; provider-side logic errors (e.g. empty search)
      // are not, but we can't distinguish reliably — cheap enough to retry.
      if (!/50[0234]|40[37]|429|fetch failed|network/.test(msg)) {
        throw err;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("সব MovieBox সার্ভার চেষ্টা করা হয়েছে, কোনোটা সাড়া দেয়নি");
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface MbSearchHit {
  subjectId: string;
  title: string;
  year?: number;
  posterUrl?: string;
  overview?: string;
  rating?: number;
  kind: "movie" | "series";
  genre?: string;
  durationSeconds?: number;
  countryName?: string;
}

function numYear(date?: string): number | undefined {
  const y = Number(date?.slice(0, 4));
  return Number.isFinite(y) && y > 1800 ? y : undefined;
}

export const searchAction = action({
  args: { q: v.string() },
  handler: async (ctx, { q }): Promise<MbSearchHit[]> => {
    await requireAdminId(ctx);
    const body = JSON.stringify({
      keyword: q,
      page: 1,
      perPage: 20,
      subjectType: 0,
    });
    const { data } = await mbRequestAny("POST", SEARCH_PATH, { body });
    const items: any[] = Array.isArray(data?.items) ? data.items : [];
    const hits: MbSearchHit[] = [];
    for (const it of items) {
      if (!it?.title || !it?.subjectId) continue;
      hits.push({
        subjectId: String(it.subjectId),
        title: String(it.title),
        year: numYear(it.releaseDate),
        posterUrl: it.cover?.url || undefined,
        overview: it.description || undefined,
        rating:
          it.imdbRatingValue !== undefined &&
          it.imdbRatingValue !== null &&
          it.imdbRatingValue !== ""
            ? Number(it.imdbRatingValue)
            : undefined,
        kind: Number(it.subjectType) === 2 ? "series" : "movie",
        genre: Array.isArray(it.genre)
          ? it.genre.join(", ")
          : typeof it.genre === "string"
            ? it.genre
            : undefined,
        durationSeconds:
          typeof it.durationSeconds === "number"
            ? it.durationSeconds
            : typeof it.duration === "number"
              ? it.duration
              : undefined,
        countryName: it.countryName || undefined,
      });
    }
    return hits.slice(0, 20);
  },
});

/* ------------------------------------------------------------------ */
/* Download resources (per-quality mp4 links)                          */
/* ------------------------------------------------------------------ */

async function fetchDetail(
  subjectId: string,
  preferred?: string,
): Promise<any> {
  const { data } = await mbRequestAny(
    "GET",
    SUBJECT_GET_PATH,
    { params: { subjectId } },
    preferred,
  );
  return data;
}

/* ------------------------------------------------------------------ */
/* Import into the catalog                                             */
/* ------------------------------------------------------------------ */

export interface MbImportResult {
  movieId: string;
  /** Number of download entries actually saved (real files, or Trailer). */
  downloads: number;
  title: string;
  /** What the player will actually show. */
  videoKind: "movie" | "trailer" | "none";
  detailError?: string;
  resourceError?: string;
}

/** A file below this size is not a movie — the provider hands anonymous
 *  (guest-token) sessions the same ~1 MB sample clip for every title.
 *  Real movie files are hundreds of MB; trailers are 5–100 MB. The web
 *  download response reports each file's exact size, so this check needs
 *  no byte-probing. */
const MIN_REAL_BYTES = 20 * 1024 * 1024;

export const importMovie = action({
  args: {
    subjectId: v.string(),
    base: v.optional(v.string()), // winning host from search, speeds things up
    // Search-hit metadata — used when the detail call fails so the import
    // never lands in the catalog as "Untitled".
    fallback: v.optional(
      v.object({
        title: v.string(),
        year: v.optional(v.number()),
        posterUrl: v.optional(v.string()),
        overview: v.optional(v.string()),
        rating: v.optional(v.number()),
        kind: v.optional(v.union(v.literal("movie"), v.literal("series"))),
        genre: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { subjectId, base, fallback }): Promise<MbImportResult> => {
    await requireAdminId(ctx);

    const preferred = base || undefined;
    // Detail (fresh metadata) then resources (per-quality files) — each goes
    // through the per-host fallback pool; failures are reported, not hidden.
    let detail: any = null;
    let detailError: string | undefined;
    try {
      detail = await fetchDetail(subjectId, preferred);
    } catch (err) {
      detailError = err instanceof Error ? err.message : String(err);
    }

    let resourceError: string | undefined;
    let webFiles: Array<{ label: string; sizeBytes?: number }> = [];
    try {
      webFiles = await fetchWebDownloads(subjectId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The provider geo-blocks data-center IPs on the download endpoint
      // (403 "invalid region") — see the region note in mbWeb.ts. Say so
      // plainly instead of a raw status code.
      resourceError = isRegionBlock(msg) ? REGION_BLOCK_HINT : msg;
    }

    const title: string = detail?.title ?? fallback?.title ?? "Untitled";
    const year = numYear(detail?.releaseDate) ?? fallback?.year;
    const poster: string | undefined =
      detail?.cover?.url ?? fallback?.posterUrl;
    const backdrop: string | undefined =
      detail?.cover?.url && detail.cover.width >= detail.cover.height
        ? detail.cover.url
        : undefined;
    const rating =
      detail?.imdbRatingValue !== undefined &&
      detail?.imdbRatingValue !== null &&
      detail?.imdbRatingValue !== ""
        ? Number(detail.imdbRatingValue)
        : fallback?.rating;
    const genre: string | undefined =
      Array.isArray(detail?.genre)
        ? detail.genre.join(", ")
        : typeof detail?.genre === "string"
          ? detail.genre
          : fallback?.genre;
    const description: string | undefined =
      detail?.description || fallback?.overview;
    const kind: "movie" | "series" =
      detail?.subjectType !== undefined
        ? Number(detail.subjectType) === 2
          ? "series"
          : "movie"
        : (fallback?.kind ?? "movie");
    // The mobile API serves anonymous sessions ONE shared ~1 MB sample clip
    // for every title — its file list is useless for playback. The REAL
    // full-movie files come from the web endpoint (Referer-locked, works
    // anonymously — see mbWeb.ts). Store stable mbres:// references, never
    // the provider's short-lived signed URLs.

    // Real movie = file big enough to not be the shared sample. The web
    // response's `size` field is exact, so no byte-probing is needed.
    const realFiles = webFiles.filter(
      (f) => (f.sizeBytes ?? Infinity) >= MIN_REAL_BYTES,
    );

    // Fallback: the official trailer from the WEB detail (the mobile detail
    // sometimes carries the shared sample as its "trailer").
    let trailerUrl: string | undefined;
    try {
      const webDetail = await fetchWebDetail(subjectId);
      const t =
        webDetail?.subject?.trailer?.VideoAddress ??
        webDetail?.subject?.trailer?.videoAddress;
      const u = t?.url;
      if (
        typeof u === "string" &&
        u.startsWith("https://") &&
        !u.includes("/other/") // the shared sample lives under /other/
      ) {
        trailerUrl = u;
      }
    } catch {
      // web detail failed — trailer stays undefined
    }

    // Player source: prefer a real movie file (highest resolution), else the
    // trailer — but never the shared placeholder sample.
    const candidates = [...realFiles].sort(
      (a, b) => Number(b.label) - Number(a.label),
    );
    let mainVideo: string | undefined = candidates[0]
      ? `mbres://${subjectId}/${candidates[0].label}`
      : trailerUrl;
    let videoKind: "movie" | "trailer" | "none" = candidates[0]
      ? "movie"
      : trailerUrl
        ? "trailer"
        : "none";

    const movieId = await ctx.runMutation(internal.movies.addInternal, {
      title: year ? `${title} (${year})` : title,
      description,
      posterUrl: poster,
      backdropUrl: backdrop,
      videoUrl: mainVideo,
      genre,
      year,
      rating: rating !== undefined && Number.isFinite(rating) ? rating : undefined,
      kind,
      downloads:
        realFiles.length > 0
          ? realFiles.map((f) => ({
              label: f.label,
              url: `mbres://${subjectId}/${f.label}`,
            }))
          : trailerUrl
            ? [{ label: "Trailer", url: trailerUrl }]
            : undefined,
    });

    return {
      movieId,
      downloads:
        realFiles.length > 0 ? realFiles.length : trailerUrl ? 1 : 0,
      title,
      videoKind,
      detailError,
      resourceError,
    };
  },
});
