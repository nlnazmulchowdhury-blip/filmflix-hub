import { resolveEmbedStream } from "@/lib/embed-resolver";
import { proxyUrl } from "@/lib/hls-download";

/** One audio rendition a server's own master playlist declares. */
export interface ServerAudio {
  /** What the playlist names it: "English", "हिन्दी", "Italian". */
  name: string;
  /** ISO code when the playlist carries one: "eng", "hin". */
  lang?: string;
  isDefault: boolean;
}

/* The same voice spelled three ways across these providers: `LANGUAGE=eng`,
   `LANGUAGE=en`, `NAME="English"`. Without one canonical key, a film shows up
   as four languages it does not have. */
const CODE_NAMES: Record<string, string> = {
  eng: "English",
  en: "English",
  ben: "বাংলা",
  bn: "বাংলা",
  hin: "हिन्दी",
  hi: "हिन्दी",
  urd: "اردو",
  ur: "اردو",
  pan: "ਪੰਜਾਬੀ",
  mar: "मराठी",
  guj: "ગુજરાતી",
  tam: "தமிழ்",
  tel: "తెలుగు",
  mal: "മലയാളം",
  kan: "ಕನ್ನಡ",
  sin: "සිංහල",
  nep: "नेपाली",
  spa: "Español",
  es: "Español",
  fra: "Français",
  fre: "Français",
  fr: "Français",
  deu: "Deutsch",
  ger: "Deutsch",
  de: "Deutsch",
  ita: "Italiano",
  it: "Italiano",
  por: "Português",
  pt: "Português",
  rus: "Русский",
  ru: "Русский",
  ukr: "Українська",
  pl: "Polski",
  pol: "Polski",
  nld: "Nederlands",
  dut: "Nederlands",
  nl: "Nederlands",
  swe: "Svenska",
  nor: "Norsk",
  dan: "Dansk",
  fin: "Suomi",
  ell: "Ελληνικά",
  gre: "Ελληνικά",
  heb: "עברית",
  ara: "العربية",
  ar: "العربية",
  tur: "Türkçe",
  tr: "Türkçe",
  per: "فارسی",
  fa: "فارسی",
  jpn: "日本語",
  ja: "日本語",
  kor: "한국어",
  ko: "한국어",
  zho: "中文",
  chi: "中文",
  zh: "中文",
  tha: "ไทย",
  vie: "Tiếng Việt",
  id: "Bahasa Indonesia",
  ind: "Bahasa Indonesia",
  ms: "Bahasa Melayu",
  may: "Bahasa Melayu",
  fil: "Filipino",
};

/** English spellings, which is how most of these playlists name a track. */
const ENGLISH_NAMES = new Map<string, string>(
  Object.entries({
    english: "English",
    bengali: "বাংলা",
    hindi: "हिन्दी",
    urdu: "اردو",
    punjabi: "ਪੰਜਾਬੀ",
    marathi: "मराठी",
    gujarati: "ગુજરાતી",
    tamil: "தமிழ்",
    telugu: "తెలుగు",
    malayalam: "മലയാളം",
    kannada: "ಕನ್ನಡ",
    spanish: "Español",
    french: "Français",
    german: "Deutsch",
    italian: "Italiano",
    portuguese: "Português",
    russian: "Русский",
    polish: "Polski",
    dutch: "Nederlands",
    swedish: "Svenska",
    norwegian: "Norsk",
    danish: "Dansk",
    finnish: "Suomi",
    greek: "Ελληνικά",
    hebrew: "עברית",
    arabic: "العربية",
    turkish: "Türkçe",
    persian: "فارسی",
    japanese: "日本語",
    korean: "한국어",
    chinese: "中文",
    thai: "ไทย",
    vietnamese: "Tiếng Việt",
    indonesian: "Bahasa Indonesia",
    malay: "Bahasa Melayu",
    filipino: "Filipino",
    sinhala: "සිංහල",
    nepali: "नेपाली",
    ukrainian: "Українська",
  }),
);

/** The one key two spellings of the same voice share. */
export function audioKeyOf(a: { name?: string; lang?: string }): string {
  const code = (a.lang ?? "").trim().toLowerCase().slice(0, 3);
  if (code && CODE_NAMES[code]) return CODE_NAMES[code];
  const name = (a.name ?? "").trim().toLowerCase();
  const byName = name ? ENGLISH_NAMES.get(name) : undefined;
  if (byName) return byName;
  /* "Hindi (Dubbed)", "English [Audio]" — the part before the qualifier is
     usually still the language, and a wrong merge is cheaper than a duplicate
     row the viewer has to compare. */
  const head = name ? name.split(/[\s([,/-]+/)[0] : "";
  const byHead = head ? ENGLISH_NAMES.get(head) : undefined;
  if (byHead) return byHead;
  return (a.name ?? "").trim() || (a.lang ?? "").trim().toLowerCase() || "unknown";
}

/** `#EXT-X-MEDIA:TYPE=AUDIO` lines, in the order the playlist offers them. */
export function parseAudioRenditions(text: string): ServerAudio[] {
  const out: ServerAudio[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-MEDIA:") || !/\bTYPE=AUDIO\b/.test(line)) continue;
    const name = /NAME="([^"]*)"/.exec(line)?.[1]?.trim() ?? "";
    const lang = /LANGUAGE="?([A-Za-z0-9-]+)"?/.exec(line)?.[1]?.trim() ?? "";
    const key = audioKeyOf({ name, lang });
    if (!key || key === "unknown" || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || lang, lang: lang || undefined, isDefault: /DEFAULT=YES/.test(line) });
  }
  return out;
}

/** What one server can actually be heard in.
 *
 *  Resolved the same way the player resolves it, then its own master playlist
 *  is read for the audio renditions it declares — so a server that answers with
 *  a single-audio file, or refuses the question, comes back empty. Empty means
 *  "this server told us nothing", never "this server has one language". */
export async function fetchServerAudio(embedUrl: string): Promise<ServerAudio[]> {
  const target = (embedUrl ?? "").trim();
  if (!target) return [];
  try {
    const r = await resolveEmbedStream(target);
    const top = (r.candidates ?? []).find((c) => c.url)?.url;
    if (!top) return [];
    const text = await readPlaylist(top).catch(() => "") ||
      /* A CDN that refuses *our* origin still answers our own byte pipe, which
         is the only other way this browser may legally read it. Try that before
         calling the server mute. */
      (await readPlaylist(proxyUrl(top, r.hops?.[0] || undefined)));
    return parseAudioRenditions(text);
  } catch {
    return [];
  }
}

async function readPlaylist(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(String(res.status));
  return res.text();
}
