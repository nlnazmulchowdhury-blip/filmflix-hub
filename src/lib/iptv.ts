/** Live TV channels, read straight out of the open iptv-org playlist.
 *
 *  iptv-org/iptv (public domain) keeps one master m3u of every publicly
 *  available broadcast stream it can verify — ~11 000 of them — and serves it
 *  from GitHub Pages with `Access-Control-Allow-Origin: *`. So the browser can
 *  read the whole list itself and none of that weight lands on our Worker,
 *  which is the budget the free plan is tight on. The streams a page script is
 *  genuinely not allowed to fetch are the ones we still have to carry: a plain
 *  `http:` URL is blocked as mixed content on our https site, and a published
 *  Referer is a forbidden header. Those ride `/embed/proxy`, the only way they
 *  can play at all.
 */
import { apiBase } from "@/lib/apiConfig";

/** The row shape the /tv page already renders for admin-added channels
 *  (`tvChannels` in the DB), so the two lists merge without a second card. */
export interface LiveChannel {
  _id: string;
  name: string;
  logoUrl?: string;
  streamUrl: string;
  backupUrls?: string[];
  categories?: string[];
  /** Two-letter country code taken from the published channel id. */
  country?: string;
  /** Set when the browser cannot reach the published URL itself. */
  piped?: boolean;
  /** A page to frame instead of a stream to buffer: famelack publishes some
   *  channels only as a YouTube live embed, which no <video> element can play. */
  embedUrl?: string;
}

export interface CountryMeta {
  name: string;
  flag: string;
}

const PLAYLIST_URL = "https://iptv-org.github.io/iptv/index.m3u";
const COUNTRIES_URL = "https://iptv-org.github.io/api/countries.json";

/* Famelack's public dataset (MIT): iptv-org minus the streams their own
   monitoring found dead, plus feeds they verified that iptv-org never
   published. Their whole TV list is one gzipped JSON of 333 KB — a tenth of the
   weight of our iptv-org download — and every stream in it is https, so none of
   it has to ride our pipe. */
const FAMELACK_URL =
  "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/compressed/categories/all.json";
const FAMELACK_PLAIN =
  "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw/categories/all.json";

/* Their playlist is rebuilt every day; three days keeps a returning viewer off
   the 2.5 MB download without showing a feed list that has visibly rotted. */
const FRESH_MS = 3 * 24 * 60 * 60_000;
/* After a failed fetch, a month-old list still beats an empty page. */
const MAX_AGE_MS = 30 * FRESH_MS;

/** How many feeds of one channel are kept as backups. A live URL is down often
 *  enough that the strip's failover is the whole difference between a channel
 *  that plays and one that says "Stream is down". */
const MAX_FEEDS = 4;

/* ---------------------------------------------------------------- cache */

type Entry = { at: number; text: string };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open("ff-iptv", 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("cache")) req.result.createObjectStore("cache");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      /* Private mode / no IndexedDB: the page just pays the download again. */
      resolve(null);
    }
  });
  return dbPromise;
}

function readCache(key: string): Promise<Entry | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const get = db.transaction("cache", "readonly").objectStore("cache").get(key);
          get.onsuccess = () => resolve((get.result as Entry) ?? null);
          get.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function writeCache(key: string, text: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve();
        try {
          const store = db.transaction("cache", "readwrite").objectStore("cache");
          store.put({ at: Date.now(), text } satisfies Entry, key);
          store.transaction.oncomplete = () => resolve();
          store.transaction.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

/* --------------------------------------------------------------- parsing */

const RE_ID = /tvg-id="([^"]*)"/;
const RE_LOGO = /tvg-logo="([^"]*)"/;
const RE_GROUP = /group-title="([^"]*)"/;
const RE_UA = /http-user-agent="([^"]*)"/;
const RE_REF = /http-referrer="([^"]*)"/;
const RE_VLCOPT = /^#EXTVLCOPT:http-(user-agent|referrer)=(.+)$/i;
const RE_SCHEME = /^https?:\/\//i;
const RE_NSFW = /(adult|xxx|porn|18\+)/i;

/** A stream URL a viewer's browser can fetch itself, or our pipe for the ones
 *  that are not allowed to. */
function playTarget(url: string, referer: string): { url: string; piped: boolean } {
  if (/^https:/i.test(url) && !referer) return { url, piped: false };
  const q = new URLSearchParams({ url, rewrite: "1" });
  if (referer) q.set("ref", referer);
  return { url: `${apiBase()}/embed/proxy?${q.toString()}`, piped: true };
}

