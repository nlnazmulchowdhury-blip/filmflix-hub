/**
 * MovieBox WEB (h5) endpoint helpers — shared by the import action and the
 * video-proxy stream resolver.
 *
 * Why the web endpoints: the provider's mobile API only serves real
 * full-movie files to logged-in app sessions. Anonymous (guest-token) calls
 * to the mobile resource endpoint return ONE shared ~1 MB sample clip for
 * every title. The web endpoints, however, work anonymously — the download
 * endpoint is merely Referer-locked: it validates that the Referer URL
 * contains the title's short hash (`/movies/<anything>-<hash>?id=…`).
 *
 * That hash is base62(subjectId) reversed — verified character-exact for
 * two known title/id pairs (titanic, avatar).
 *
 * REGION NOTE (verified by probes): the provider geo-blocks DATA-CENTER
 * IPs on the download endpoint (403 "invalid region") — from the Convex
 * cloud the response is always 403, while browsers on residential IPs get
 * 200. The detail endpoint (metadata + trailer) is NOT blocked.
 *
 * Because a server cannot set the browser's Referer for cross-origin
 * requests (and browser JS cannot spoof it either), full-movie files are
 * only reachable through the admin's own web proxy, configured via the
 * MOVIEBOX_WEB_PROXY Convex env var. Two proxy shapes are supported:
 *   - path passthrough:  https://my-proxy.example
 *        -> https://my-proxy.example/wefeed-h5-bff/web/subject/download?…
 *   - URL query passthrough (base ends with "="):
 *        https://my-proxy.example/?url=
 *        -> https://my-proxy.example/?url=<encoded full provider URL>
 * The proxy must forward the original Referer header (or inject the right
 * one) — e.g. a 10-line Cloudflare Worker or any residential proxy.
 * Without a proxy, imports honestly fall back to the provider's real
 * trailer (never the shared placeholder sample).
 *
 * Signed file URLs returned by the web endpoint expire quickly (the `t=`
 * query parameter), so they are NEVER stored: `videoProxy.ts` re-resolves
 * `mbres://<subjectId>/<resolution>` references at play time via
 * `resolveMovieBoxSigned`.
 */

export const WEB_BASE = "https://h5.aoneroom.com";
export const WEB_API_BASE = "https://h5-api.aoneroom.com";

const WEB_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0";

export function webHash62(subjectId: string): string {
  const ALPHA =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let n: bigint;
  try {
    n = BigInt(subjectId);
  } catch {
    throw new Error(`অবৈধ subjectId: ${subjectId}`);
  }
  let s = "";
  while (n > 0n) {
    s = ALPHA[Number(n % 62n)] + s;
    n /= 62n;
  }
  return [...s].reverse().join("");
}

/** Web page slug for a subject. The title prefix is arbitrary — only the
 *  hash is validated by the provider. */
function webSlug(subjectId: string): string {
  return `m-${webHash62(subjectId)}`;
}

function webHeaders(refererUrl: string): Record<string, string> {
  return {
    "User-Agent": WEB_UA,
    Accept: "application/json",
    Referer: refererUrl,
    "X-Client-Info": JSON.stringify({ timezone: "Africa/Nairobi" }),
  };
}

export const REGION_BLOCK_HINT =
  "প্রোভাইডার সার্ভারের অঞ্চল (data-center IP) ব্লক করেছে — MOVIEBOX_WEB_PROXY এনভায়রনমেন্ট ভেরিয়েবলে নিজের ওয়েব প্রক্সি সেট করলে পুরো মুভি ফাইল ইমপোর্ট হবে";

/** True when the h5 download endpoint answered with its geo-block error. */
export function isRegionBlock(errMsg: string): boolean {
  return /invalid region|web downloads 403|"code":403/.test(errMsg);
}

/** Download endpoint URL for a subject, via the configured web proxy when
 *  one is set (MOVIEBOX_WEB_PROXY), else direct to the provider. */
function downloadEndpoint(subjectId: string): string {
  const direct =
    `${WEB_BASE}/wefeed-h5-bff/web/subject/download` +
    `?subjectId=${subjectId}&se=0&ep=0`;
  const proxy = (process.env.MOVIEBOX_WEB_PROXY ?? "").trim().replace(/\/+$/, "");
  if (!proxy) return direct;
  // "…/?url=" style proxies take the full target URL as a query value.
  if (/[?&](url|u)=$/.test(proxy)) {
    return `${proxy}=${encodeURIComponent(direct)}`;
  }
  // Otherwise the proxy passes the provider path through unchanged.
  return `${proxy}/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=0&ep=0`;
}

