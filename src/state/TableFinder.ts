// ␣␣: the tables whose name matches what is typed, best first. The letters must
// appear in order; consecutive letters and letters that start a word score higher,
// and a match in the table name beats one that needs the schema.

import type { Catalog, Table } from "../db/Catalog.ts"

const WORD_BREAK = /[._\-\s]/

/** How well `query` (lowercase, no spaces) runs through `text`; null when it does not. */
function score(query: string, text: string): number | null {
  const lower = text.toLowerCase()
  let total = 0
  let at = 0
  let run = 0
  for (const ch of query) {
    const i = lower.indexOf(ch, at)
    if (i < 0) return null
    run = i === at && at > 0 ? run + 1 : 0
    const wordStart = i === 0 || WORD_BREAK.test(lower[i - 1] ?? "")
    total += 1 + run * 2 + (wordStart ? 3 : 0)
    at = i + 1
  }
  // Between equal matches, the shorter name is the likelier one.
  return total - text.length * 0.01
}

export function findTables(catalog: Catalog, query: string, limit = 50): ReadonlyArray<Table> {
  const q = query.toLowerCase().replace(/\s+/g, "")
  if (!q) return catalog.tables.slice(0, limit)
  const scored: Array<{ readonly table: Table; readonly score: number }> = []
  for (const table of catalog.tables) {
    const byName = score(q, table.name)
    const qualified = score(q, `${table.schema}.${table.name}`)
    const best = Math.max(byName === null ? -Infinity : byName + 2, qualified ?? -Infinity)
    if (best > -Infinity) scored.push({ table, score: best })
  }
  // Stable: equal scores keep catalog order (schema, then name).
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.table)
}
