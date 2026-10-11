/**
 * All the section names a movie lives in: the `categories` array plus the
 * legacy single `category` field. Normalized: trimmed, de-duplicated.
 */
export function movieCategoryNames(m: {
  categories?: string[];
  category?: string;
} | Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cats = Array.isArray(m.categories) ? (m.categories as string[]) : [];
  const legacy = typeof m.category === "string" ? m.category : "";
  for (const raw of [...cats, legacy]) {
    const c = raw.trim();
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}
