/**
 * Titles saved on this device.
 *
 * The site's watchlist is server-side but keyed on a catalog row, and most of
 * what plays here is a TMDB id the viewer reached straight from a provider —
 * there is no catalog row to hang a save on. Until those titles get a server
 * side list of their own, a save that must work on either lives here, so the
 * chip never has to lie about what it did.
 */
const KEY = "ff-saved-titles";

export type SavedTitle = {
  /** Route key: the catalog id, or `vaplayer:<tmdbId>` for a provider title. */
  key: string;
  title: string;
  posterUrl?: string | null;
  year?: string | null;
  kind?: "movie" | "series";
  /** Present for a provider title — enough to reopen `/movie/vaplayer-<id>`. */
  tmdbId?: string | null;
  savedAt: number;
};

export function readSavedTitles(): SavedTitle[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((t) => t && typeof t.key === "string") : [];
  } catch {
    return [];
  }
}

export function isSavedTitle(key: string): boolean {
  if (!key) return false;
  return readSavedTitles().some((t) => t.key === key);
}

/** Store or drop one entry; returns the state the chip should now show. */
export function toggleSavedTitle(entry: Omit<SavedTitle, "savedAt">): boolean {
  const list = readSavedTitles();
  const at = list.findIndex((t) => t.key === entry.key);
  if (at >= 0) {
    list.splice(at, 1);
  } else {
    list.unshift({ ...entry, savedAt: Date.now() });
    list.splice(60);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* Private mode / quota — the chip still reflects this page's press. */
  }
  return at < 0;
}

export function removeSavedTitle(key: string): void {
  const list = readSavedTitles().filter((t) => t.key !== key);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* see above */
  }
}
