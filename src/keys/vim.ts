// Vim-style keys for the workspace. `reduce` and `submit` are pure: they return the
// next state and the commands to run (load a page, cancel, check a value, save,
// copy, quit). Keys are named like GPUIX names them: "j", "G", "ctrl-d", "space",
// "escape", "enter", "tab".

import * as ChangeSet from "../domain/ChangeSet.ts"
import type { Catalog, Incoming, Table } from "../db/Catalog.ts"
import { ident, literal, Match, MAX_CELL, pagingOf, PageRequest, type View } from "../db/Rows.ts"
import * as RowBuffer from "../state/RowBuffer.ts"
import { findTables } from "../state/TableFinder.ts"
import {
  cellValue,
  change,
  Command,
  contains,
  editMode,
  jump,
  load,
  Mode,
  open,
  prefetch,
  restart,
  settle,
  sheetOrder,
  tableOf,
  targetAt,
  textMatch,
  travel,
  type EditMode,
  type Viewport,
  type Workspace,
} from "../state/Workspace.ts"

export interface Context {
  readonly catalog: Catalog
  readonly viewport: Viewport
  /** Name of the database, which `:unlock` asks to type. */
  readonly database: string
}

type Step = [Workspace, Command | null]

/** Any change may leave the cursor near the edge of what is loaded, or open a table with nothing loaded yet. */
function finish(ctx: Context, [next, command]: Step): [Workspace, ReadonlyArray<Command>] {
  const [fetched, more] = prefetch(ctx.catalog, next)
  return [fetched, [command, more].filter((c) => c !== null)]
}

export function reduce(ctx: Context, ws: Workspace, key: string): [Workspace, ReadonlyArray<Command>] {
  return finish(ctx, step(ctx, ws, key))
}

/** Enter in a text field: the `:` and `/` lines, the table finder, a one-line cell editor, `:unlock`. */
export function submit(ctx: Context, ws: Workspace, text: string): [Workspace, ReadonlyArray<Command>] {
  const done = { ...ws, mode: Mode.Normal() }
  switch (ws.mode._tag) {
    case "Command":
      return finish(ctx, command(ctx, done, text))
    case "Search":
      return finish(ctx, text ? findNext(ctx, { ...done, search: text }, false) : [done, null])
    case "Finder":
      return finish(ctx, pickTable(ctx, ws, ws.mode))
    case "Edit":
      return finish(ctx, commitEdit(ctx, ws, ws.mode, text))
    case "Unlock":
      if (text.trim() !== ctx.database) return [{ ...done, toast: "No coincide con el nombre de la base: sigue bloqueada" }, []]
      return [{ ...done, locked: false, toast: "Editable hasta cerrar la sesión" }, []]
    default:
      return [ws, []]
  }
}

/** A text field changed: the table finder narrows as you type; the cell editor keeps the text for esc. */
export function typed(ws: Workspace, text: string): Workspace {
  if (ws.mode._tag === "Finder") return { ...ws, mode: Mode.Finder({ query: text, selected: 0 }) }
  if (ws.mode._tag === "Edit") return { ...ws, mode: Mode.Edit({ ...ws.mode, text }) }
  return ws
}

/** `:` commands. `ws` is already back in normal mode. */
function command(ctx: Context, ws: Workspace, input: string): Step {
  const [, name = "", rest = ""] = /^(\S*)\s*(.*)$/s.exec(input.trim()) ?? []
  const arg = rest.trim()
  switch (name) {
    case "":
      return [ws, null]
    case "q":
    case "quit":
      return ws.changes.size ? [{ ...ws, toast: unsaved(ws) }, null] : [ws, Command.Quit()]
    case "q!":
      return [ws, Command.Quit()]
    case "w":
      if (ws.saving) return [{ ...ws, toast: "Guardando…" }, null]
      return ws.changes.size ? [{ ...ws, mode: Mode.Review({ scroll: 0 }), toast: "" }, null] : [{ ...ws, toast: "No hay cambios" }, null]
    case "e!": {
      const toast = ws.changes.size ? "Cambios descartados" : ""
      const discarded = { ...ws, changes: ChangeSet.empty, history: [] }
      if (ws.table === null) return [{ ...discarded, toast }, null]
      const [next, load] = restart(discarded, PageRequest.First())
      return [{ ...next, toast }, load]
    }
    case "unlock":
      return ws.locked ? [{ ...ws, mode: Mode.Unlock() }, null] : [{ ...ws, toast: "La conexión ya es editable" }, null]
    case "where":
      return reView(ws, { ...ws.view, where: arg || null })
    case "sort":
      return sortBy(ctx, ws, arg)
    case "e":
      return ws.table === null ? [ws, null] : restart(ws, PageRequest.First())
    default:
      return [{ ...ws, toast: `Comando desconocido: ${name}` }, null]
  }
}

