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
import { api } from "@/lib/api";
import { isHlsUrl } from "@/lib/video-url";

/** Hosts that serve a player page (not a stream) — candidates for resolution. */
const EMBED_HOST_SUFFIXES = [
  "vidlink.pro",
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
