/**
 * Embed → stream resolver client ("Server 3").
 *
 * Detects third-party embed URLs (vidlink.pro, vixsrc.to, vidcloud mirrors, …)
 * and asks the Worker to walk the embed's iframe/redirect chain and hand back
 * the raw .m3u8 candidates, which the native player then plays ad-free.
 * The Worker mirrors the "m3u8 Sniffer" browser extension: the extension
 * sniffs the requests a real browser makes; the Worker resolves what it can
 * server-side and fails over to the iframe view for token-handshake hosts.
 */
import { api } from "@/lib/api";
import { browserDecodesHevc } from "@/lib/playback-health";
import {
  nxshaEmbedUrl,
  screenscapeEmbedUrl,
  vidboxEmbedUrl,
  vidukiEmbedUrl,
  vixsrcEmbedUrl,
  type EmbedTarget,
} from "@/lib/vaplayer";
import { isHlsUrl } from "@/lib/video-url";

/** Hosts that serve a player page (not a stream) — candidates for resolution. */
const EMBED_HOST_SUFFIXES = [
  "vidlink.pro",
  "nxsha.app",
  "vixsrc.to",
  /* Extracted through its own scraper API now, so its streams can join the
     race instead of only being framed. */
  "vidnest.fun",
  /* Its fourth API frames play.xpass.top, whose ladder list the Worker opens
     server-side; both hosts are player pages, never a stream. */
  "viduki.net",
  "xpass.top",
  "nhdapi.com",
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
  /** Resolution label the provider attached, when it offered one. */
  quality?: string;
  /** `"dash"` is an MPD served through the Worker's own pipe: its segments are
   *  named relatively, so only the path-shaped pipe can carry it. */
  kind?: "hls" | "file" | "dash";
  /** What the Worker actually read off the stream, not what the provider claims. */
  codec?: "h264" | "hevc" | "unknown";
  /** False means the CDN refuses the player's own fetch — only the provider's
   *  session can read it, so it cannot take over our native element. */
  cors?: boolean;
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

/** Asks currently in flight, keyed by the Worker request. Opening a server chip
 *  a moment after the menu's warm-up race started would otherwise ask the same
 *  provider page twice — the answer is minted for one session either way. */
const streamAsks = new Map<string, Promise<EmbedResolveResult>>();

/** Answers already paid for, kept briefly: a chip switch, a remount or the
 *  resolver effect re-running asks the same page again, and a provider walk
 *  costs seconds. Only a real answer is kept — a miss must stay askable — and
 *  the moment a resolved link dies in the player every entry is dropped, so a
 *  retry asks the providers again instead of replaying the dead link. */
const ANSWERS_TTL_MS = 120_000;
const answers = new Map<string, { at: number; value: EmbedResolveResult }>();
/** Asks made in this window skip the Worker's edge cache (`fresh=1`). */
let freshUntil = 0;

export function forgetEmbedStreams(): void {
  answers.clear();
  streamAsks.clear();
  freshUntil = Date.now() + 5_000;
}

function remembered(ask: string): EmbedResolveResult | null {
  const hit = answers.get(ask);
  if (!hit) return null;
  if (Date.now() - hit.at > ANSWERS_TTL_MS) {
    answers.delete(ask);
    return null;
  }
  return hit.value;
}

/** One resolver ask, deduped in flight and remembered for a couple of minutes. */
function askResolver(ask: string): Promise<EmbedResolveResult> {
  const known = remembered(ask);
  if (known) return Promise.resolve(known);
  const running = streamAsks.get(ask);
  if (running) return running;
  const url = Date.now() < freshUntil
    ? `${ask}${ask.includes("?") ? "&" : "?"}fresh=1`
    : ask;
  const prom = api
    .get<EmbedResolveResult>(url)
    .then((value) => {
      if (value.candidates?.length) answers.set(ask, { at: Date.now(), value });
      return value;
    })
    .finally(() => streamAsks.delete(ask));
  streamAsks.set(ask, prom);
  return prom;
}

/** Ask the Worker to resolve an embed page URL to playable stream candidates. */
export async function resolveEmbedStream(
  embedUrl: string,
): Promise<EmbedResolveResult> {
  const q = new URLSearchParams({ url: embedUrl.trim() });
  /* Providers hold some titles only as HEVC. Only this browser knows whether it
     can decode that, and the Worker must not guess: say so once, and a title
     that would otherwise show the provider's player runs under our controls. */
  if (browserDecodesHevc()) q.set("hevc", "1");
  return askResolver(`/embed/stream?${q.toString()}`);
}

/** Start the provider walks for a title *before* its player mounts.
 *
 *  A card can tell the next route which title is about to open, and the route
 *  itself needs a beat for its own data before the player exists — that beat is
 *  free resolving time. Every ask here is the one the race would make, deduped
 *  in flight and remembered, so a warm card costs nothing extra when the player
 *  finally asks. */
export function warmTitleStreams(target: EmbedTarget): void {
  const urls = [
    nxshaEmbedUrl(target),
    vixsrcEmbedUrl(target),
    vidboxEmbedUrl(target),
    vidukiEmbedUrl(target),
    screenscapeEmbedUrl(target),
  ];
  for (const url of urls) if (url) void resolveEmbedStream(url).catch(() => undefined);
}

/** Ask a provider API that needs nothing but the TMDB id for a stream.
 *
 *  Every player page in the lineup builds its playlist URL inside JavaScript
 *  after a token handshake, so the page-walking resolver below can only watch
 *  them load. This route talks to the one back end that answers plain HTTP,
 *  which is where most ad-free wins now come from. */
export async function resolveDirectStream(ids: {
  tmdbId?: string | number | null;
  kind?: "movie" | "series" | null;
  season?: number;
  episode?: number;
}): Promise<EmbedResolveResult> {
  const tmdb = String(ids.tmdbId ?? "").replace(/\D/g, "");
  if (!tmdb) return { candidates: [], hops: [], error: "no TMDB id" };
  const q = new URLSearchParams({ tmdb });
  q.set("kind", ids.kind === "series" ? "tv" : "movie");
  q.set("season", String(ids.season ?? 1));
  q.set("episode", String(ids.episode ?? 1));
  return askResolver(`/embed/direct?${q.toString()}`);
}

/** Can the viewer's own browser fetch this stream?
 *
 *  The Worker's probe only proves Cloudflare could read the link. Providers mint
 *  these URLs for their own session and CDNs answer with different headers from
 *  edge to edge, so a playlist that resolved server-side often 403s — or comes
 *  back without CORS — when hls.js asks for it from the viewer's origin, and the
 *  result is a black player on a title that "worked" in the resolver log. One
 *  request from here, capped at a few KB, is the only test that predicts
 *  playback, so the race refuses to hand over anything that fails it. */
export async function browserStreamUsable(
  url: string,
  /** The Worker read `#EXTM3U` off it: several providers sign their playlist as
   *  `/playlist/{id}?token=…`, so the extension cannot be the test. */
  knownHls = false,
): Promise<boolean> {
  let res: Response;
  try {
    /* No Range header: it turns the request into a preflighted one, and a
       provider that only sets CORS on GET then fails this test while hls.js —
       which sends a plain GET — plays it fine. The body is cancelled after the
       head either way. */
    res = await fetch(url, { signal: AbortSignal.timeout(9_000) });
  } catch {
    return false;
  }
  if (!res.ok && res.status !== 206) {
    void res.body?.cancel().catch(() => undefined);
    return false;
  }
  /* A media file is proven as far as this test goes; only a playlist has to
     actually be a playlist (a blocked request answers with an HTML wall). */
  if (!knownHls && !isHlsUrl(url)) {
    void res.body?.cancel().catch(() => undefined);
    return true;
  }
  try {
    const reader = res.body?.getReader();
    if (!reader) return false;
    let head = "";
    const decoder = new TextDecoder();
    while (head.length < 2_000) {
      const { value, done } = await reader.read();
      head += decoder.decode(value, { stream: true });
      if (done) break;
    }
    void reader.cancel().catch(() => undefined);
    return head.includes("#EXTM3U");
  } catch {
    return false;
  }
}

/** Is this link one of our own pipes? The Worker already fetched it while
 *  minting the answer, and the page reads it same-origin, so a second browser
 *  probe would only add a round trip before the player may start. */
function isPipedStream(url: string): boolean {
  try {
    const path = new URL(url, window.location.href).pathname;
    return (
      path.endsWith("/embed/proxy") ||
      path.endsWith("/embed/dash") ||
      path.includes("/embed/dash/")
    );
  } catch {
    return false;
  }
}

export interface EmbedRaceResult {
  /** The provider that answered with a stream first, in completion order. */
  win: { url: string; candidates: EmbedCandidate[] } | null;
  /** Last error reported by the chains that did not answer. */
  error: string;
  /** The win came from the direct API, so it belongs to no provider page. */
  direct?: boolean;
}

/** The marker used for the direct API inside the race, so a win there never
 *  looks like a provider page the player should switch to. */
export const DIRECT_RACE_URL = "api:direct";

/**
 * Race every playback source at once and keep whichever answers first, so the
 * viewer waits for the fastest provider instead of one chain after another.
 * Settles as soon as a source yields candidates; failures never hold it back,
 * and a page whose chain is slow is simply dropped.
 *
 * A chain that answers *after* the win is not thrown away: `onReady` still sees
 * its playable links, so the rest of the lineup is loaded by the time the viewer
 * taps another server chip instead of starting a fresh resolve from nothing.
 */
export async function raceEmbedStreams(
  urls: string[],
  direct?: {
    tmdbId?: string | number | null;
    kind?: "movie" | "series" | null;
    season?: number;
    episode?: number;
  } | null,
  onReady?: (ready: { url: string; candidates: EmbedCandidate[] }) => void,
): Promise<EmbedRaceResult> {
  const targets = urls.filter((u) => u && u.trim()).map((u) => u.trim());
  const canAskDirect = Boolean(direct?.tmdbId && String(direct.tmdbId).replace(/\D/g, ""));
  if (!targets.length && !canAskDirect)
    return { win: null, error: "No provider to try." };

  return new Promise<EmbedRaceResult>((resolve) => {
    let pending = targets.length + (canAskDirect ? 1 : 0);
    let settled = false;
    let lastError = "";
    const take = (url: string, candidates: EmbedCandidate[]) => {
      if (settled || !candidates.length) return;
      settled = true;
      resolve({ win: { url, candidates }, error: "", direct: url === DIRECT_RACE_URL });
    };
    const miss = (error: string) => {
      lastError = error || "No stream found behind this provider.";
    };
    const finish = () => {
      if (!settled && --pending === 0) resolve({ win: null, error: lastError });
    };

    /* A provider that answers with links is only a provider that *plays* if the
       viewer's browser can pull them, so every candidate is fetched once from
       here before the race is allowed to settle on it. */
    const accept = async (url: string, cands: EmbedCandidate[], why: string) => {
      if (!cands.length) {
        if (!settled) miss(why);
        return;
      }
      const tested = await Promise.all(
        cands
          .slice(0, 3)
          .map(async (c) => ({
            c,
            ok: isPipedStream(c.url) || (await browserStreamUsable(c.url, c.kind === "hls")),
          })),
      );
      const usable = tested.filter((t) => t.ok).map((t) => t.c);
      if (!usable.length) {
        if (!settled) miss("Its links only answer inside the provider's own session.");
        return;
      }
      onReady?.({ url, candidates: usable });
      take(url, usable);
    };

    if (canAskDirect) {
      resolveDirectStream(direct ?? {})
        .then((r) => accept(DIRECT_RACE_URL, r.candidates ?? [], r.error ?? "The direct API had no stream for this title."))
        .catch(() => miss("Direct resolver request failed."))
        .finally(finish);
    }
    for (const url of targets) {
      resolveEmbedStream(url)
        .then((r) => accept(url, r.candidates ?? [], r.error ?? "No stream found behind this provider."))
        .catch(() => miss("Resolver request failed."))
        .finally(finish);
    }
  });
}

export interface EmbedPageProbe {
  /** The provider answered with a page (as opposed to its own error wall). */
  live: boolean;
  /** The provider's own page says it carries this exact title. Only ever true
   *  on positive evidence — several providers serve a "not available" wall at
   *  HTTP 200, so `live` alone cannot be trusted to mean "worth framing". */
  carried: boolean;
  /** Why a provider was judged dead, when the Worker could say more than
   *  "no page" — shown to the viewer instead of framing a wall they cannot use. */
  reason?: string;
  /** The provider refused *our Worker* (its CDN blocks datacenter egress) while
   *  its page still loads for the viewer's browser. `live` stays true: this is
   *  our reach being limited, not the server being dead. */
  blocked?: boolean;
}

/** Is this provider page actually alive — and really the title it was asked for?
 *
 *  Providers answer their own error pages for ids they do not carry (vidlink.pro
 *  500s and serves a Next.js "Application error" wall, and serves a client-side
 *  "we couldn't find this content" wall at 200), which then fills our iframe.
 *  The Worker reads the page's server-rendered title, which is the only signal
 *  some providers give.
 *
 *  `null` means "unknown": the probe itself never answered (Worker blip, offline
 *  viewer). Callers must treat that as alive — mistaking a failed probe for a
 *  dead provider would walk viewers off servers that work fine. */
export async function probeEmbedPage(
  embedUrl: string,
): Promise<EmbedPageProbe | null> {
  const target = (embedUrl ?? "").trim();
  if (!target) return { live: false, carried: false };
  try {
    return await api.get<EmbedPageProbe>(
      `/embed/pageinfo?url=${encodeURIComponent(target)}`,
    );
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
