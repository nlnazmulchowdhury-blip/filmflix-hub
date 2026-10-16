/**
 * Embed → stream resolver client ("Server 3").
 *
 * Detects third-party embed URLs (vidapi.ru, vidbox.wtf, vidcloud mirrors, …)
 * and asks the Worker to walk the embed's iframe/redirect chain and hand back
 * the raw .m3u8 candidates, which the native player then plays ad-free.
 * The Worker mirrors the "m3u8 Sniffer" browser extension: the extension
 * sniffs the requests a real browser makes; the Worker resolves what it can
 * server-side and fails over to the iframe view for token-handshake hosts.
 */
import { api, API_BASE } from "@/lib/api";
import { isHlsUrl } from "@/lib/video-url";

/** Hosts that serve a player page (not a stream) — candidates for resolution. */
const EMBED_HOST_SUFFIXES = [
  "vidlink.pro",
  "nxsha.app",
  "vidapi.ru",
  "vaplayer.ru",
  "vidbox.wtf",
  "vidbox.tv",
  "vidshare.day",
  "vidshare.club",
  "vidshare.win",
  "vidcloud.pro",
  "vidcloud.icu",
  "vidcloud9.com",
  "vidplay.top",
  "vidplay.net",
  "viclof.com",
  "nextgencloudfabric.com",
  "rubystream.xyz",
  "vidsrc.xyz",
  "vidsrc.to",
  "vidsrc.cc",
  "vidsrc.de",
  "vidsrc.wtf",
];

export interface EmbedCandidate {
  url: string;
  via: string;
}

export interface EmbedResolveResult {
  candidates: EmbedCandidate[];
  hops: string[];
  error?: string;
}

export function isEmbedUrl(raw: string | null | undefined): boolean {
  const url = (raw ?? "").trim();
  if (!url || isHlsUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return EMBED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  } catch {
    return false;
  }
}

/** Ask the Worker to resolve an embed page URL to playable stream candidates. */
export async function resolveEmbedStream(
  embedUrl: string,
): Promise<EmbedResolveResult> {
  return api.get<EmbedResolveResult>(
    `/embed/stream?url=${encodeURIComponent(embedUrl.trim())}`,
  );
}

/** Is this provider page actually alive?
 *
 *  Providers answer their own error pages for ids they do not carry (vidlink.pro
 *  500s and serves a Next.js "Application error" wall), which then fills our
 *  iframe. The Worker's provider pipe echoes the upstream status, so one
 *  status-only request tells us whether this server is worth showing at all.
 *
 *  `null` means "unknown": the probe itself never answered (Worker blip, offline
 *  viewer). Callers must treat that as alive — mistaking a failed probe for a
 *  dead provider would walk viewers off servers that work fine. */
export async function probeEmbedPage(embedUrl: string): Promise<boolean | null> {
  const target = (embedUrl ?? "").trim();
  if (!target) return false;
  try {
    const res = await fetch(`${API_BASE}/embed/proxy?url=${encodeURIComponent(target)}`);
    /* Never read the body — release the 80KB page we only probed for status. */
    void res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return null;
  }
}

export interface EmbedQuality {
  label: string;
  url: string;
}

export interface EmbedQualitiesResult {
  kind: "hls" | "direct" | "empty";
  entries: EmbedQuality[];
  error?: string;
}

/** Ask the Worker to read a stream URL's master playlist and list resolutions. */
export async function fetchEmbedQualities(
  streamUrl: string,
): Promise<EmbedQualitiesResult> {
  return api.get<EmbedQualitiesResult>(
    `/embed/qualities?url=${encodeURIComponent(streamUrl.trim())}`,
  );
}

export interface TitleDownloadProvider {
  name: string;
  entries: { label: string; url: string }[];
}

/** Ask the Worker to probe every server-side-extractable provider for this
 *  title — powers the Download menu on iframe-only embed servers. */
export async function fetchTitleDownloads(ids: {
  tmdbId?: string | number | null;
  imdbId?: string | null;
  kind?: "movie" | "series" | null;
  season?: number;
  episode?: number;
}): Promise<TitleDownloadProvider[]> {
  const q = new URLSearchParams();
  if (ids.tmdbId) q.set("tmdb", String(ids.tmdbId));
  if (ids.imdbId) q.set("imdb", ids.imdbId);
  q.set("kind", ids.kind === "series" ? "tv" : "movie");
  if (ids.season) q.set("season", String(ids.season));
  if (ids.episode) q.set("episode", String(ids.episode));
  const r = await api.get<{ providers?: TitleDownloadProvider[] }>(
    `/embed/downloads?${q.toString()}`,
  );
  return r.providers ?? [];
}
