/**
 * 4KHDHub (4khdhub.one) — server-side download extraction.
 *
 * The site is a download hub, not a player: a title page lists quality cards,
 * and each card hands out two host links — HubCloud and HubDrive. Both are
 * redirectors. HubCloud answers with a token page whose resolver link
 * (`gamerxyt.com/hubcloud.php`) finally names the file on a CDN. HubDrive's
 * page is built in JS and carries nothing on the server; its only trace is the
 * HubCloud mirror it points at, so a HubDrive link is walked through to one.
 *
 * The greenmotors club link in each card is a base64 → base64 → ROT13 → base64
 * hop wrapping `{ "o": base64(target) }`. That is a redirector's encoding, not
 * a lock: it is opened here with plain decoders, no provider code is executed
 * and no signing key is reproduced.
 *
 * What it yields is MKV — 4KHDHub's releases are MKV (x264, x265/HEVC, AV1),
 * which a browser's `<video>` refuses with a format error even from a
 * same-origin URL. So these links feed the Download menu only; they are not a
 * playback server.
 */

const BASE = "https://4khdhub.one";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HOP_TIMEOUT_MS = 12_000;

export interface FourKFile {
  /** Quality line the card prints, e.g. "Oppenheimer (1080p BluRay X264)". */
  quality: string;
  size: string;
  audio: string;
  filename: string;
  url: string;
}

export interface FourKQuery {
  title: string;
  kind: "movie" | "tv";
  season: number;
  episode: number;
}

async function getPage(url: string, referer = ""): Promise<{ final: string; text: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HOP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        ...(referer ? { Referer: referer } : {}),
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    return { final: res.url, text: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const rot13 = (s: string): string =>
  s.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0) + 13;
    const cap = c <= "Z" ? 90 : 122;
    return String.fromCharCode(cap >= code ? code : code - 26);
  });

/** base64 → base64 → ROT13 → base64 → JSON → base64. */
function decodeGreenmotors(payload: string): string | null {
  try {
    const step1 = atob(payload);
    const step2 = atob(step1);
    const step3 = rot13(step2);
    const step4 = atob(step3);
    const target = (JSON.parse(step4) as { o?: unknown }).o;
    return typeof target === "string" ? atob(target) : null;
  } catch {
    return null;
  }
}

/* ---------------- search + detail parsing ---------------- */

interface SearchCard {
  href: string;
  title: string;
}

function searchCards(html: string): SearchCard[] {
  const out: SearchCard[] = [];
  for (const m of html.matchAll(
    /<a\s+href="(\/[^"]+)"\s+class="movie-card"[\s\S]*?<h3 class="movie-card-title">([\s\S]*?)<\/h3>/g,
  )) {
    const title = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (title) out.push({ href: m[1], title });
  }
  return out;
}

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The card that is this title, not merely the first search hit: search
 *  answers a partial match with anything sharing a word, and the wrong film's
 *  files are worse than no files. */
function pickCard(cards: SearchCard[], title: string, kind: "movie" | "tv"): SearchCard | null {
  const want = normalize(title);
  if (!want) return null;
  const slugKind = (href: string) => (href.includes("-series-") ? "tv" : "movie");
  const scored = cards
    .map((card) => {
      const got = normalize(card.title);
      let score = 0;
      if (got === want) score = 100;
      else if (got.startsWith(want) || want.startsWith(got)) score = 60;
      else if (got.includes(want) || want.includes(got)) score = 30;
      if (slugKind(card.href) === kind) score += 10;
      return { card, score };
    })
    .filter((x) => x.score >= 30)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.card ?? null;
}

interface QualityCard {
  quality: string;
  size: string;
  audio: string;
  filename: string;
  mirrors: string[];
}

