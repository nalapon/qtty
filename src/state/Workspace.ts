// What the workspace screen shows: the open table and the view of it, the rows
// held in memory, the cursor and scroll, which panels and modes are active, where
// ^o goes back to, and the changes not saved yet. Pure functions only;
// `keys/vim.ts` turns key presses into new states and the App runs the commands.
//
// New rows sit pinned above the grid; the cursor reaches them with negative row
// numbers (-1 is the one right above the first loaded row).

import { Data } from "effect"
import * as ChangeSet from "../domain/ChangeSet.ts"
import type { Catalog, Table } from "../db/Catalog.ts"
import { PageRequest, pagingOf, wholeTable, type Match, type Page, type Row, type View } from "../db/Rows.ts"
import * as RowBuffer from "./RowBuffer.ts"

export type Mode = Data.TaggedEnum<{
  Normal: {}
  /** The `:` line. */
  Command: {}
  /** The `/` line. */
  Search: {}
  /** ?: every key; `scroll` is the first group shown. */
  Help: { readonly scroll: number }
  /** ␣␣: pick a table by typing part of its name. */
  Finder: { readonly query: string; readonly selected: number }
  /** gr with several foreign keys pointing at this table: which one to follow. */
  References: { readonly selected: number }
  /** Editing one cell; `text` starts the field and then follows it as it is typed. */
  Edit: { readonly target: Target; readonly col: number; readonly initial: string | null; readonly text: string; readonly multiline: boolean }
  /** V: rows from `anchor` to the cursor. */
  Visual: { readonly anchor: number }
  /** :w: the changes and their SQL, before saving. */
  Review: { readonly scroll: number }
  /** :unlock on a prod connection: type the database name. */
  Unlock: {}
}>
export const Mode = Data.taggedEnum<Mode>()
export type EditMode = Data.TaggedEnum.Value<Mode, "Edit">

export interface Workspace {
  /** Open table (oid); null when the database has no tables. */
  readonly table: number | null
  readonly view: View
  readonly buffer: RowBuffer.RowBuffer
  /** Cursor row, as an index into `buffer.rows`. */
  readonly row: number
  readonly col: number
  /** First visible row (buffer index). */
  readonly top: number
  /** First scrolled column; column 0 stays pinned on the left. */
  readonly left: number
  readonly mode: Mode
  readonly prefix: "" | "g" | "space" | "d"
  /** Which panel j/k drive. */
  readonly focus: "grid" | "tables"
  readonly sidebar: boolean
  /** Row modal (K): the current row as a grouped sheet. j/k walk its attributes. */
  readonly sheet: boolean
  readonly toast: string
  /** The last `/` text, for n and N. */
  readonly search: string | null
  /** Places ^o goes back to and ^i forward again to; the nearest last. */
  readonly back: ReadonlyArray<Place>
  readonly ahead: ReadonlyArray<Place>
  readonly changes: ChangeSet.ChangeSet
  /** Change sets before each change, for u. */
  readonly history: ReadonlyArray<ChangeSet.ChangeSet>
  /** New rows made so far; numbers their ids. */
  readonly added: number
  /** A prod connection until `:unlock`: no editing, and the server refuses writes. */
  readonly locked: boolean
  readonly saving: boolean
}

/** The row a change applies to: one read from the table (`original`) or a new one (`original` null). */
export interface Target {
  readonly table: number
  readonly id: string
  readonly original: Row | null
}

/** A spot in the data to come back to: the table, its view, the rows loaded and the cursor. */
export type Place = Pick<Workspace, "table" | "view" | "buffer" | "row" | "col" | "top" | "left">

/** How much of the grid fits on screen. Each renderer measures its own. */
export interface Viewport {
  readonly rows: number
  /** Columns that fit when `left` is the first scrolled one. */
  readonly colsFrom: (left: number) => number
}

export type Command = Data.TaggedEnum<{
  Load: { readonly table: number; readonly view: View; readonly request: PageRequest }
  /** Stop the read in flight; the server cancels its query. */
  Cancel: {}
  /** Ask the server whether `value` reads as the column's type. */
  Check: { readonly id: string; readonly col: number; readonly value: string; readonly type: string }
  /** Read a value the grid shows cut, then edit it. */
  FetchValue: { readonly target: Target; readonly col: number }
  /** Save every change in one transaction. */
  Save: {}
  Copy: { readonly text: string }
  Quit: {}
}>
export const Command = Data.taggedEnum<Command>()