/** The web detail page — its `subject.trailer.VideoAddress` is always the
 *  provider's own trailer, never the anonymous-session sample the mobile
 *  detail sometimes carries. */
export async function fetchWebDetail(subjectId: string): Promise<any> {
  const slug = webSlug(subjectId);
  const res = await fetch(
    `${WEB_API_BASE}/wefeed-h5api-bff/detail?detailPath=${slug}`,
    {
      headers: webHeaders(`${WEB_BASE}/movies/${slug}?id=${subjectId}`),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`web detail ${res.status}`);
  const json: any = await res.json();
  if (json?.code !== 0) throw new Error(`web detail error ${json?.code ?? "?"}`);
  return json?.data ?? json;
}

export interface MbWebFile {
  /** Quality label, e.g. "480p". */
  label: string;
  /** Exact file size in bytes when the provider reports it. */
  sizeBytes?: number;
}

/** REAL full-movie per-quality files. Works anonymously with the correct
 *  Referer — but only from a residential IP (or via MOVIEBOX_WEB_PROXY;
 *  see the region note at the top of this file). Response shape:
 *  data.downloads = [{ resolution, size, url }]. */
export async function fetchWebDownloads(
  subjectId: string,
): Promise<MbWebFile[]> {
  const slug = webSlug(subjectId);
  const res = await fetch(downloadEndpoint(subjectId), {
    headers: webHeaders(`${WEB_BASE}/movies/${slug}?id=${subjectId}`),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`web downloads ${res.status}`);
  const json: any = await res.json();
  if (json?.code === 403) throw new Error(`web downloads 403 ${json?.message ?? ""}`);
  if (json?.code !== 0) {
    throw new Error(`web downloads error ${json?.code ?? "?"}`);
  }
  const data = json?.data ?? json;
  const raw: any[] = Array.isArray(data?.downloads)
    ? data.downloads
    : Array.isArray(data?.list)
      ? data.list
      : [];
  const out: MbWebFile[] = [];
  const seen = new Set<number>();
  for (const f of raw) {
    const resNum = Number(f?.resolution);
    if (!Number.isFinite(resNum) || seen.has(resNum)) continue;
    seen.add(resNum);
    const size = Number(f?.size);
    out.push({
      label: `${resNum}p`,
      sizeBytes: Number.isFinite(size) ? size : undefined,
    });
  }
  return out;
}

/** Re-resolve an mbres:// reference into a fresh signed CDN URL. Called by
 *  the video proxy on every playback request (signed URLs expire). One
 *  endpoint call: pick the wanted quality (fall back to the best available)
 *  and return its signed URL. Goes through MOVIEBOX_WEB_PROXY when set. */
export async function resolveMovieBoxSigned(
  subjectId: string,
  resolution: string,
): Promise<string> {
  const slug = webSlug(subjectId);
  const res = await fetch(downloadEndpoint(subjectId), {
    headers: webHeaders(`${WEB_BASE}/movies/${slug}?id=${subjectId}`),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`stream resolve ${res.status}`);
  const json: any = await res.json();
  if (json?.code === 403) throw new Error(`stream resolve 403 ${json?.message ?? ""}`);
  if (json?.code !== 0) {
    throw new Error(`stream resolve error ${json?.code ?? "?"}`);
  }
  const data = json?.data ?? json;
  const raw: any[] = Array.isArray(data?.downloads)
    ? data.downloads
    : Array.isArray(data?.list)
      ? data.list
      : [];
  if (raw.length === 0) {
    throw new Error("provider returned no downloadable files");
  }
  const want = Number(resolution);
  const entry =
    raw.find((f) => Number(f?.resolution) === want) ??
    // fallback: highest resolution available
    [...raw].sort((a, b) => Number(b?.resolution) - Number(a?.resolution))[0];
  const url = entry?.url ?? entry?.resourceLink;
  if (typeof url !== "string" || !url.startsWith("http")) {
    throw new Error("provider returned no signed URL");
  }
  return url;
}
