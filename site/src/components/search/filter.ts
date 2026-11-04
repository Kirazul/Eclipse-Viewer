import type { SearchRow } from "@eclipse/format";

export interface IndexedRow extends SearchRow {
  /** Lowercased, accents off. */
  key: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function indexRows(rows: SearchRow[]): IndexedRow[] {
  return rows.map((r) => ({ ...r, key: fold(r.n) }));
}

/**
 * Word matches first, then by shorter name: every query word must appear, a row
 * whose words start with them beats one that merely contains them.
 */
export function filterRows(rows: IndexedRow[], query: string, limit = 50): IndexedRow[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { r: IndexedRow; rank: number }[] = [];
  for (const r of rows) {
    let rank = 0;
    let ok = true;
    for (const w of words) {
      const at = r.key.indexOf(w);
      if (at < 0) { ok = false; break; }
      const startsWord = at === 0 || r.key[at - 1] === " " || new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(r.key);
      if (!startsWord) rank = 1;
    }
    if (ok) scored.push({ r, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.r.n.length - b.r.n.length || a.r.n.localeCompare(b.r.n));
  return scored.slice(0, limit).map((s) => s.r);
}