function reView(ws: Workspace, view: View): Step {
  if (ws.table === null) return [ws, null]
  return restart({ ...ws, view }, PageRequest.First())
}

/** `:sort col [asc|desc]`; `:sort` alone goes back to key order. */
function sortBy(ctx: Context, ws: Workspace, arg: string): Step {
  const table = tableOf(ctx.catalog, ws)
  if (!table) return [ws, null]
  if (!arg) return reView(ws, { ...ws.view, sort: null })
  const words = arg.split(/\s+/)
  const last = words.at(-1)?.toLowerCase()
  const direction = words.length > 1 && (last === "asc" || last === "desc") ? last : null
  const name = direction ? words.slice(0, -1).join(" ") : arg
  const exact = table.columns.findIndex((c) => c.name === name)
  const column = exact >= 0 ? exact : table.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())
  if (column < 0) return [{ ...ws, toast: `No hay ninguna columna «${name}» en ${table.name}` }, null]
  return reView({ ...ws, col: column }, { ...ws.view, sort: { column, desc: direction === "desc" } })
}

/** In the key list: j k scroll it a group at a time (it may not fit the screen; the view stops at
 *  the last group, as Review's does at its last line); esc, q or ? close it. */
function helpKey(ws: Workspace, mode: { readonly scroll: number }, key: string): Workspace {
  if (key === "escape" || key === "q" || key === "?") return { ...ws, mode: Mode.Normal() }
  if (key === "j" || key === "down") return { ...ws, mode: Mode.Help({ scroll: mode.scroll + 1 }) }
  if (key === "k" || key === "up") return { ...ws, mode: Mode.Help({ scroll: Math.max(0, mode.scroll - 1) }) }
  return ws
}

const unsaved = (ws: Workspace) => `${ws.changes.size} ${ws.changes.size === 1 ? "cambio" : "cambios"} sin guardar: :w guarda, :q! sale sin guardar`

/** Keys that move the cursor while V selects rows. */
const VISUAL_MOVES = new Set(["j", "k", "down", "up", "G", "g", "ctrl-d", "ctrl-u", "ctrl-f", "ctrl-b"])

