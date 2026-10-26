// The slice of a table held in memory: a contiguous run of rows that grows a page
// at a time in either direction and drops rows from the far end past MAX_ROWS.
// Pure; the workspace decides when to ask for pages and applies the answers.

import type { Row } from "../db/Rows.ts"
import { PAGE_SIZE, PageRequest } from "../db/Rows.ts"

export interface RowBuffer {
  readonly rows: ReadonlyArray<Row>
  /** Position of `rows[0]` in the table, when known (0 = first row). */
  readonly base: number | null
  readonly atStart: boolean
  readonly atEnd: boolean
  /** The request in flight. Answers to any other request are stale and ignored. */
  readonly pending: PageRequest | null
  readonly error: string | null
}

export const MAX_ROWS = 2000

export const empty: RowBuffer = { rows: [], base: 0, atStart: true, atEnd: false, pending: null, error: null }

/** Exact row count, once both ends have been seen with nothing dropped. */
export const exactCount = (b: RowBuffer): number | null => (b.atStart && b.atEnd && b.base === 0 ? b.rows.length : null)

/** Start over at one end of the table. */
export const reset = (request: PageRequest): RowBuffer => ({ ...empty, atStart: false, base: null, pending: request })

/** The next page after the last row, or null when there is none or one is already coming. */
export function nextRequest(b: RowBuffer, offsetPaging: boolean): PageRequest | null {
  if (b.pending || b.error || b.atEnd) return null
  const last = b.rows.at(-1)
  if (offsetPaging) return b.base === null ? null : PageRequest.Offset({ offset: b.base + b.rows.length, limit: PAGE_SIZE })
  return last ? PageRequest.After({ key: last.key }) : PageRequest.First()
}

/** The page before the first row, or null when there is none or one is already coming. */
export function previousRequest(b: RowBuffer, offsetPaging: boolean): PageRequest | null {
  if (b.pending || b.error || b.atStart) return null
  const first = b.rows[0]
  if (offsetPaging) {
    if (b.base === null) return null
    const offset = Math.max(0, b.base - PAGE_SIZE)
    return PageRequest.Offset({ offset, limit: b.base - offset })
  }
  return first ? PageRequest.Before({ key: first.key }) : PageRequest.Last()
}

export const withPending = (b: RowBuffer, request: PageRequest): RowBuffer => ({ ...b, pending: request, error: null })

export const failed = (b: RowBuffer, message: string): RowBuffer => ({ ...b, pending: null, error: message })

/**
 * Adds a page. `shift` is how far existing indexes moved (rows added in front
 * move forward, rows dropped from the front move back).
 */
export function apply(b: RowBuffer, request: PageRequest, page: { readonly rows: ReadonlyArray<Row>; readonly complete: boolean }): { readonly buffer: RowBuffer; readonly shift: number } {
  const done = { ...b, pending: null, error: null }
  const append = (complete: boolean) => {
    const rows = [...b.rows, ...page.rows]
    const drop = Math.max(0, rows.length - MAX_ROWS)
    return {
      buffer: { ...done, rows: rows.slice(drop), base: b.base === null ? null : b.base + drop, atStart: b.atStart && drop === 0, atEnd: complete },
      shift: -drop,
    }
  }
  const prepend = (complete: boolean, base: number | null) => {
    const rows = [...page.rows, ...b.rows]
    const kept = rows.slice(0, MAX_ROWS)
    return {
      buffer: { ...done, rows: kept, base, atStart: complete, atEnd: b.atEnd && kept.length === rows.length },
      shift: page.rows.length,
    }
  }
  return PageRequest.$match(request, {
    First: () => ({ buffer: { ...done, rows: page.rows, base: 0, atStart: true, atEnd: page.complete }, shift: 0 }),
    Last: () => ({ buffer: { ...done, rows: page.rows, base: page.complete ? 0 : null, atStart: page.complete, atEnd: true }, shift: 0 }),
    After: () => append(page.complete),
    Before: () => prepend(page.complete, page.complete ? 0 : b.base === null ? null : b.base - page.rows.length),
    Offset: ({ offset }) =>
      b.base !== null && offset < b.base ? prepend(offset === 0, offset) : append(page.complete),
    // Starts over at the match, somewhere in the middle of the table.
    Seek: () => ({ buffer: { ...done, rows: page.rows, base: null, atStart: false, atEnd: page.complete }, shift: 0 }),
  })
}
