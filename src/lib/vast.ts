/** HilltopAds VAST pre-roll.
 *
 *  The zone hands out a VAST tag, not a banner snippet: it answers with XML that
 *  names a video file, an ad length and the tracking URLs the network has to see
 *  for the impression to count. Two things follow from that:
 *   - the tag and its wrappers are fetched through our own byte pipe, because an
 *     ad server sends no `Access-Control-Allow-Origin` and the browser would
 *     refuse the document;
 *   - the file is played by *our* element, so the film's volume, seek bar and
 *     server chips are never handed to the network's player.
 */
import { API_BASE } from "@/lib/api";

export const HILLTOP_ZONE = "7535233";

/** The tag as issued for zone #7535233 (VAST invocation). */
export const HILLTOP_VAST_TAG =
  "https://unfolded-uncle.com/d.mOFwzBdgGeN-vTZEGQUT/xeVmk9/u/ZTUMlTkEPHTzcn1WM/zdUNyuMEz/M/tPNEzkUHzgNBTsIEz/NywK";

export const HILLTOP_BANNER_ZONE = "7535489";

/** Zone #7535489 hands out a player snippet, but that snippet is only a wrapper:
 *  the file it loads ends by calling itself with this VAST url. Asking the VAST
 *  directly is the same impression, and it keeps the creative inside our own
 *  element instead of a network player we cannot style or silence. */
export const HILLTOP_BANNER_VAST_TAG =
  "https://unfoldedtrade.com/dZmaF.zbd-GdNevfZgG_Ui/jcknlN-ynYozp1q2_YsXtNu0va-Wx0ymzcA2_lCkDPESFZ-6HbI2J5Kl_aMWNQO9PN-zRUSzTNUT_QW5XNYwZ";

/** TEST KNOB — seconds every pre-roll is pinned to. Above 0 the ad ignores the
 *  film's first frame and runs this long, closing itself at that second. The way
 *  out is not part of this knob: Skip always opens after five seconds no matter
 *  how long the ad is held. Set back to 0 for the shipped rule: the ad dies the
 *  moment a frame of the movie arrives. */
export const AD_TEST_SECONDS = 0;

export interface VastAd {
  /** The creative itself — a progressive file we can point a `<video>` at. */
  videoUrl: string;
  mimeType: string;
  /** Seconds, from the document's `Duration`; 0 when it did not say. */
  duration: number;
  /** Seconds after which a skip is owed, or null when the ad is unskippable. */
  skipOffset: number | null;
  clickThrough: string | null;
  impressions: string[];
  /** The document's `Error` beacon, reported when the creative never plays. */
  errorUrl: string | null;
  /** Every `Tracking` event the document names, keyed by its event name. */
  trackings: Record<string, string[]>;
}

const pipe = (url: string) => `${API_BASE}/embed/proxy?url=${encodeURIComponent(url)}`;

function firstText(doc: Document | Element, tag: string): string {
  const el = doc.getElementsByTagName(tag)[0];
  return el?.textContent?.trim() ?? "";
}

/** `00:01:30.4`, `90.5` or `90s` → seconds. */
function parseClock(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  if (s.includes(":"))
    return s
      .split(":")
      .reduce((acc, part) => acc * 60 + (Number.parseFloat(part.replace(/[^\d.]/g, "")) || 0), 0);
  return Number.parseFloat(s.replace(/[^\d.]/g, "")) || 0;
}

/** `SkipOffset` is either a clock, a bare second count, or a percentage of the ad. */
function parseOffset(raw: string, total: number): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.endsWith("%")) {
    const pct = Number.parseFloat(s);
    return Number.isFinite(pct) ? (Math.max(0, Math.min(100, pct)) / 100) * total : null;
  }
  return parseClock(s);
}