function step(ctx: Context, ws: Workspace, key: string): Step {
  const { catalog, viewport } = ctx
  if (key === "ctrl-c") return ws.changes.size ? [{ ...ws, toast: unsaved(ws) }, null] : [ws, Command.Quit()]
  switch (ws.mode._tag) {
    case "Help":
      return [helpKey(ws, ws.mode, key), null]
    case "Command":
    case "Search":
      return [key === "escape" ? { ...ws, mode: Mode.Normal() } : ws, null]
    case "Finder":
      return [finderKey(ctx, ws, ws.mode, key), null]
    case "References":
      return referencesKey(ctx, ws, ws.mode, key)
    case "Edit":
      // Typing stays in the field; esc keeps what was typed (u takes it back).
      return key === "escape" ? commitEdit(ctx, ws, ws.mode, ws.mode.text) : [ws, null]
    case "Review":
      return reviewKey(ws, ws.mode, key)
    case "Unlock":
      return [key === "escape" ? { ...ws, mode: Mode.Normal() } : ws, null]
    case "Visual":
      if (key === "d") return [deleteRows(ctx, ws, ws.mode.anchor), null]
      if (key === "escape" || key === "V") return [{ ...ws, mode: Mode.Normal() }, null]
      if (!VISUAL_MOVES.has(key) && ws.prefix !== "g") return [ws, null]
      break
    case "Normal":
      break
  }

  const table = tableOf(catalog, ws)
  const rows = ws.buffer.rows
  const fit = (next: Workspace) => settle(catalog, next, viewport)
  const move = (dRow: number, dCol: number) => {
    // Leaving the pinned new rows lands on the first row on screen, wherever the grid is scrolled.
    const row = ws.row < 0 && ws.row + dRow >= 0 ? ws.top + ws.row + dRow : ws.row + dRow
    return fit({ ...ws, prefix: "", toast: "", row, col: ws.col + dCol })
  }

  if (ws.prefix === "g") {
    const base = { ...ws, prefix: "" as const }
    if (key === "g") return toStart(ctx, base)
    if (key === "t") return [stepTable(ctx, base, 1), null]
    if (key === "T") return [stepTable(ctx, base, -1), null]
    if (key === "d") return follow(ctx, base)
    if (key === "r") return references(ctx, base)
    return [base, null]
  }
  if (ws.prefix === "d") {
    const base = { ...ws, prefix: "" as const }
    return key === "d" ? [toggleDelete(ctx, base), null] : [base, null]
  }
  if (ws.prefix === "space") {
    const base = { ...ws, prefix: "" as const }
    if (key === "space") return [{ ...base, mode: Mode.Finder({ query: "", selected: 0 }) }, null]
    if (key === "n") return setNull(ctx, base)
    if (key === "d") return [setDefault(ctx, base), null]
    if (key === "e") return [fit({ ...base, sidebar: !ws.sidebar, focus: "grid" }), null]
    if (key === "?") return [{ ...base, mode: Mode.Help({ scroll: 0 }) }, null]
    return [base, null]
  }

  // Row sheet: j/k walk the attributes, h/l the rows. Other keys work as on the grid.
  if (ws.sheet) {
    if (key === "escape" || key === "q" || key === "K") return [fit({ ...ws, sheet: false, toast: "" }), null]
    if (key === "j" || key === "down") return [moveSheet(ctx, ws, 1), null]
    if (key === "k" || key === "up") return [moveSheet(ctx, ws, -1), null]
    if (key === "h" || key === "left") return [move(-1, 0), null]
    if (key === "l" || key === "right") return [move(1, 0), null]
    if (key === "tab") return [ws, null]
  }
  if (key === "K") return [rows.length ? { ...ws, sheet: true, focus: "grid", toast: "" } : ws, null]

  // Tab moves between the table list and the grid; it also brings back a hidden list.
  if (key === "tab") return [ws.sidebar ? { ...ws, focus: ws.focus === "grid" ? "tables" : "grid" } : { ...ws, sidebar: true, focus: "tables" }, null]
  if (ws.focus === "tables" && ws.sidebar) {
    if (key === "j" || key === "down") return [stepTable(ctx, ws, 1), null]
    if (key === "k" || key === "up") return [stepTable(ctx, ws, -1), null]
    if (key === "enter" || key === "l" || key === "right") return [{ ...ws, focus: "grid" }, null]
  }

  const half = Math.max(1, Math.floor(viewport.rows / 2))
  switch (key) {
    case "j":
    case "down":
      return [move(1, 0), null]
    case "k":
    case "up":
      return [move(-1, 0), null]
    case "h":
    case "left":
      return [move(0, -1), null]
    case "l":
    case "right":
      return [move(0, 1), null]
    case "w":
      return [move(0, 5), null]
    case "b":
      return [move(0, -5), null]
    case "0":
      return [fit({ ...ws, col: 0 }), null]
    case "$":
      return [fit({ ...ws, col: (table?.columns.length ?? 1) - 1 }), null]
    case "G":
      return toEnd(ctx, ws)
    case "ctrl-d":
      return [fit({ ...ws, top: ws.top + half, row: ws.row + half }), null]
    case "ctrl-u":
      return [fit({ ...ws, top: ws.top - half, row: ws.row - half }), null]
    case "ctrl-f":
      return [move(viewport.rows, 0), null]
    case "ctrl-b":
      return [move(-viewport.rows, 0), null]
    // No `fit`: the place was settled when it was left, and the viewport here measures the table being left.
    case "ctrl-o":
      return travel(ws, "back")
    case "ctrl-i":
      return travel(ws, "ahead")
    case "i":
    case "enter":
      return beginEdit(ctx, ws, false)
    case "c":
      return beginEdit(ctx, ws, true)
    case "o":
      return [addRow(ctx, ws), null]
    case "d":
      return [{ ...ws, prefix: "d" }, null]
    case "V":
      return [ws.row >= 0 && rows.length ? { ...ws, mode: Mode.Visual({ anchor: ws.row }), focus: "grid" } : ws, null]
    case "u": {
      const previous = ws.history.at(-1)
      if (!previous) return [{ ...ws, toast: "Nada que deshacer" }, null]
      return [fit({ ...ws, changes: previous, history: ws.history.slice(0, -1), toast: "Deshecho" }), null]
    }
    case "g":
      return [{ ...ws, prefix: "g" }, null]
    case "space":
      return [{ ...ws, prefix: "space" }, null]
    case ":":
      return [{ ...ws, mode: Mode.Command(), prefix: "" }, null]
    case "/":
      return [{ ...ws, mode: Mode.Search(), prefix: "", focus: "grid" }, null]
    case "n":
    case "N":
      return findNext(ctx, ws, key === "N")
    case "?":
      return [{ ...ws, mode: Mode.Help({ scroll: 0 }) }, null]
    case "y": {
      const value = rows[ws.row]?.cells[ws.col]
      if (value === undefined) return [ws, null]
      if (value === null) return [{ ...ws, toast: "NULL no se copia" }, null]
      return [{ ...ws, toast: "Copiado" }, Command.Copy({ text: value })]
    }
    case "escape":
      return cancel(ws)
  }
  return [ws, null]
}