/** Rows from the edge of the buffer at which the next page is requested. */
export const PREFETCH = 60
/** Places ^o remembers. Each keeps its rows, so going back is instant. */
export const MAX_JUMPS = 30
/** Changes u can take back. */
export const MAX_UNDO = 200

export const tableOf = (catalog: Catalog, ws: Workspace): Table | undefined => (ws.table === null ? undefined : catalog.byOid.get(ws.table))

export function initial(catalog: Catalog, locked: boolean): Workspace {
  return {
    table: catalog.tables[0]?.oid ?? null,
    view: wholeTable,
    buffer: RowBuffer.empty,
    row: 0,
    col: 0,
    top: 0,
    left: 1,
    mode: Mode.Normal(),
    prefix: "",
    focus: "tables",
    sidebar: true,
    sheet: false,
    toast: "",
    search: null,
    back: [],
    ahead: [],
    changes: ChangeSet.empty,
    history: [],
    added: 0,
    locked,
    saving: false,
  }
}

/** New rows of the open table, pinned above the grid. */
export const newRows = (ws: Workspace): ReadonlyArray<readonly [string, ChangeSet.Pending]> => (ws.table === null ? [] : ChangeSet.insertsOf(ws.changes, ws.table))

/** The row under the cursor, as something a change can apply to. */
export function targetAt(catalog: Catalog, ws: Workspace, row = ws.row): Target | null {
  const table = tableOf(catalog, ws)
  if (!table) return null
  if (row < 0) {
    const fresh = newRows(ws)
    const entry = fresh[fresh.length + row]
    return entry ? { table: table.oid, id: entry[0], original: null } : null
  }
  const original = ws.buffer.rows[row]
  return original ? { table: table.oid, id: ChangeSet.rowId(table, original), original } : null
}

/** What a cell shows: the pending value if there is one. `undefined` is DEFAULT, in a new row. */
export function cellValue(ws: Workspace, target: Target, col: number): string | null | undefined {
  const pending = ws.changes.get(target.id)
  const changed = pending ? ChangeSet.cellOf(pending.change, col) : undefined
  if (changed !== undefined) return changed
  return target.original ? (target.original.cells[col] ?? null) : undefined
}