async function getXml(url: string, signal: AbortSignal): Promise<Document | null> {
  try {
    const res = await fetch(pipe(url), { signal });
    if (!res.ok) return null;
    const body = await res.text();
    /* A pipe that answers with our own error JSON is a miss, not an ad. */
    if (!body.trimStart().startsWith("<")) return null;
    const doc = new DOMParser().parseFromString(body, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  } catch {
    return null;
  }
}

/** The tallest H.264 rendition at or below 480 high: an ad that buffers is worse
 *  for the viewer and for the network's count than one that plays at 480p, and
 *  H.264 is the only codec every browser in this player can be sure of. */
function pickMedia(root: Element): { url: string; mime: string } | null {
  const rows = [...root.getElementsByTagName("MediaFile")]
    .map((el) => {
      const url = el.textContent?.trim() ?? "";
      const mime = (el.getAttribute("type") ?? inferMime(url)).toLowerCase();
      const codec = (el.getAttribute("codec") ?? "").toLowerCase();
      const w = Number.parseInt(el.getAttribute("width") ?? "0", 10) || 0;
      const h = Number.parseInt(el.getAttribute("height") ?? "0", 10) || 0;
      const mp4 = mime.includes("mp4") || mime.includes("avc") || codec.includes("h264");
      return { url, mime, mp4, h: h || w || 0 };
    })
    .filter((r) => /^https?:\/\//.test(r.url) && r.mime.startsWith("video/"));
  const pool = rows.filter((r) => r.mp4);
  const candidates = pool.length ? pool : rows;
  if (!candidates.length) return null;
  const bySize = candidates.sort((a, b) => a.h - b.h);
  return bySize.find((r) => r.h <= 480) ?? bySize[0];
}

function inferMime(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  return "video/mp4";
}

/** Ask for the zone's VAST document, following one wrapper hop if it redirects.
 *
 *  A real answer carries several `<Ad>` elements, each with its own creative,
 *  impressions and skip point, so every field is read from inside one `<Ad>` —
 *  reading the document as a whole would pair one ad's file with another's
 *  tracking and the network would be told the wrong thing played. */
export async function fetchHilltopVastAds(
  signal: AbortSignal,
  tag: string = HILLTOP_VAST_TAG,
): Promise<VastAd[]> {
  let doc = await getXml(tag, signal);
  if (!doc) return [];
  for (let hop = 0; hop < 2; hop++) {
    const next = firstText(doc, "VASTAdTagURI") || firstText(doc, "VASTAdTagURL");
    if (!next) break;
    doc = await getXml(next, signal);
    if (!doc) return [];
  }

  const ads: VastAd[] = [];
  for (const ad of [...doc.getElementsByTagName("Ad")]) {
    const media = pickMedia(ad);
    if (!media) continue;
    const duration = parseClock(firstText(ad, "Duration"));
    /* VAST 2 wrote `<SkipOffset>`; 3 and 4 put it on the `Linear` element, and
       this zone uses the attribute. */
    const skipRaw =
      firstText(ad, "SkipOffset") ||
      ad.getElementsByTagName("Linear")[0]?.getAttribute("skipoffset") ||
      "";
    const trackings: Record<string, string[]> = {};
    for (const el of [...ad.getElementsByTagName("Tracking")]) {
      const event = (el.getAttribute("event") ?? "").toLowerCase();
      const url = el.textContent?.trim() ?? "";
      if (!event || !url) continue;
      (trackings[event] ??= []).push(url);
    }
    ads.push({
      videoUrl: media.url,
      mimeType: media.mime,
      duration,
      skipOffset: parseOffset(skipRaw, duration),
      clickThrough: firstText(ad, "ClickThrough") || null,
      impressions: [...ad.getElementsByTagName("Impression")]
        .map((el) => el.textContent?.trim() ?? "")
        .filter(Boolean),
      errorUrl: firstText(ad, "Error") || null,
      trackings,
    });
  }
  return ads;
}

/** The first creative the zone hands back — what the pre-roll plays. */
export async function fetchHilltopVast(
  signal: AbortSignal,
  tag: string = HILLTOP_VAST_TAG,
): Promise<VastAd | null> {
  return (await fetchHilltopVastAds(signal, tag))[0] ?? null;
}

/** VAST tracking is a plain GET. The macros are the only ones that matter here:
 *  an unexpanded `[CACHEBUSTING]` makes the network's counter drop the hit. */
export function expandMacros(url: string): string {
  return url
    .replace(/\[CACHEBUSTING\]/gi, String(Math.floor(Math.random() * 1e10)).padStart(10, "0"))
    .replace(/\[TIMESTAMP\]/gi, new Date().toISOString())
    .replace(/\[PLAYERSIZE\]/gi, `${window.innerWidth}x${window.innerHeight}`)
    .replace(/\[CONTENTPLAYHEAD\]/gi, "00:00:00.000")
    .replace(/\[[A-Z0-9_]+\]/gi, "");
}

export function ping(urls: string[] | undefined) {
  for (const raw of urls ?? []) {
    const url = expandMacros(raw);
    if (!/^https?:\/\//.test(url)) continue;
    const img = new Image();
    img.referrerPolicy = "no-referrer-when-downgrade";
    img.src = url;
  }
}