/** esc while reading: stop the read. A cancelled page stays failed until the view changes (or `:e`). */
function cancel(ws: Workspace): Step {
  const pending = ws.buffer.pending
  if (!pending) return [{ ...ws, prefix: "", toast: "" }, null]
  if (pending._tag === "Seek") return [{ ...ws, buffer: { ...ws.buffer, pending: null }, toast: "Búsqueda cancelada" }, Command.Cancel()]
  return [{ ...ws, buffer: RowBuffer.failed(ws.buffer, "Lectura cancelada"), toast: "" }, Command.Cancel()]
}

/** gg: the first row, reloading from the start if it is not in memory. */
function toStart(ctx: Context, ws: Workspace): Step {
  if (ws.buffer.atStart || ws.table === null) return [jump(ws, settle(ctx.catalog, { ...ws, row: 0 }, ctx.viewport)), null]
  const [next, command] = restart(ws, PageRequest.First())
  return [jump(ws, next), command]
}

/** G: the last row, reading the end of the table if it is not in memory. */
function toEnd(ctx: Context, ws: Workspace): Step {
  const table = tableOf(ctx.catalog, ws)
  if (!table || ws.buffer.atEnd) return [jump(ws, settle(ctx.catalog, { ...ws, row: ws.buffer.rows.length - 1 }, ctx.viewport)), null]
  if (pagingOf(table) === "offset") return [{ ...ws, toast: "Sin clave ni orden: no se puede saltar al final" }, null]
  const request = PageRequest.Last()
  return [jump(ws, { ...ws, buffer: RowBuffer.reset(request), toast: "" }), load(ws, request)]
}

/** n / N: the next match after the cursor (before it, with N): in the rows in memory first, then on the server. */
function findNext(ctx: Context, ws: Workspace, backwards: boolean): Step {
  const table = tableOf(ctx.catalog, ws)
  if (!ws.search || !table) return [ws, null]
  const match = textMatch(ws.search)
  const rows = ws.buffer.rows
  const width = table.columns.length
  const dir = backwards ? -1 : 1
  // Cell by cell, row after row, starting next to the cursor.
  for (let r = ws.row, c = ws.col + dir; r >= 0 && r < rows.length; r += dir, c = backwards ? width - 1 : 0) {
    const cells = rows[r]?.cells ?? []
    for (; c >= 0 && c < width; c += dir) {
      if (contains(cells[c] ?? null, match)) return [jump(ws, settle(ctx.catalog, { ...ws, row: r, col: c, toast: "" }, ctx.viewport)), null]
    }
  }
  const b = ws.buffer
  if (backwards ? b.atStart : b.atEnd) return [{ ...ws, toast: `Sin más coincidencias de «${ws.search}»` }, null]
  if (pagingOf(table) === "offset") return [{ ...ws, toast: "Sin clave: solo se busca en las filas cargadas" }, null]
  const edge = backwards ? rows[0] : rows.at(-1)
  const request = PageRequest.Seek({ match: Match.Text(match), from: edge?.key ?? null, backwards })
  return [jump(ws, { ...ws, buffer: RowBuffer.withPending(b, request), toast: "" }), load(ws, request)]
}