/** Pixels from the name's quality tag, so the sharpest feed becomes the
 *  primary and the rest only serve as fall-downs. */
function qualityOf(name: string): number {
  const m = name.match(/(\d{3,4})[pi]/i);
  if (m) return Number(m[1]);
  if (/4k|uhd/i.test(name)) return 2160;
  return 0;
}

interface Feed {
  name: string;
  id: string;
  url: string;
  logo: string;
  groups: string[];
  referer: string;
  userAgent: string;
  quality: number;
}

/** iptv-org writes a channel as `#EXTINF:-1 tvg-id="Name.cc@Feed" … ,Name`
 *  followed by optional `#EXTVLCOPT:` header lines and then the URL. The
 *  quoted attributes are stripped before the name is taken because a browser
 *  string like `…(KHTML, like Gecko)…` contains the comma a naive split would
 *  treat as the name separator. */
function parseEntries(text: string): Map<string, Feed[]> {
  const grouped = new Map<string, Feed[]>();
  let pending: Omit<Feed, "url"> | null = null;
  let agent = "";
  let referer = "";

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#EXTINF")) {
      const attrs = line.replace(/[\w-]+="[^"]*"/g, "");
      const comma = attrs.indexOf(",");
      const name = (comma < 0 ? attrs : attrs.slice(comma + 1)).trim();
      if (!name) continue;
      const groups = (RE_GROUP.exec(line)?.[1] ?? "")
        .split(";")
        .map((g) => g.trim())
        .filter((g) => g && g.toLowerCase() !== "undefined");
      pending = {
        name,
        id: RE_ID.exec(line)?.[1]?.trim() ?? "",
        logo: RE_LOGO.exec(line)?.[1] ?? "",
        groups,
        referer: RE_REF.exec(line)?.[1] ?? "",
        userAgent: RE_UA.exec(line)?.[1] ?? "",
        quality: qualityOf(name),
      };
      agent = pending.userAgent;
      referer = pending.referer;
      continue;
    }
    const vlcopt = RE_VLCOPT.exec(line);
    if (vlcopt) {
      if (vlcopt[1].toLowerCase() === "user-agent") agent = vlcopt[2].trim();
      else referer = vlcopt[2].trim();
      continue;
    }
    if (!line.trim() || line.startsWith("#")) continue;
    const url = line.trim();
    if (!pending || !RE_SCHEME.test(url)) {
      /* A URL no player can reach (rtp:, udp:, a bare host) is the provider's
         news, not the viewer's. */
      continue;
    }
    const feed: Feed = { ...pending, url, userAgent: agent, referer };
    pending = null;
    /* Their NSFW feeds live in a separate file, so this only guards against
       the master list one day carrying one. It matches the category, never the
       name: "Adult Swim" is a general-entertainment channel. */
    if (feed.groups.some((g) => RE_NSFW.test(g))) continue;
    /* Feeds of one channel share its id; the `@Feed` suffix is a region or
       time-zone variant of the same channel, so it belongs in the backup list. */
    const key = feed.id ? feed.id.split("@")[0] : `name:${feed.name.toLowerCase()}`;
    const list = grouped.get(key);
    if (list) {
      if (list.length < MAX_FEEDS) list.push(feed);
    } else {
      grouped.set(key, [feed]);
    }
  }
  return grouped;
}

/** iptv-org's id is `<Channel>.<cc>[@Feed]`, and every id in the master list
 *  follows it — that is where the country comes from, since the playlist itself
 *  groups only by category. */
function countryOf(id: string): string {
  const cc = id.split("@")[0].split(".").pop() ?? "";
  return /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : "";
}