/** Apply a change to the change set, remembering the one before for u. */
export function change(ws: Workspace, changes: ChangeSet.ChangeSet): Workspace {
  if (changes === ws.changes) return ws
  return { ...ws, changes, history: [...ws.history, ws.changes].slice(-MAX_UNDO) }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Clamp the cursor to what exists and scroll just enough to keep it on screen. */
export function settle(catalog: Catalog, ws: Workspace, viewport: Viewport): Workspace {
  const table = tableOf(catalog, ws)
  const rowCount = ws.buffer.rows.length
  const colCount = table?.columns.length ?? 0
  const row = clamp(ws.row, -newRows(ws).length, Math.max(0, rowCount - 1))
  const col = clamp(ws.col, 0, Math.max(0, colCount - 1))
  // Never scroll past the last loaded row: the bottom of the screen stays full.
  let top = clamp(ws.top, 0, Math.max(0, rowCount - viewport.rows))
  // New rows are pinned, so being on one scrolls nothing.
  if (row >= 0 && row < top) top = row
  if (row >= top + viewport.rows) top = row - viewport.rows + 1
  let left = clamp(ws.left, 1, Math.max(1, colCount - 1))
  if (col >= 1) {
    if (col < left) left = col
    while (left < col && col >= left + viewport.colsFrom(left)) left++
  }
  return { ...ws, row, col, top, left }
}

/** Open another table, all of it, at its first row. */
export function open(ws: Workspace, table: number): Workspace {
  return { ...ws, table, view: wholeTable, buffer: RowBuffer.empty, row: 0, col: 0, top: 0, left: 1, sheet: false, toast: "" }
}

/**
 * Read the open view again from the first row on screen, e.g. after a save. The rows
 * above it come back as the cursor nears them.
 */
export function refresh(catalog: Catalog, ws: Workspace): [Workspace, Command | null] {
  const table = tableOf(catalog, ws)
  if (!table) return [ws, null]
  const above = ws.buffer.rows[ws.top - 1]
  if (!above || pagingOf(table) === "offset") return restart(ws, PageRequest.First())
  const request = PageRequest.After({ key: above.key })
  const base = ws.buffer.base === null ? null : ws.buffer.base + ws.top
  return [{ ...ws, buffer: { ...RowBuffer.reset(request), base }, row: Math.max(0, ws.row - ws.top), top: 0 }, load(ws, request)]
}

/** A read of the open table through its view. */
export const load = (ws: Workspace, request: PageRequest): Command | null =>
  ws.table === null ? null : Command.Load({ table: ws.table, view: ws.view, request })

/** Start the open table over with `request`, e.g. after its view changed. */
export function restart(ws: Workspace, request: PageRequest): [Workspace, Command | null] {
  return [{ ...ws, buffer: RowBuffer.reset(request), row: 0, top: 0, toast: "" }, load(ws, request)]
}

/** Ask for the next or previous page when the cursor gets near an edge of the buffer. */
export function prefetch(catalog: Catalog, ws: Workspace): [Workspace, Command | null] {
  const table = tableOf(catalog, ws)
  if (!table) return [ws, null]
  const offset = pagingOf(table) === "offset"
  const b = ws.buffer
  const request =
    (ws.row >= b.rows.length - PREFETCH ? RowBuffer.nextRequest(b, offset) : null) ??
    (ws.row < PREFETCH ? RowBuffer.previousRequest(b, offset) : null)
  if (!request) return [ws, null]
  return [{ ...ws, buffer: RowBuffer.withPending(b, request) }, load(ws, request)]
}

/** Text search as `/` does it: smartcase, like Vim's `smartcase`. */
export const textMatch = (text: string) => ({ text, caseSensitive: text !== text.toLowerCase() })

export function contains(value: string | null, match: { readonly text: string; readonly caseSensitive: boolean }): boolean {
  if (value === null) return false
  return match.caseSensitive ? value.includes(match.text) : value.toLowerCase().includes(match.text.toLowerCase())
}

/** The column to put the cursor on in a row found by a seek. */
function matchedColumn(match: Match, row: Row | undefined, backwards: boolean): number | null {
  if (match._tag === "Equals") return match.columns[0] ?? null
  const cells = row?.cells ?? []
  const found = backwards ? cells.findLastIndex((v) => contains(v, match)) : cells.findIndex((v) => contains(v, match))
  return found < 0 ? null : found
}

/** Apply a page if it answers the request in flight for the open table. */
export function loaded(ws: Workspace, table: number, request: PageRequest, page: Page): Workspace {
  if (ws.table !== table || ws.buffer.pending !== request) return ws
  if (request._tag === "Seek" && page.rows.length === 0) {
    const toast = request.match._tag === "Text" ? `Sin más coincidencias de «${request.match.text}»` : "No se encontró la fila"
    return { ...ws, buffer: { ...ws.buffer, pending: null }, toast }
  }
  const { buffer, shift } = RowBuffer.apply(ws.buffer, request, page)
  // After jumping to the end, land on the last row.
  if (request._tag === "Last") {
    const last = Math.max(0, buffer.rows.length - 1)
    return { ...ws, buffer, row: last, top: Math.max(0, last - 10) }
  }
  if (request._tag === "Seek") return { ...ws, buffer, row: 0, top: 0, col: matchedColumn(request.match, page.rows[0], request.backwards) ?? ws.col }
  return { ...ws, buffer, row: Math.max(0, ws.row + shift), top: Math.max(0, ws.top + shift) }
}

export function loadFailed(ws: Workspace, table: number, request: PageRequest, message: string): Workspace {
  if (ws.table !== table || ws.buffer.pending !== request) return ws
  return { ...ws, buffer: RowBuffer.failed(ws.buffer, message) }
}

const placeOf = ({ table, view, buffer, row, col, top, left }: Workspace): Place => ({ table, view, buffer, row, col, top, left })

/** `next` jumps away from `ws`: ^o comes back to where `ws` was. */
export function jump(ws: Workspace, next: Workspace): Workspace {
  return { ...next, back: [...ws.back, placeOf(ws)].slice(-MAX_JUMPS), ahead: [] }
}

/** ^o and ^i. A place left with a read in flight asks for it again. */
export function travel(ws: Workspace, direction: "back" | "ahead"): [Workspace, Command | null] {
  const from = direction === "back" ? ws.back : ws.ahead
  const place = from.at(-1)
  if (!place) return [ws, null]
  const rest = from.slice(0, -1)
  const here = placeOf(ws)
  const next: Workspace = {
    ...ws,
    ...place,
    sheet: false,
    toast: "",
    back: direction === "back" ? rest : [...ws.back, here],
    ahead: direction === "back" ? [...ws.ahead, here] : rest,
  }
  return [next, place.buffer.pending ? load(next, place.buffer.pending) : null]
}

/** Position of the cursor row in the view (1-based), when known. */
export const position = (ws: Workspace): number | null => (ws.buffer.base === null ? null : ws.buffer.base + ws.row + 1)

export const SHEET_SECTIONS = ["Clave", "Relaciones", "Atributos", "Tiempos"] as const

/** Index into SHEET_SECTIONS for a column of the row sheet. */
export function sheetSection(table: Table, col: number): number {
  const c = table.columns[col]
  if (!c) return 2
  if (table.key.includes(col)) return 0
  if (table.foreignKeys.some((fk) => fk.columns.includes(col))) return 1
  if (/^timestamp/.test(c.type) && /^(created|updated|deleted)_at$/.test(c.name)) return 3
  return 2
}

/** Attribute order in the row sheet: key, relations, attributes, timestamps. */
export function sheetOrder(table: Table): ReadonlyArray<number> {
  const section = table.columns.map((_, i) => sheetSection(table, i))
  return table.columns.map((_, i) => i).sort((a, b) => (section[a] ?? 2) - (section[b] ?? 2) || a - b)
}

// ── Answers to edit commands ─────────────────────────────────────────────────

export function checked(ws: Workspace, command: { readonly id: string; readonly col: number; readonly value: string }, problem: string | null): Workspace {
  return { ...ws, changes: ChangeSet.checked(ws.changes, command.id, command.col, command.value, problem) }
}

/** The whole value arrived: edit it, unless the cursor moved on meanwhile. */
export function valueFetched(ws: Workspace, target: Target, col: number, value: string | null): Workspace {
  if (ws.mode._tag !== "Normal" || ws.col !== col || ws.buffer.rows[ws.row] !== target.original) return ws
  return { ...ws, mode: editMode(target, col, value), toast: "" }
}

/** Editing `value`; `blank` (c) starts from an empty field instead. */
export function editMode(target: Target, col: number, value: string | null, blank = false): Mode {
  const text = blank ? "" : (value ?? "")
  // A field that wraps for anything with line breaks or too long to read on one line.
  return Mode.Edit({ target, col, initial: value, text, multiline: text.includes("\n") || text.length > 120 })
}

export function saved(catalog: Catalog, ws: Workspace): [Workspace, Command | null] {
  const count = ws.changes.size
  const [next, command] = refresh(catalog, { ...ws, changes: ChangeSet.empty, history: [], saving: false, mode: Mode.Normal() })
  return [{ ...next, toast: `Guardado: ${count} ${count === 1 ? "cambio" : "cambios"}` }, command]
}

/** The server refused a statement: nothing was saved; the review shows why. */
export function saveRefused(ws: Workspace, id: string | null, message: string): Workspace {
  return { ...ws, saving: false, changes: id === null ? ws.changes : ChangeSet.refuse(ws.changes, id, message), toast: message }
}

/**
 * Rows changed on the server since they were read: nothing was saved. `now` is what
 * the server has for each (null when gone); the grid shows it under the changes, and
 * the next save writes over it.
 */
export function conflicted(catalog: Catalog, ws: Workspace, now: ReadonlyArray<readonly [string, Row | null]>): Workspace {
  const table = tableOf(catalog, ws)
  const fresh = new Map(now)
  const rows = table ? ws.buffer.rows.map((row) => fresh.get(ChangeSet.rowId(table, row)) ?? row) : ws.buffer.rows
  const changes = now.reduce((cs, [id, row]) => ChangeSet.rebase(cs, id, row), ws.changes)
  const gone = now.filter(([, row]) => row === null).length
  const toast = `${now.length} ${now.length === 1 ? "fila había cambiado" : "filas habían cambiado"} en el servidor y se han recargado${gone ? ` (${gone} ya no existen)` : ""}. :w guarda encima.`
  return { ...ws, buffer: { ...ws.buffer, rows }, changes, saving: false, mode: Mode.Normal(), toast }
}