/** gd: open the row this foreign key points at, in the whole referenced table. */
function follow(ctx: Context, ws: Workspace): Step {
  const table = tableOf(ctx.catalog, ws)
  const row = ws.buffer.rows[ws.row]
  if (!table || !row) return [ws, null]
  const fk = table.foreignKeys.find((f) => f.columns.includes(ws.col))
  if (!fk) return [{ ...ws, toast: "Esta columna no es una clave foránea" }, null]
  const target = ctx.catalog.byOid.get(fk.table)
  const columns = target ? fk.targetColumns.map((name) => target.columns.findIndex((c) => c.name === name)) : []
  if (!target || columns.some((i) => i < 0)) return [{ ...ws, toast: "La tabla referenciada no está en el catálogo" }, null]
  const values = fk.columns.flatMap((i) => row.cells[i] ?? [])
  if (values.length !== fk.columns.length) return [{ ...ws, toast: "NULL: no apunta a ninguna fila" }, null]
  const request = PageRequest.Seek({ match: Match.Equals({ columns, values }), from: null, backwards: false })
  const next = { ...open(ws, target.oid), buffer: RowBuffer.reset(request), col: columns[0] ?? 0, focus: "grid" as const }
  return [jump(ws, next), load(next, request)]
}

/** gr: the rows elsewhere that point at this one. With several foreign keys, asks which. */
function references(ctx: Context, ws: Workspace): Step {
  if (ws.table === null || !ws.buffer.rows[ws.row]) return [ws, null]
  const incoming = ctx.catalog.incoming.get(ws.table) ?? []
  const [only] = incoming
  if (!only) return [{ ...ws, toast: "Ninguna tabla apunta a esta" }, null]
  if (incoming.length === 1) return followIncoming(ctx, ws, only)
  return [{ ...ws, mode: Mode.References({ selected: 0 }) }, null]
}

/** Open the table behind `incoming`, filtered to the rows pointing at the cursor row. */
function followIncoming(ctx: Context, ws: Workspace, incoming: Incoming): Step {
  const table = tableOf(ctx.catalog, ws)
  const source = ctx.catalog.byOid.get(incoming.table)
  const row = ws.buffer.rows[ws.row]
  if (!table || !source || !row) return [ws, null]
  const fk = incoming.foreignKey
  const values = fk.targetColumns.flatMap((name) => row.cells[table.columns.findIndex((c) => c.name === name)] ?? [])
  if (values.length !== fk.targetColumns.length) return [{ ...ws, toast: "NULL: ninguna fila puede apuntar aquí" }, null]
  const names = fk.columns.flatMap((i) => source.columns[i]?.name ?? []).map(ident)
  // A plain `:where`, so it shows in the status line and can be edited.
  const where = names.length === 1 ? `${names[0]} = ${literal(values[0] ?? "")}` : `(${names.join(", ")}) = (${values.map(literal).join(", ")})`
  const next = { ...open(ws, source.oid), view: { where, sort: null }, col: fk.columns[0] ?? 0, focus: "grid" as const, mode: Mode.Normal() }
  return [jump(ws, next), null]
}

function referencesKey(ctx: Context, ws: Workspace, mode: { readonly selected: number }, key: string): Step {
  const incoming = (ws.table === null ? undefined : ctx.catalog.incoming.get(ws.table)) ?? []
  const normal = { ...ws, mode: Mode.Normal() }
  switch (key) {
    case "j":
    case "down":
      return [{ ...ws, mode: Mode.References({ selected: Math.min(incoming.length - 1, mode.selected + 1) }) }, null]
    case "k":
    case "up":
      return [{ ...ws, mode: Mode.References({ selected: Math.max(0, mode.selected - 1) }) }, null]
    case "enter": {
      const chosen = incoming[mode.selected]
      return chosen ? followIncoming(ctx, normal, chosen) : [normal, null]
    }
    case "escape":
    case "q":
      return [normal, null]
  }
  return [ws, null]
}