const textOf = (s: string): string =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function qualityCards(html: string): QualityCard[] {
  const out: QualityCard[] = [];
  const blocks = html.split('<div class="download-item');
  for (const block of blocks.slice(1)) {
    const head = block.match(/data-file-id="[^"]*">([\s\S]*?)<br>/);
    const quality = head ? textOf(head[1]) : "";
    const badges = [...block.matchAll(/<span class="badge"[^>]*>([^<]+)<\/span>/g)].map((m) =>
      m[1].trim(),
    );
    const size = badges.find((b) => /\d\s*(?:gb|mb)\b/i.test(b)) ?? "";
    const audio = badges.find((b) => /hindi|english|tamil|telugu|kannada|malayalam|japanese|korean|dual|multi/i.test(b)) ?? "";
    const filename = block.match(/<div class="file-title">([^<]+)<\/div>/)?.[1]?.trim() ?? "";
    const mirrors = [...block.matchAll(/href="(https:\/\/greenmotors\.[^"]+)"/g)].map((m) => m[1]);
    if (mirrors.length) out.push({ quality, size, audio, filename, mirrors });
  }
  return out;
}

/** A series page carries every episode's cards in one document, so the season
 *  and episode are filtered here instead of by another hop. Episode cards use
 *  their own markup (`episode-download-item`) with the quality line on the
 *  episode header, so they are read separately from the movie cards. */
