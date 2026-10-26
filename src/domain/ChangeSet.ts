// Changes made but not saved yet, across every table. Rows are identified by their
// key as it was read, so a change survives scrolling, reloads and sorting; new rows
// get an id of their own. Pure; `db/Edits.ts` turns a change set into SQL.
//
// Values are text for PostgreSQL to read as the column's type; null is NULL. A new
// row leaves out the columns that take their DEFAULT.

import { Data } from "effect"
import type { Table } from "../db/Catalog.ts"
import type { Row } from "../db/Rows.ts"

export type Cells = ReadonlyMap<number, string | null>

export type RowChange = Data.TaggedEnum<{
  /** Cells changed in a row as it was read (`original`, for the conflict check). */
  Update: { readonly original: Row; readonly cells: Cells }
  Delete: { readonly original: Row }
  Insert: { readonly cells: Cells }
}>
export const RowChange = Data.taggedEnum<RowChange>()

export interface Pending {
  readonly table: number
  readonly change: RowChange
  /** Values the server will not read as their column's type, by column. */
  readonly invalid: ReadonlyMap<number, string>
  /** Changed on the server since it was read; reloaded, so the next save writes over what is on screen. */
  readonly conflict: boolean
  /** Why the server refused this change at the last save. */
  readonly refused: string | null
}

/** By row id, in the order the changes were made. */
export type ChangeSet = ReadonlyMap<string, Pending>

export const empty: ChangeSet = new Map()

/** Why a relation cannot be edited, or null when it can. A row is found again by its key, so it needs one. */
export function whyReadOnly(table: Table): string | null {
  if (table.kind === "view") return "es una vista"
  if (table.kind === "matview") return "es una vista materializada"
  if (table.kind === "foreign") return "es una tabla externa"
  return table.key.length ? null : "no tiene clave primaria ni única con NOT NULL"
}

/** `oid:[key values]` for a row read from the table. */
export const rowId = (table: Table, row: Row): string => `${table.oid}:${JSON.stringify(table.key.map((i) => row.cells[i] ?? null))}`

/** `oid:+n` for the n-th new row. */
export const newRowId = (table: Table, n: number): string => `${table.oid}:+${n}`

const clean = { invalid: new Map<number, string>(), conflict: false, refused: null }

function put(changes: ChangeSet, id: string, pending: Pending | null): ChangeSet {
  const next = new Map(changes)
  if (pending) next.set(id, pending)
  else next.delete(id)
  return next
}

/** Set one cell of a read row (`original`) or of a new row (`original` null). Setting a cell back to what was read drops it. */
export function setCell(changes: ChangeSet, table: Table, id: string, original: Row | null, col: number, value: string | null): ChangeSet {
  const current = changes.get(id)
  if (current?.change._tag === "Delete") return changes
  const invalid = new Map(current?.invalid ?? [])
  invalid.delete(col)
  const base = { ...clean, ...current, table: table.oid, invalid, refused: null }
  if (!original) {
    const cells = new Map(current?.change._tag === "Insert" ? current.change.cells : [])
    cells.set(col, value)
    return put(changes, id, { ...base, change: RowChange.Insert({ cells }) })
  }
  const cells = new Map(current?.change._tag === "Update" ? current.change.cells : [])
  if (original.cells[col] === value) cells.delete(col)
  else cells.set(col, value)
  return put(changes, id, cells.size ? { ...base, change: RowChange.Update({ original, cells }) } : null)
}

/** ␣d on a new row: the column goes back to its DEFAULT. */
export function setDefault(changes: ChangeSet, id: string, col: number): ChangeSet {
  const current = changes.get(id)
  if (current?.change._tag !== "Insert") return changes
  const cells = new Map(current.change.cells)
  cells.delete(col)
  const invalid = new Map(current.invalid)
  invalid.delete(col)
  return put(changes, id, { ...current, invalid, change: RowChange.Insert({ cells }) })
}

export const insert = (changes: ChangeSet, table: Table, id: string): ChangeSet =>
  put(changes, id, { ...clean, table: table.oid, change: RowChange.Insert({ cells: new Map() }) })

/** dd: mark a read row for deletion, or unmark it; a new row just goes away. */
export function toggleDelete(changes: ChangeSet, table: Table, id: string, original: Row | null): ChangeSet {
  const current = changes.get(id)
  if (!original || current?.change._tag === "Insert") return put(changes, id, null)
  if (current?.change._tag === "Delete") return put(changes, id, null)
  return put(changes, id, { ...clean, table: table.oid, change: RowChange.Delete({ original }) })
}

/** The server's verdict on a value: null when it reads as the column's type. Ignored if the cell changed since. */
export function checked(changes: ChangeSet, id: string, col: number, value: string | null, problem: string | null): ChangeSet {
  const current = changes.get(id)
  if (!current || cellOf(current.change, col) !== value) return changes
  const invalid = new Map(current.invalid)
  if (problem === null) invalid.delete(col)
  else invalid.set(col, problem)
  return put(changes, id, { ...current, invalid })
}

/** The value a change sets in a column; undefined when it leaves the column alone. */
export function cellOf(change: RowChange, col: number): string | null | undefined {
  if (change._tag === "Delete") return undefined
  return change.cells.has(col) ? (change.cells.get(col) ?? null) : undefined
}

/** After a conflict: what the server has now becomes the row to write over; a row that is gone drops its change. */
export function rebase(changes: ChangeSet, id: string, now: Row | null): ChangeSet {
  const current = changes.get(id)
  if (!current || current.change._tag === "Insert") return changes
  if (!now) return put(changes, id, null)
  const change = current.change._tag === "Update" ? RowChange.Update({ ...current.change, original: now }) : RowChange.Delete({ original: now })
  return put(changes, id, { ...current, change, conflict: true })
}

export const refuse = (changes: ChangeSet, id: string, message: string): ChangeSet => {
  const current = changes.get(id)
  return current ? put(changes, id, { ...current, refused: message }) : changes
}

/** New rows of a table, in the order they were added. */
export const insertsOf = (changes: ChangeSet, table: number): ReadonlyArray<readonly [string, Pending]> =>
  [...changes].filter(([, p]) => p.table === table && p.change._tag === "Insert")

export const hasInvalid = (changes: ChangeSet): boolean => [...changes.values()].some((p) => p.invalid.size > 0)