/** Keys that reach the finder past its text field: moving through the matches and closing it. */
function finderKey(ctx: Context, ws: Workspace, mode: { readonly query: string; readonly selected: number }, key: string): Workspace {
  if (key === "escape") return { ...ws, mode: Mode.Normal() }
  const count = findTables(ctx.catalog, mode.query).length
  if (key === "down" || key === "ctrl-n" || key === "ctrl-j") return { ...ws, mode: Mode.Finder({ ...mode, selected: Math.min(count - 1, mode.selected + 1) }) }
  if (key === "up" || key === "ctrl-p" || key === "ctrl-k") return { ...ws, mode: Mode.Finder({ ...mode, selected: Math.max(0, mode.selected - 1) }) }
  return ws
}

function pickTable(ctx: Context, ws: Workspace, mode: { readonly query: string; readonly selected: number }): Step {
  const chosen = findTables(ctx.catalog, mode.query)[mode.selected]
  const normal = { ...ws, mode: Mode.Normal(), focus: "grid" as const }
  if (!chosen) return [{ ...normal, toast: `Ninguna tabla coincide con «${mode.query}»` }, null]
  if (chosen.oid === ws.table) return [normal, null]
  return [jump(ws, { ...open(ws, chosen.oid), mode: Mode.Normal(), focus: "grid" }), null]
}

function stepTable(ctx: Context, ws: Workspace, delta: number): Workspace {
  const tables = ctx.catalog.tables
  const at = tables.findIndex((t) => t.oid === ws.table)
  const next = tables[Math.max(0, Math.min(tables.length - 1, at + delta))]
  return next && next.oid !== ws.table ? open(ws, next.oid) : ws
}

function moveSheet(ctx: Context, ws: Workspace, delta: number): Workspace {
  const table = tableOf(ctx.catalog, ws)
  if (!table) return ws
  const order = sheetOrder(table)
  const at = order.indexOf(ws.col)
  return { ...ws, col: order[Math.max(0, Math.min(order.length - 1, at + delta))] ?? ws.col }
}

// ── Editing ──────────────────────────────────────────────────────────────────

/** Why the cursor's table cannot take changes right now, or null. */
function cannotEdit(table: Table | undefined, ws: Workspace): string | null {
  if (!table) return "No hay ninguna tabla abierta"
  if (ws.locked) return "Conexión prod bloqueada: :unlock para editar"
  if (ws.saving) return "Guardando…"
  const why = ChangeSet.whyReadOnly(table)
  return why ? `${table.name} no se puede editar: ${why}` : null
}

/** i / ⏎: edit the cell under the cursor; c: type it anew. A value the grid shows cut is read whole first. */
function beginEdit(ctx: Context, ws: Workspace, blank: boolean): Step {
  const table = tableOf(ctx.catalog, ws)
  const why = cannotEdit(table, ws)
  if (why) return [{ ...ws, toast: why }, null]
  const column = table?.columns[ws.col]
  const target = targetAt(ctx.catalog, ws)
  if (!column || !target) return [ws, null]
  if (column.generated) return [{ ...ws, toast: `${column.name} es una columna generada: la calcula PostgreSQL` }, null]
  if (ws.changes.get(target.id)?.change._tag === "Delete") return [{ ...ws, toast: "Fila marcada para borrar: dd la recupera" }, null]
  const value = cellValue(ws, target, ws.col)
  const pending = ws.changes.get(target.id)
  const typed = pending && ChangeSet.cellOf(pending.change, ws.col) !== undefined
  const editing = settle(ctx.catalog, { ...ws, sheet: false, toast: "" }, ctx.viewport)
  if (!blank && !typed && value && value.length > MAX_CELL) return [{ ...editing, toast: "Leyendo el valor completo…" }, Command.FetchValue({ target, col: ws.col })]
  return [{ ...editing, mode: editMode(target, ws.col, value ?? null, blank) }, null]
}

/** Esc or Enter in the cell editor: the text becomes a pending change, and the server is asked whether it fits the type. */
function commitEdit(ctx: Context, ws: Workspace, mode: Pick<EditMode, "target" | "col" | "initial">, text: string): Step {
  const normal = { ...ws, mode: Mode.Normal() }
  const table = ctx.catalog.byOid.get(mode.target.table)
  // Nothing typed over a NULL (or a DEFAULT) leaves it as it was.
  if (!table || text === (mode.initial ?? "")) return [normal, null]
  const next = change(normal, ChangeSet.setCell(ws.changes, table, mode.target.id, mode.target.original, mode.col, text))
  const type = table.columns[mode.col]?.type
  return [next, type ? Command.Check({ id: mode.target.id, col: mode.col, value: text, type }) : null]
}

