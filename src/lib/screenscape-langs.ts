import { fetchWithFailover } from "@/lib/apiConfig";

/** One language Screenscape's own player lists for this title, and the stream
 *  that row plays. The Worker reads them off Screenscape's page in a real
 *  browser — their rows arrive through a signed route no fetch can reproduce —
 *  so this is the only honest way to offer those languages in our own bar. */
export interface ScreenscapeLang {
  lang: string;
  url: string;
  kind: "hls" | "file";
  server?: string;
}

/** Null means "no answer" (route missing, plan without Browser Rendering, page
 *  refused): the language menu then stays exactly as it was rather than
 *  claiming the title has no other voice. */
export async function fetchScreenscapeLangs(t: {
  tmdbId?: string;
  kind: string;
  season?: number;
  episode?: number;
}): Promise<ScreenscapeLang[] | null> {
  const tmdb = (t.tmdbId ?? "").trim();
  if (!/^\d+$/.test(tmdb)) return null;
  const q = new URLSearchParams({
    tmdb,
    type: t.kind === "series" ? "tv" : "movie",
  });
  if (t.kind === "series") {
    q.set("season", String(t.season ?? 1));
    q.set("episode", String(t.episode ?? 1));
  }
  try {
    const res = await fetchWithFailover(`/embed/screenscape/langs?${q.toString()}`, {
      signal: AbortSignal.timeout(19_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { languages?: ScreenscapeLang[] };
    if (!Array.isArray(body.languages)) return null;
    return body.languages.filter((l) => l && l.lang && l.url);
  } catch {
    return null;
  }
}
