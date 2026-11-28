// pg_trgm's similarity(), reimplemented so a dry run can score fuzzy matches
// from a JSON snapshot with no database. Same algorithm as contrib/pg_trgm:
//   lower-case; split into words on non-alphanumerics; pad each word with two
//   leading spaces and one trailing; the set of distinct 3-grams;
//   similarity = |A ∩ B| / |A ∪ B|.
// Checked against real pg_trgm in the local harness (see docs/inventory-import.md).

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(s)) {
    const chars = Array.from(`  ${w} `);
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
  }
  return out;
}

export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / (A.size + B.size - common);
}

/**
 * cards.search_text, exactly as the generated column builds it (schema/025):
 * title, player, year, set_name, parallel, grader, grade, sport, serial_number
 * joined by single spaces, nulls as ''.
 */
export function searchText(c: {
  title?: string | null; player?: string | null; year?: string | null; set_name?: string | null;
  parallel?: string | null; grader?: string | null; grade?: string | null; sport?: string | null;
  serial_number?: string | null;
}): string {
  return [c.title, c.player, c.year, c.set_name, c.parallel, c.grader, c.grade, c.sport, c.serial_number]
    .map((v) => v ?? "").join(" ");
}
