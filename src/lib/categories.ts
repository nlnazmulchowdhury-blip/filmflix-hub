/**
 * All the section names a movie lives in: the `categories` array plus the
 * legacy single `category` field. Normalized: trimmed, de-duplicated.
 *
 * Lives outside src/convex so browser code can import it without pulling in
 * the Convex server runtime (which references `process` and breaks Vite).
 */
export function movieCategoryNames(m: {
  categories?: string[];
  category?: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(m.categories ?? []), m.category ?? ""]) {
    const c = raw.trim();
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}