/** o: a new row, pinned above the grid, editing its first column that has no default. */
function addRow(ctx: Context, ws: Workspace): Workspace {
  const table = tableOf(ctx.catalog, ws)
  const why = cannotEdit(table, ws)
  if (why || !table) return { ...ws, toast: why ?? "" }
  const added = ws.added + 1
  const id = ChangeSet.newRowId(table, added)
  const needed = table.columns.findIndex((c) => !c.generated && !c.identity && c.defaultExpr === null)
  const col = needed >= 0 ? needed : 0
  const next = change({ ...ws, added, row: -1, col, sheet: false, focus: "grid", toast: "" }, ChangeSet.insert(ws.changes, table, id))
  return { ...settle(ctx.catalog, next, ctx.viewport), mode: editMode({ table: table.oid, id, original: null }, col, null) }
}

/** dd: mark the row for deletion, or take the mark back; a new row just goes. */
function toggleDelete(ctx: Context, ws: Workspace): Workspace {
  const table = tableOf(ctx.catalog, ws)
  const why = cannotEdit(table, ws)
  const target = targetAt(ctx.catalog, ws)
  if (why || !table || !target) return { ...ws, toast: why ?? "" }
  return settle(ctx.catalog, change(ws, ChangeSet.toggleDelete(ws.changes, table, target.id, target.original)), ctx.viewport)
}

/** V … d: mark every row in the selection for deletion. */
function deleteRows(ctx: Context, ws: Workspace, anchor: number): Workspace {
  const table = tableOf(ctx.catalog, ws)
  const why = cannotEdit(table, ws)
  const normal = { ...ws, mode: Mode.Normal() }
  if (why || !table) return { ...normal, toast: why ?? "" }
  let changes = ws.changes
  for (let r = Math.min(anchor, ws.row); r <= Math.max(anchor, ws.row); r++) {
    const target = targetAt(ctx.catalog, ws, r)
    if (target && changes.get(target.id)?.change._tag !== "Delete") changes = ChangeSet.toggleDelete(changes, table, target.id, target.original)
  }
  return settle(ctx.catalog, change(normal, changes), ctx.viewport)
}

/** ␣n: NULL in the cell. A NOT NULL column is marked right away. */
function setNull(ctx: Context, ws: Workspace): Step {
  const table = tableOf(ctx.catalog, ws)
  const why = cannotEdit(table, ws)
  const column = table?.columns[ws.col]
  const target = targetAt(ctx.catalog, ws)
  if (why || !table || !column || !target) return [{ ...ws, toast: why ?? "" }, null]
  if (column.generated) return [{ ...ws, toast: `${column.name} es una columna generada: la calcula PostgreSQL` }, null]
  let changes = ChangeSet.setCell(ws.changes, table, target.id, target.original, ws.col, null)
  if (!column.nullable) changes = ChangeSet.checked(changes, target.id, ws.col, null, `${column.name} no admite NULL`)
  return [change(ws, changes), null]
}

/** ␣d: the column's DEFAULT, in a new row. */
function setDefault(ctx: Context, ws: Workspace): Workspace {
  const target = targetAt(ctx.catalog, ws)
  if (!target || target.original) return { ...ws, toast: "DEFAULT solo en filas nuevas" }
  return change(ws, ChangeSet.setDefault(ws.changes, target.id, ws.col))
}

/** :w screen: ⏎ saves, j k scroll, esc goes back to editing. */
function reviewKey(ws: Workspace, mode: { readonly scroll: number }, key: string): Step {
  if (ws.saving) return [ws, null]
  switch (key) {
    case "escape":
    case "q":
      return [{ ...ws, mode: Mode.Normal() }, null]
    case "j":
    case "down":
      return [{ ...ws, mode: Mode.Review({ scroll: mode.scroll + 1 }) }, null]
    case "k":
    case "up":
      return [{ ...ws, mode: Mode.Review({ scroll: Math.max(0, mode.scroll - 1) }) }, null]
    case "enter":
      if (ChangeSet.hasInvalid(ws.changes)) return [{ ...ws, toast: "Hay valores que PostgreSQL no acepta: corrígelos antes de guardar" }, null]
      return [{ ...ws, saving: true, toast: "Guardando…" }, Command.Save()]
  }
  return [ws, null]
}