export function parsePlaylist(text: string, prefix = "iptv"): LiveChannel[] {
  const out: LiveChannel[] = [];
  for (const [key, feeds] of parseEntries(text)) {
    feeds.sort((a, b) => b.quality - a.quality);
    const primary = feeds[0];
    const targets = feeds.map((f) => playTarget(f.url, f.referer));
    out.push({
      _id: `${prefix}:${key}`,
      name: primary.name,
      logoUrl: primary.logo || undefined,
      streamUrl: targets[0].url,
      backupUrls: targets.slice(1).map((t) => t.url),
      categories: [...new Set(feeds.flatMap((f) => f.groups))],
      country: countryOf(key),
      piped: targets[0].piped,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------- loading */

export interface ChannelLoad {
  channels: LiveChannel[];
  /** True when the list came from the local cache instead of the network. */
  cached: boolean;
  /** True when the network failed and a cache older than FRESH_MS was used. */
  stale: boolean;
}

async function loadCached<T>(
  key: string,
  url: string,
  decode: (text: string) => T,
  grab: (url: string) => Promise<string> = fetchText,
  freshMs = FRESH_MS,
): Promise<{ value: T; cached: boolean; stale: boolean }> {
  const hit = await readCache(key);
  if (hit && Date.now() - hit.at < freshMs) {
    return { value: decode(hit.text), cached: true, stale: false };
  }
  try {
    const text = await grab(url);
    await writeCache(key, text);
    return { value: decode(text), cached: false, stale: false };
  } catch (err) {
    if (hit) return { value: decode(hit.text), cached: true, stale: true };
    throw err;
  }
}

/** The whole iptv-org list, from the local cache when it is fresh. Throws only
 *  when there is nothing cached and the network refused — the page says so
 *  instead of showing an empty channel strip. */
export async function loadChannels(): Promise<ChannelLoad> {
  const r = await loadCached("playlist", PLAYLIST_URL, parsePlaylist);
  return { channels: r.value, cached: r.cached, stale: r.stale };
}

/** Country names and flag emoji for the codes in the channel ids. */
export async function loadCountries(): Promise<Record<string, CountryMeta>> {
  const r = await loadCached("countries", COUNTRIES_URL, (text) => {
    const rows = JSON.parse(text) as { name: string; code: string; flag: string }[];
    const map: Record<string, CountryMeta> = {};
    for (const row of rows) map[row.code.toUpperCase()] = { name: row.name, flag: row.flag };
    return map;
  });
  return r.value;
}

/* ------------------------------------------------------------- famelack */

interface FamelackRow {
  nanoid?: string;
  name?: string;
  country?: string;
  sources?: { streams?: string[]; youtube?: string[] };
}

/** Their file is gzip bytes behind a `.json` name, which a browser can inflate
 *  itself; the plain 2 MB twin is only for engines with no DecompressionStream. */
async function fetchGzipped(gzUrl: string): Promise<string> {
  if (typeof DecompressionStream === "undefined") return fetchText(FAMELACK_PLAIN);
  try {
    const res = await fetch(gzUrl, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok || !res.body) throw new Error(`${gzUrl} -> ${res.status}`);
    const inflated = res.body.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(inflated).text();
  } catch {
    return fetchText(FAMELACK_PLAIN);
  }
}

/** No NSFW name filter here, unlike the iptv-org parse: famelack publishes no
 *  categories, and matching on the name alone would drop "Adult Swim", which is
 *  general entertainment. Their pipeline already removes takedown targets. */
export function parseFamelack(text: string): LiveChannel[] {
  let rows: FamelackRow[];
  try {
    rows = JSON.parse(text) as FamelackRow[];
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: LiveChannel[] = [];
  for (const row of rows) {
    const name = (row?.name ?? "").trim();
    if (!name) continue;
    const streams = (row.sources?.streams ?? []).filter((u) => RE_SCHEME.test(u));
    const embed = (row.sources?.youtube ?? []).find((u) => RE_SCHEME.test(u)) ?? "";
    if (!streams.length && !embed) continue;
    out.push({
      _id: `fam:${row.nanoid || name + (streams[0] ?? embed)}`,
      name,
      streamUrl: streams[0] ?? "",
      backupUrls: streams.slice(1, MAX_FEEDS),
      embedUrl: streams.length ? undefined : embed || undefined,
      country: (row.country ?? "").toUpperCase().slice(0, 2) || undefined,
      categories: [],
    });
  }
  return out;
}

/** The famelack TV dataset, cached like the iptv-org one. */
export async function loadFamelack(): Promise<ChannelLoad> {
  const r = await loadCached("famelack", FAMELACK_URL, parseFamelack, fetchGzipped);
  return { channels: r.value, cached: r.cached, stale: r.stale };
}

/* ------------------------------------------------- owner playlist sources */

/** A list the owner points the page at: their own m3u, an Xtream playlist
 *  export (`get.php?…&type=m3u_plus` answers plain m3u), or a panel's channel
 *  JSON. The declarations live in `public/tv-sources.json`, a static file the
 *  edge serves for free, so a viewer pays nothing for reading them and a new
 *  source is one line — no database table, no Worker change. */
export interface TvSource {
  /** Shown to the viewer when the list does not answer; it is the owner's own
   *  label, never the address behind it. */
  name: string;
  url: string;
  /** Applied to rows the list does not tag itself, so the country picker works. */
  country?: string;
  /** Hours a fetched list stays usable. Short by design: these panels mint
   *  every link with a session token that dies in a few hours, and an old list
   *  is a wall of "Stream is down" cards rather than an honest failure. */
  freshHours?: number;
}

const SOURCES_URL = "/tv-sources.json";
const DEFAULT_SRC_FRESH_HOURS = 1;

/** A file a player can open. A panel's channel row can also be a page. */
const RE_MEDIA = /\.(m3u8|m3u|mpd|mp4|ts|mkv|webm|mov)(\?|$)/i;
const RE_YT = /youtube\.com|youtu\.be/i;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Re-read on every page view: the file is a few hundred bytes, it comes from
 *  our own origin, and a source the owner adds should appear without waiting
 *  for a cached declaration list to expire. */
async function loadSourceList(): Promise<TvSource[]> {
  let text: string;
  try {
    const res = await fetch(SOURCES_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    text = await res.text();
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data as { sources?: unknown })?.sources;
  if (!Array.isArray(list)) return [];
  const out: TvSource[] = [];
  for (const raw of list as Partial<TvSource>[]) {
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name || !RE_SCHEME.test(url)) continue;
    const cc =
      typeof raw?.country === "string" ? raw.country.toUpperCase().replace(/[^A-Z]/g, "") : "";
    out.push({
      name,
      url,
      /* A two-letter code only: "BD", not "Bangladesh", which would become
         "BA" and name a country that is not ours. */
      country: cc.length === 2 ? cc : undefined,
      freshHours: Number.isFinite(raw?.freshHours) ? Number(raw?.freshHours) : undefined,
    });
  }
  return out;
}

/** An https list is read by the viewer's browser when its host allows it, and
 *  by our pipe when it does not — a private panel rarely sends CORS headers. A
 *  plain `http:` list cannot be read from our https page at all, so it always
 *  rides the pipe, and a host no server can route to (a `10.x` box) fails there
 *  honestly instead of hanging. */
async function grabList(url: string): Promise<string> {
  if (/^https:/i.test(url)) {
    try {
      return await fetchText(url);
    } catch {
      /* CORS refused or a dead edge: fall through to the pipe. */
    }
  }
  return fetchText(`${apiBase()}/embed/proxy?url=${encodeURIComponent(url)}`);
}

/** The file a feed link really points at, looking back through our own pipe. */
function upstreamOf(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    return u.pathname.endsWith("/embed/proxy") ? u.searchParams.get("url") || url : url;
  } catch {
    return url;
  }
}

/** iptv-org publishes only stream files, so its parser takes any URL the
 *  playlist names. A private list is not so disciplined: it often writes a
 *  YouTube page or the panel's own web player where a feed should be, and no
 *  buffer can be built from a page. Keep the files, frame the live pages, drop
 *  the row that is neither — a card that can never play is worse than no card. */
function keepPlayable(c: LiveChannel): LiveChannel | null {
  const feeds = ownFeeds(c);
  const media = feeds.filter((u) => {
    const up = upstreamOf(u);
    return RE_MEDIA.test(up) || up.includes("/live/");
  });
  if (media.length) {
    const [head, ...rest] = media;
    return { ...c, streamUrl: head, backupUrls: rest, embedUrl: undefined, piped: head.includes("/embed/proxy") };
  }
  const page = feeds.find((u) => RE_YT.test(upstreamOf(u)));
  return page ? { ...c, streamUrl: "", backupUrls: [], embedUrl: page } : null;
}

/** Decided from the bytes rather than a config field, so a pasted URL cannot be
 *  declared as the wrong format. */
export function parseSource(text: string, src: TvSource): LiveChannel[] {
  const body = text.trimStart();
  if (body.startsWith("#EXTM3U") || body.includes("#EXTINF")) {
    const out: LiveChannel[] = [];
    for (const c of parsePlaylist(text, `src:${slug(src.name)}`)) {
      const kept = keepPlayable(c);
      if (kept) out.push(kept);
    }
    return out;
  }
  return parseSourceJson(text, src);
}

/** A panel's channel list: `{ name, url, logo, category }` rows, in a bare
 *  array or wrapped in one of the keys panels reach for. Relative logos and
 *  links are resolved against the list's own address, because a panel that
 *  prints `/channel_logo/x.png` means itself, not us. */
function parseSourceJson(text: string, src: TvSource): LiveChannel[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  let rows: unknown[] | null = null;
  if (Array.isArray(data)) rows = data;
  else {
    const holder = data as Record<string, unknown> | null;
    for (const key of ["channels", "data", "list", "items"]) {
      const v = holder?.[key];
      if (Array.isArray(v)) {
        rows = v;
        break;
      }
    }
  }
  if (!rows) return [];

  const at = (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return "";
    try {
      return new URL(v.trim(), src.url).href;
    } catch {
      return "";
    }
  };
  const pick = (row: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  const two = (v: unknown) => {
    const cc = typeof v === "string" ? v.toUpperCase().replace(/[^A-Z]/g, "") : "";
    return cc.length >= 2 ? cc.slice(0, 2) : "";
  };

  const out: LiveChannel[] = [];
  rows.forEach((raw, i) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = pick(row, ["name", "title", "channel", "channel_name"]);
    if (!name) return;
    const cats = [row.category, row.group, row["group-title"], row.categories]
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      /* A numeric category id names nothing the viewer can read. */
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v && /[A-Za-z]/.test(v));
    if (cats.some((c) => RE_NSFW.test(c))) return;

    const links = [
      row.url,
      row.streamUrl,
      row.stream,
      row.link,
      row.href,
      row.urls,
      row.streams,
      (row.sources as Record<string, unknown> | undefined)?.streams,
    ].flatMap((v) => (Array.isArray(v) ? v : [v]));
    const media: string[] = [];
    let embed = "";
    for (const v of links) {
      const abs = typeof v === "string" ? at(v) : at((v as { url?: string } | null)?.url);
      if (!abs || media.includes(abs)) continue;
      if (RE_MEDIA.test(abs) || abs.includes("/live/")) media.push(abs);
      else if (!embed && RE_YT.test(abs)) embed = abs;
    }
    /* A row that names neither a file a player can open nor a page to frame is
       the panel's own bookkeeping, not a channel. */
    if (!media.length && !embed) return;

    const targets = media.map((u) => playTarget(u, ""));
    const framed = !media.length;
    out.push({
      _id: `src:${slug(src.name)}:${pick(row, ["id", "_id", "channel_id"]) || i}`,
      name,
      logoUrl: at(row.logo ?? row.cover ?? row.tvgLogo ?? row.icon) || undefined,
      streamUrl: framed ? "" : targets[0].url,
      backupUrls: framed ? [] : targets.slice(1, MAX_FEEDS).map((t) => t.url),
      embedUrl: framed ? embed : undefined,
      categories: [...new Set(cats)],
      country: two(row.country) || src.country || undefined,
      piped: framed ? undefined : targets[0].piped,
    });
  });
  return out;
}

export interface CustomLoad {
  channels: LiveChannel[];
  /** Sources that were declared but answered nothing at all, by their label. */
  failed: string[];
  /** Sources that were read, even if every feed in them was already known. */
  loaded: string[];
}

/** Every list the owner declared, merged into one list. Kept in order: a source
 *  read later only ever adds feeds the earlier ones never had. */
export async function loadCustomSources(): Promise<CustomLoad> {
  const sources = await loadSourceList();
  const channels: LiveChannel[] = [];
  const failed: string[] = [];
  const loaded: string[] = [];
  for (const s of sources) {
    const freshMs = (s.freshHours || DEFAULT_SRC_FRESH_HOURS) * 60 * 60_000;
    try {
      const r = await loadCached(`src:${s.url}`, s.url, (t) => parseSource(t, s), grabList, freshMs);
      channels.push(...r.value);
      loaded.push(s.name);
    } catch {
      failed.push(s.name);
    }
  }
  return {
    channels: channels.sort((a, b) => a.name.localeCompare(b.name)),
    failed,
    loaded,
  };
}

/* ---------------------------------------------------------------- merge */

/** The feed a URL really points at, so the same stream published by two sources
 *  is one card. Looked through our own pipe: a `http:` feed we have to carry and
 *  a plain `https:` feed of the same file are the same channel, and the scheme
 *  alone is not worth a duplicate. */
function feedKey(url: string): string {
  let raw = url.trim();
  try {
    const u = new URL(raw, window.location.href);
    if (u.pathname.endsWith("/embed/proxy")) raw = u.searchParams.get("url") || raw;
  } catch {
    /* Not absolute: key the link as it stands. */
  }
  return raw.replace(/^http:/, "https:");
}

function ownFeeds(c: LiveChannel): string[] {
  return [c.streamUrl, ...(c.backupUrls ?? []), c.embedUrl ?? ""].filter(Boolean);
}

function twinKey(c: LiveChannel): string {
  return `${baseName(c.name)}|${c.country ?? ""}`;
}

/** iptv-org names a feed — "Ananda TV (480p)", "Aaj Tak [Not 24/7]" — and
 *  famelack names the channel: "Ananda TV". Without this the two never meet and
 *  the same channel appears twice. Only tags that describe the *feed* are
 *  stripped: a bracketed word like "(Hindi)" stays, so "News 18 (Hindi)" never
 *  becomes the twin of "News 18 (Bangla)". */
function baseName(name: string): string {
  return name
    .replace(/[[(]\s*(?:\d{3,4}[pi]|hd|sd|fhd|uhd|4k|8k)\s*[\])]/gi, " ")
    .replace(/[[(]\s*not\s*24\s*\/?\s*7\s*[\])]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Add `extra` to `base` without duplicating a stream URL. A known channel that
 *  the other source carries a feed we never had gets that feed as a backup, so
 *  it survives an outage instead of showing "Stream is down"; a channel whose
 *  feeds are all unknown joins the list. */
export function mergeChannels(base: LiveChannel[], extra: LiveChannel[]): LiveChannel[] {
  const byFeed = new Set<string>();
  const byUpstream = new Map<string, LiveChannel>();
  const byName = new Map<string, LiveChannel>();
  for (const c of base) {
    for (const u of ownFeeds(c)) {
      byFeed.add(u);
      const k = feedKey(u);
      if (!byUpstream.has(k)) byUpstream.set(k, c);
    }
    /* One channel can already be on screen as two cards — iptv-org lists both
       an "Aaj Tak (1080p)" and an "Aaj Tak (720p)" — and the first of them is
       the one that collects a new source's feeds. */
    const nameKey = twinKey(c);
    if (!byName.has(nameKey)) byName.set(nameKey, c);
  }

  const claim = (owner: LiveChannel, ...urls: string[]) => {
    for (const u of urls) {
      if (!u) continue;
      byFeed.add(u);
      const k = feedKey(u);
      if (!byUpstream.has(k)) byUpstream.set(k, owner);
    }
  };

  const added: LiveChannel[] = [];
  for (const c of extra) {
    const feeds = ownFeeds(c);
    const fresh = feeds.filter((u) => !byUpstream.has(feedKey(u)));

    if (!fresh.length) {
      /* Nothing new to list — except when the copy on screen has to ride our
         pipe and this one is a plain https link. That is a free backup behind a
         metered primary, which is exactly what a refused pipe needs. */
      const head = feeds[0];
      const owner = head ? byUpstream.get(feedKey(head)) : undefined;
      if (
        owner?.piped &&
        !c.embedUrl &&
        /^https:\/\//i.test(head) &&
        !ownFeeds(owner).includes(head)
      ) {
        owner.backupUrls = [...(owner.backupUrls ?? []), head];
      }
      continue;
    }

    const twin = byName.get(twinKey(c));
    if (twin?.streamUrl && !c.embedUrl) {
      const give = fresh.filter((u) => !byFeed.has(u)).slice(0, MAX_FEEDS);
      if (give.length) twin.backupUrls = [...(twin.backupUrls ?? []), ...give];
      claim(twin, ...fresh);
      continue;
    }

    const [head, ...rest] = fresh;
    const isEmbed = head === c.embedUrl;
    const channel: LiveChannel = {
      _id: c._id,
      name: c.name,
      logoUrl: c.logoUrl,
      country: c.country,
      categories: c.categories,
      streamUrl: isEmbed ? "" : head,
      backupUrls: isEmbed ? [] : rest.slice(0, MAX_FEEDS - 1),
      embedUrl: isEmbed ? head : undefined,
    };
    claim(channel, ...ownFeeds(channel));
    /* Reaches here only when no twin with a stream existed, so this card is the
       one later feeds of the same channel land on — including over a YouTube-only
       row that got here first, which cannot hold a stream backup anyway. */
    byName.set(twinKey(channel), channel);
    added.push(channel);
  }

  return [...base, ...added].sort((a, b) => a.name.localeCompare(b.name));
}

export const IPTV_CREDIT = {
  name: "iptv-org",
  url: "https://github.com/iptv-org/iptv",
};

/** Their dataset is MIT and asks that a reuser say where it came from. */
export const FAMELACK_CREDIT = {
  name: "Famelack",
  url: "https://famelack.com/",
};
