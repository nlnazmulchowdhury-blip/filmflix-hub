import { Hono } from "hono";
import puppeteer from "@cloudflare/puppeteer";
import type { Bindings, Env } from "./index";

/**
 * Screenscape's own language rows ("Hindi Wesker · Auto", "English Leon · Auto")
 * for one title, each with the stream that row plays.
 *
 * Why a browser: the player is a Next.js shell whose rows arrive from a
 * per-server route signed with an HMAC the client mints. A fetch of the page
 * sees none of it, and reproducing that signature is off limits. A real browser
 * is the public way in — the same page a visitor's own Chrome renders — so it
 * is run here and the rows are read off the screen, then the row the viewer
 * picked is clicked and the media request it makes is kept. That URL is what our
 * own player plays; nothing about it is forged.
 *
 * Cost: a cold render is ~10 s (page load, panel, one click per language), so
 * answers are cached per title+episode for the life of the isolate.
 */

export const screenscapeLangsRoutes = new Hono<Env>();

export interface LangStream {
  lang: string;
  url: string;
  kind: "hls" | "file";
  server: string;
  row: string;
}

const EMBED = "https://nxsha.screenscape.me/embed";
/** A media request is the row's proof: an m3u8/mpd is HLS, a file plays as-is. */
const MEDIA = /\.(m3u8|mp4|mkv|ts|mpd)(\?|$)/i;
/** A row that names its language first ("Hindi Falcon"); everything else falls
 *  back to the tag on its server ("[Hindi]"). */
const LANG_HEAD =
  /^(hindi|english|tamil|telugu|malayalam|kannada|bengali|urdu|punjabi|marathi|gujarati|original)\b/i;
/** Screenscape's server labels, which is how the panel's own buttons are found. */
const LABELS =
  /^(CAT|Nitro|1xC|ALICE|HINDI|HBOX|Viduki|Elite|Scape|MONGO|4KELITE|Vortex|Tamil|FOGS|Venom|Sealx|Mune|ALS|4K|HDHub)\b/;

const CACHE_TTL_MS = 20 * 60_000;
const BUDGET_MS = 15_000;
const MAX_SERVERS = 12;
const MAX_LANGS = 6;
const ROW_WAIT_MS = 3_500;

const cache = new Map<string, { at: number; languages: LangStream[] }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The referer these CDNs were serving when Screenscape's own iframe played
 *  them. A browser on our origin cannot send it, so every language stream is
 *  handed back through our byte pipe with its manifest re-pointed at the same
 *  pipe — exactly how nxsha and viduki are played here. */
const EMBED_REFERER = "https://nxsha.screenscape.me/";

function piped(origin: string, s: LangStream): LangStream {
  const q = new URLSearchParams({ url: s.url, ref: EMBED_REFERER, rewrite: "1" });
  return { ...s, url: `${origin}/embed/proxy?${q.toString()}` };
}

/** The panel's server buttons and its stream rows, as the page renders them. */
const PANEL_SERVER = "px-3 py-2.5";
const PANEL_ROW = "pl-7";

const OPEN_PANEL = `(() => {
  const d = document;
  const servers = [...d.querySelectorAll("button")].filter((b) => b.className.includes(${JSON.stringify(PANEL_SERVER)}));
  if (servers.length) return true;
  const top = [...d.querySelectorAll("button")].find(
    (b) => !b.className.includes(${JSON.stringify(PANEL_SERVER)}) &&
      !b.className.includes(${JSON.stringify(PANEL_ROW)}) &&
      ${LABELS}.test((b.innerText || "").trim()),
  );
  if (!top) return false;
  top.click();
  return true;
})()`;

const SERVER_LIST = `(() => [...document.querySelectorAll("button")]
  .filter((b) => b.className.includes(${JSON.stringify(PANEL_SERVER)}))
  .map((b) => {
    const text = (b.innerText || "").trim().replace(/\\s+/g, " ");
    const tag = (/\\[([^\\]]+)\\]/.exec(text) || [])[1] || "";
    return { name: text.split(" ")[0] || "", text, tag };
  }))()`;

const pickServer = (name: string) => `(() => {
  const b = [...document.querySelectorAll("button")].find(
    (x) => x.className.includes(${JSON.stringify(PANEL_SERVER)}) &&
      (x.innerText || "").trim().startsWith(${JSON.stringify(name)}),
  );
  if (!b) return false;
  b.click();
  return true;
})()`;

const LIST_ROWS = `(() => [...document.querySelectorAll("button")]
  .filter((b) => b.className.includes(${JSON.stringify(PANEL_ROW)}))
  .map((b) => (b.innerText || "").trim().replace(/\\s+/g, " ")))()`;

const clickRow = (text: string) => `(() => {
  const b = [...document.querySelectorAll("button")].find(
    (x) => x.className.includes(${JSON.stringify(PANEL_ROW)}) &&
      (x.innerText || "").trim().replace(/\\s+/g, " ") === ${JSON.stringify(text)},
  );
  if (!b) return false;
  b.click();
  return true;
})()`;