function episodeCards(html: string, season: number, episode: number): QualityCard[] {
  const ep = String(episode).padStart(2, "0");
  const mark = `S${String(season).padStart(2, "0")}`;
  const out: QualityCard[] = [];
  for (const part of html.split('<div class="season-item episode-item').slice(1)) {
    const label = textOf(part.slice(0, 8_000));
    if (!label.includes(mark)) continue;
    const tagged =
      new RegExp(`Episode[- _]?0*${ep}\\b`, "i").test(label) ||
      new RegExp(`${mark}E0*${ep}\\b`, "i").test(label);
    if (!tagged) continue;
    const quality = part.match(/<h3 class="episode-title">([^<]+)<\/h3>/)?.[1]?.trim() ?? "";
    const meta = part.match(/<div class="episode-meta">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const audio =
      [...meta.matchAll(/<span class="badge"[^>]*>([^<]+)<\/span>/g)]
        .map((m) => m[1].trim())
        .find((b) => /hindi|english|tamil|telugu|kannada|malayalam|japanese|korean|dual|multi/i.test(b)) ?? "";
    const episodeTag = new RegExp(`${mark}[. _-]?E0*${ep}(?![0-9])`, "i");
    for (const block of part.split('<div class="episode-download-item').slice(1)) {
      const filename = textOf(block.match(/<div class="episode-file-title">([\s\S]*?)<\/div>/)?.[1] ?? "");
      /* A season pack lists every episode inside one block, so the filename —
         not the header — decides which file belongs to the asked episode. */
      if (!episodeTag.test(filename)) continue;
      const size = block.match(/<span class="badge-size">([^<]+)<\/span>/)?.[1]?.trim() ?? "";
      const mirrors = [...block.matchAll(/href="(https:\/\/greenmotors\.[^"]+)"/g)].map((m) => m[1]);
      if (mirrors.length) out.push({ quality, size, audio, filename, mirrors });
    }
  }
  return out;
}

/* ---------------- resolution ---------------- */

const PROBE_TIMEOUT_MS = 8_000;

/** Does the minted link still serve? Hosts retire tokens ("Generate Link
 *  Again") and exhaust the Drive quota behind popular files, both as quick
 *  403s, so one ranged request keeps dead rows out of the menu. */
async function fileAnswers(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Range: "bytes=0-0" },
      signal: ctrl.signal,
    });
    await res.body?.cancel();
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function hubcloudFile(driveUrl: string): Promise<string | null> {
  const page = await getPage(driveUrl, `${BASE}/`);
  if (!page) return null;
  const resolver = page.text.match(
    /href="(https:\/\/[^"]*(?:gamerxyt\.com\/hubcloud\.php|\/download\/)[^"]*)"/,
  )?.[1];
  if (!resolver) return null;
  const answer = await getPage(resolver, page.final);
  if (!answer) return null;
  const links = [...answer.text.matchAll(/href="(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  /* The CDN file is the real one; a PixelDrain row is its mirror, and the link
     shape alone does not prove the file exists — its info endpoint does. */
  const files = links.filter((u) => /\.(?:mkv|mp4)(?:\?|$)/i.test(u)).slice(0, 3);
  const live = await Promise.all(files.map(fileAnswers));
  const file = files[live.indexOf(true)];
  if (file) return file;
  if (files.length) return null;
  const pixel = links
    .map((u) => u.match(/^https:\/\/([^/]+)\/u\/([A-Za-z0-9_-]+)\/?$/))
    .find((m): m is RegExpMatchArray => m !== null);
  if (!pixel) return null;
  const api = `https://${pixel[1]}/api/file/${pixel[2]}`;
  const info = await getPage(`${api}/info`, `${BASE}/`);
  if (!info || !/"success"\s*:\s*true/.test(info.text)) return null;
  return `${api}?download`;
}

/** One greenmotors card link → the file it points at. */
async function resolveMirror(link: string): Promise<string | null> {
  const hop = await getPage(link, `${BASE}/`);
  if (!hop) return null;
  const payload = hop.text.match(/s\('o','([^']+)'/)?.[1];
  if (!payload) return null;
  const target = decodeGreenmotors(payload);
  if (!target) return null;
  if (/hubcloud\.[^/]+\/drive\//i.test(target)) return hubcloudFile(target);
  if (/hubdrive\./i.test(target)) {
    const drive = await getPage(target, hop.final);
    if (!drive) return null;
    const hubcloud = drive.text.match(
      /https:\/\/[^"'\s<>]*hubcloud\.[^"'\s<>]*\/drive\/[^"'\s<>]*/i,
    )?.[0];
    return hubcloud ? hubcloudFile(hubcloud) : null;
  }
  return /\.(?:mkv|mp4)(?:\?|$)/i.test(target) ? target : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/* The minted CDN links die when the resolver rotates its token, so an answer is
   only good for a few minutes; the walk itself costs ~20 requests, too much to
   repeat on every menu open. */
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; files: FourKFile[] }>();

export async function fourkhdhubFiles(q: FourKQuery): Promise<{ files: FourKFile[]; error?: string }> {
  const title = q.title.trim().slice(0, 120);
  if (!title) return { files: [], error: "no title to search" };
  const key = `${title.toLowerCase()}|${q.kind}|${q.season}|${q.episode}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { files: hit.files };

  const search = await getPage(`${BASE}/?s=${encodeURIComponent(title)}`, `${BASE}/`);
  if (!search) return { files: [], error: "4KHDHub search did not answer" };
  const card = pickCard(searchCards(search.text), title, q.kind);
  if (!card) return { files: [], error: "4KHDHub does not list this title" };

  const detail = await getPage(new URL(card.href, BASE).href, search.final);
  if (!detail) return { files: [], error: "4KHDHub title page did not answer" };
  const cards = q.kind === "tv" ? episodeCards(detail.text, q.season, q.episode) : qualityCards(detail.text);
  if (!cards.length) return { files: [], error: "4KHDHub lists no files for this episode" };

  /* One file per quality card is enough: its mirrors are the same bytes, and
     the walk to each is three hops. Newest walks (1080p/2160p x264/x265) come
     first in the page, so the slice keeps the qualities a viewer wants. */
  const wanted = cards.slice(0, 8);
  const files = await mapLimit(wanted, 4, async (c) => {
    for (const mirror of c.mirrors.slice(0, 2)) {
      const url = await resolveMirror(mirror);
      if (url) return { ...c, url };
    }
    return null;
  });
  const seen = new Set<string>();
  const found = files.filter((f): f is QualityCard & { url: string } => {
    if (!f || seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });
  if (!found.length) return { files: [], error: "4KHDHub's mirrors did not name a file" };

  const out: FourKFile[] = found.map((f) => ({
    quality: f.quality,
    size: f.size,
    audio: f.audio,
    filename: f.filename,
    url: f.url,
  }));
  cache.set(key, { at: Date.now(), files: out });
  return { files: out };
}