export function screenscapeEmbed(t: {
  tmdb: string;
  kind: string;
  season?: string;
  episode?: string;
}): string {
  const u = new URL(EMBED);
  u.searchParams.set("tmdb", t.tmdb);
  u.searchParams.set("type", t.kind);
  if (t.kind === "tv") {
    u.searchParams.set("season", t.season || "1");
    u.searchParams.set("episode", t.episode || "1");
  }
  return u.toString();
}

async function renderLanguages(
  binding: Bindings["BROWSER"],
  target: { tmdb: string; kind: string; season?: string; episode?: string },
): Promise<LangStream[]> {
  if (!binding) return [];
  const started = Date.now();
  let instance: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    instance = await puppeteer.launch(binding);
    const page = await instance.newPage();
    /* Every byte the player asks for is kept in order, so a click's own stream
       is whatever landed after it. */
    const media: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (MEDIA.test(url)) media.push(url);
    });
    await page.goto(screenscapeEmbed(target), {
      waitUntil: "domcontentloaded",
      timeout: 12_000,
    });
    /* The panel fills only once the page has listed its sources. */
    for (let i = 0; i < 20; i++) {
      const ready = await page.evaluate(
        `[...document.querySelectorAll("button")].some((b) => b.className.includes(${JSON.stringify(PANEL_SERVER)}))`,
      );
      if (ready) break;
      await sleep(300);
    }
    const open = async () => {
      const wasOpen = await page.evaluate(OPEN_PANEL);
      if (wasOpen) return true;
      await sleep(250);
      return page.evaluate(OPEN_PANEL);
    };

    const servers = (await page.evaluate(SERVER_LIST)) as {
      name: string;
      text: string;
      tag: string;
    }[];
    if (!servers.length) return [];

    const found = new Map<string, LangStream>();
    for (const server of servers.slice(0, MAX_SERVERS)) {
      if (Date.now() - started > BUDGET_MS || found.size >= MAX_LANGS) break;
      if (!server.name) continue;
      if (!(await open())) continue;
      if (!(await page.evaluate(pickServer(server.name)))) continue;
      await sleep(350);
      const rows = (await page.evaluate(LIST_ROWS)) as string[];
      const tagLang = LANG_HEAD.exec(server.tag)?.[0] ?? "";
      for (const row of rows) {
        if (Date.now() - started > BUDGET_MS || found.size >= MAX_LANGS) break;
        const lang = LANG_HEAD.exec(row)?.[0] || tagLang;
        if (!lang) continue;
        const key = lang.toLowerCase();
        if (found.has(key)) continue;
        const before = media.length;
        if (!(await page.evaluate(clickRow(row)))) continue;
        let url = "";
        const deadline = Date.now() + ROW_WAIT_MS;
        while (!url && Date.now() < deadline) {
          await sleep(150);
          url = [...new Set(media.slice(before))][0] ?? "";
        }
        /* A row that streams over MSE hands us segments, not a manifest, and a
           blob URL is not something our player can open. Only a manifest or a
           file counts as this language answered. */
        if (!url || !MEDIA.test(url) || /\.ts(\?|$)/i.test(url)) continue;
        found.set(key, {
          lang,
          url,
          kind: /\.(m3u8|mpd)(\?|$)/i.test(url) ? "hls" : "file",
          server: server.name,
          row,
        });
        if (!(await open())) break;
      }
    }
    return [...found.values()];
  } catch (err) {
    console.error("screenscape langs render failed", err);
    return [];
  } finally {
    await instance?.close().catch(() => undefined);
  }
}

screenscapeLangsRoutes.get("/langs", async (c) => {
  const tmdb = (c.req.query("tmdb") ?? "").trim();
  if (!/^\d+$/.test(tmdb)) return c.json({ error: "tmdb id required" }, 400);
  const kind = (c.req.query("type") ?? "movie").toLowerCase() === "tv" ? "tv" : "movie";
  const season = c.req.query("season") ?? undefined;
  const episode = c.req.query("episode") ?? undefined;
  const key = `${kind}:${tmdb}:${season ?? ""}:${episode ?? ""}`;

  const origin = new URL(c.req.url).origin;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS)
    return c.json({
      languages: hit.languages.map((s) => piped(origin, s)),
      cached: true,
    });

  if (!c.env.BROWSER)
    return c.json({ error: "browser-unavailable", languages: [] }, 501);

  const started = Date.now();
  const languages = await renderLanguages(c.env.BROWSER as never, {
    tmdb,
    kind,
    season,
    episode,
  });
  if (languages.length) cache.set(key, { at: Date.now(), languages });
  return c.json({
    languages: languages.map((s) => piped(origin, s)),
    ms: Date.now() - started,
  });
});
