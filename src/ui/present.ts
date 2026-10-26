// How the workspace reads, for every renderer: colours, how values print, the
// status line, the key hints, the help, the row sheet's order and the review of
// pending changes. Each renderer (GPUIX in pixels, OpenTUI in cells) only lays
// these out.

import type { Env, Profile } from "../config/Profiles.ts"
import type { Catalog, Table } from "../db/Catalog.ts"
import * as Edits from "../db/Edits.ts"
import { MAX_CELL, type Row } from "../db/Rows.ts"
import * as ChangeSet from "../domain/ChangeSet.ts"
import * as RowBuffer from "../state/RowBuffer.ts"
import { position, SHEET_SECTIONS, sheetOrder, sheetSection, tableOf, type Workspace } from "../state/Workspace.ts"

/** Graphite base, one teal accent for "where you are", amber for "look at this", red only for production and danger. */
export const C = {
  bg: "#0C0E11",
  panel: "#111418",
  raised: "#171B20",
  line: "#20252C",
  lineSoft: "#181C22",
  text: "#D9DEE5",
  muted: "#8B95A3",
  faint: "#5B6471",
  ghost: "#363C45",
  accent: "#3DD6C4",
  accentSoft: "#3DD6C433",
  accentRow: "#3DD6C40F",
  onAccent: "#06211E",
  fk: "#8AB4F8",
  warn: "#E3B341",
  warnSoft: "#E3B34124",
  danger: "#F2555A",
  dangerSoft: "#F2555A1A",
  number: "#CDD5DE",
  bool: "#B79BF5",
  time: "#9AA5B1",
  json: "#E3A27A",
  local: "#3FB950",
  /** Dims the workspace behind a modal. */
  backdrop: "#05060899",
}

/** Cached: `toLocaleString` builds a formatter per call and showed up in profiles. */
export const NUM = new Intl.NumberFormat("es-ES")

/** 1.2k, 3.4M: row counts in tight spaces. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

export const ENV: Record<Env, { readonly label: string; readonly color: string }> = {
  local: { label: "LOCAL", color: C.local },
  staging: { label: "STAGING", color: C.warn },
  prod: { label: "PROD", color: C.danger },
}

export const address = (p: Profile) => `${p.user}@${p.host}:${p.port}/${p.database}`

export type ValueKind = "number" | "bool" | "time" | "json" | "uuid" | "text" | "other"

export function kindOf(type: string): ValueKind {
  if (/^(smallint|integer|bigint|numeric|real|double precision|money)\b/.test(type)) return "number"
  if (type === "boolean") return "bool"
  if (/^(timestamp|date|time|interval)\b/.test(type)) return "time"
  if (type === "json" || type === "jsonb") return "json"
  if (type === "uuid") return "uuid"
  if (/^(text|character|citext|name)\b/.test(type)) return "text"
  return "other"
}

/** One line, cut where the server cut it. `undefined` is a new row's DEFAULT. */
export function display(value: string | null | undefined): string {
  if (value === undefined) return "default"
  if (value === null) return "∅"
  const line = value.length > MAX_CELL ? `${value.slice(0, MAX_CELL)}…` : value
  return line.includes("\n") ? line.replace(/\r?\n/g, " ↵ ") : line
}

/** Why a table could never be edited, shown next to it. */
export function lockLabel(table: Table): string | null {
  if (table.kind === "view") return "vista"
  if (table.kind === "matview") return "vista materializada"
  if (table.key.length === 0) return "sin clave"
  return null
}

const VALUE_COLOR: Record<ValueKind, string> = { number: C.number, bool: C.bool, time: C.time, json: C.json, uuid: C.text, text: C.text, other: C.text }

export function valueColor(table: Table, col: number, value: string | null | undefined): string {
  const column = table.columns[col]
  if (value === null || value === undefined || !column) return C.faint
  if (column.references) return C.fk
  return VALUE_COLOR[kindOf(column.type)]
}

// ── Status line and hints ────────────────────────────────────────────────────

const MODE_LABEL: Partial<Record<Workspace["mode"]["_tag"], string>> = { Command: "COMANDO", Unlock: "COMANDO", Search: "BUSCAR", Edit: "EDITAR", Visual: "VISUAL", Review: "REVISAR" }

export const modeLabel = (ws: Workspace): string => MODE_LABEL[ws.mode._tag] ?? (ws.sheet ? "FICHA" : "NORMAL")

/** "fila 12 de ≈1.2k", "última fila", "fila nueva", or empty when the position is unknown. */
export function positionText(catalog: Catalog, ws: Workspace): string {
  if (ws.row < 0) return "fila nueva"
  if (ws.buffer.rows.length === 0) return ""
  const table = tableOf(catalog, ws)
  const exact = RowBuffer.exactCount(ws.buffer)
  // The estimate is for the whole table; a filtered view only has a count once it is all in memory.
  const total = exact ?? (ws.view.where ? null : (table?.estimate ?? null))
  const at = position(ws)
  const fromEnd = ws.buffer.rows.length - ws.row
  const where = at !== null ? `fila ${NUM.format(at)}` : !ws.buffer.atEnd ? "" : fromEnd === 1 ? "última fila" : `fila ${NUM.format(fromEnd)} desde el final`
  const of = !where || total === null ? "" : exact !== null ? ` de ${NUM.format(total)}` : ` de ≈${compact(total)}`
  return where + of
}

/** The open view's filter and order, as the status line shows them. */
export function viewText(catalog: Catalog, ws: Workspace): { readonly where: string | null; readonly sort: string | null } {
  const sorted = ws.view.sort ? tableOf(catalog, ws)?.columns[ws.view.sort.column] : undefined
  return {
    where: ws.view.where ? `where ${ws.view.where.replace(/\s+/g, " ")}` : null,
    sort: sorted && ws.view.sort ? `orden ${sorted.name} ${ws.view.sort.desc ? "↓" : "↑"}` : null,
  }
}

export type Hint = readonly [string, string]

/** The keys for what is on screen, most useful first. */
export function hints(catalog: Catalog, ws: Workspace): ReadonlyArray<Hint> {
  if (ws.focus === "tables" && ws.sidebar) return [["j k", "tabla"], ["⏎", "ver datos"], ["Tab", "ir a datos"], ["␣ e", "ocultar tablas"], ["?", "ayuda"]]
  if (ws.buffer.pending) return [["esc", "cancelar la lectura"], ["?", "ayuda"]]
  if (ws.mode._tag === "Visual") return [["j k", "ampliar"], ["d", "borrar las filas"], ["esc", "salir"]]
  const table = tableOf(catalog, ws)
  const items: Array<Hint> = [["h j k l", "moverse"]]
  if (ws.changes.size) items.push([":w", "revisar y guardar"], ["u", "deshacer"])
  if (!ws.locked) items.push(["i", "editar"], ["o", "nueva"], ["dd", "borrar"])
  items.push(["K", "ficha"], ["/", "buscar"], ["␣ ␣", "tabla"])
  if (ws.search) items.push(["n N", "siguiente / anterior"])
  if (table?.foreignKeys.some((fk) => fk.columns.includes(ws.col))) items.push(["gd", "seguir la clave"])
  if (table && catalog.incoming.has(table.oid)) items.push(["gr", "quién apunta aquí"])
  if (ws.back.length) items.push(["^o", "volver"])
  items.push(["gg G", "inicio / final"], ["Tab", ws.sidebar ? "tablas" : "mostrar tablas"], ["?", "ayuda"])
  return items
}

export const changesText = (n: number) => `${n} ${n === 1 ? "cambio" : "cambios"}`

// ── Pop-up content ───────────────────────────────────────────────────────────

export const WHICH_KEY: Record<"g" | "space" | "d", ReadonlyArray<Hint>> = {
  g: [
    ["g", "primera fila"],
    ["d", "seguir la clave foránea"],
    ["r", "filas que apuntan aquí"],
    ["t", "tabla siguiente"],
    ["T", "tabla anterior"],
  ],
  space: [
    ["␣", "buscar tabla"],
    ["n", "poner NULL"],
    ["d", "poner DEFAULT (fila nueva)"],
    ["e", "mostrar / ocultar tablas"],
    ["?", "todos los atajos"],
  ],
  d: [["d", "borrar la fila (otra vez: recuperarla)"]],
}

export const HELP: ReadonlyArray<readonly [string, ReadonlyArray<Hint>]> = [
  ["Moverse", [["h j k l", "celda"], ["w b", "5 columnas →/←"], ["0 $", "primera / última columna"], ["gg G", "primera / última fila"], ["^d ^u", "media página"], ["^f ^b", "página entera"]]],
  ["Tablas", [["␣ ␣", "buscar una tabla por su nombre"], ["Tab", "lista de tablas ↔ datos"], ["j k", "tabla (en la lista)"], ["gt gT", "tabla siguiente / anterior"], ["␣ e", "mostrar / ocultar la lista"]]],
  ["Buscar y filtrar", [["/texto", "buscar en todas las columnas"], ["n N", "coincidencia siguiente / anterior"], [":where", "condición SQL (vacío la quita)"], [":sort", "columna [desc] (vacío la quita)"], [":e", "volver a leer"], ["esc", "cancelar la lectura"]]],
  ["Relaciones", [["gd", "ir a la fila a la que apunta"], ["gr", "filas que apuntan a esta"], ["^o ^i", "atrás / adelante"]]],
  ["Fila", [["K", "ficha de la fila"], ["h l", "fila anterior / siguiente (en la ficha)"], ["y", "copiar la celda"]]],
  ["Editar", [["i ⏎  c", "editar la celda / escribirla de nuevo"], ["o", "fila nueva"], ["dd", "borrar la fila"], ["V … d", "borrar varias filas"], ["␣ n  ␣ d", "NULL / DEFAULT"], ["u", "deshacer"], [":w", "revisar y guardar"], [":e!", "descartar todos los cambios"], [":unlock", "editar en prod"]]],
  ["General", [[":q", "salir (:q! sin guardar)"], ["^c", "salir (en Ghostty, aunque haya cambios)"], ["?", "esta ayuda"], ["esc", "cerrar"]]],
]

/** A human name for the row: the first name-like text column, else its key. */
export function titleOf(table: Table, row: Row): string {
  const named = table.columns.findIndex((c) => /(^|_)(name|title|email|code|slug)$/.test(c.name) && kindOf(c.type) === "text")
  const text = named >= 0 ? named : table.columns.findIndex((c, i) => kindOf(c.type) === "text" && !table.key.includes(i))
  const value = text >= 0 ? row.cells[text] : null
  if (value) return display(value)
  return table.key.map((i) => `${table.columns[i]?.name} ${row.cells[i] ?? ""}`).join(" · ") || "Fila"
}

export type SheetEntry = { readonly kind: "section"; readonly label: string } | { readonly kind: "attr"; readonly col: number }

/** The row sheet's lines: section headings and attributes in sheet order. */
export function sheetEntries(table: Table): ReadonlyArray<SheetEntry> {
  const entries: Array<SheetEntry> = []
  let last = -1
  for (const col of sheetOrder(table)) {
    const section = sheetSection(table, col)
    if (section !== last) {
      entries.push({ kind: "section", label: SHEET_SECTIONS[section] ?? "" })
      last = section
    }
    entries.push({ kind: "attr", col })
  }
  return entries
}

/** One line of the :w review. */
export type ReviewLine =
  | { readonly kind: "table"; readonly key: string; readonly text: string }
  | { readonly kind: "change"; readonly key: string; readonly mark: string; readonly color: string; readonly label: string; readonly detail: string }
  | { readonly kind: "note"; readonly key: string; readonly color: string; readonly text: string }
  | { readonly kind: "sql"; readonly key: string; readonly text: string; readonly title: boolean }

/** Every change grouped by table, then the SQL the save runs. */
export function reviewLines(catalog: Catalog, changes: ChangeSet.ChangeSet): ReadonlyArray<ReviewLine> {
  const lines: Array<ReviewLine> = []
  const byTable = new Map<number, Array<readonly [string, ChangeSet.Pending]>>()
  for (const entry of changes) byTable.set(entry[1].table, [...(byTable.get(entry[1].table) ?? []), entry])
  for (const [oid, entries] of byTable) {
    const table = catalog.byOid.get(oid)
    if (!table) continue
    lines.push({ kind: "table", key: `t${oid}`, text: `${table.schema}.${table.name} · ${changesText(entries.length)}` })
    for (const [id, pending] of entries) lines.push(...changeLines(table, id, pending))
  }
  const statements = Edits.statements(catalog, changes)
  lines.push({ kind: "sql", key: "sql", title: true, text: `SQL · ${statements.length} ${statements.length === 1 ? "sentencia" : "sentencias"} en una transacción` })
  for (const [i, s] of statements.entries()) lines.push({ kind: "sql", key: `s${i}`, title: false, text: s.display })
  return lines
}

function changeLines(table: Table, id: string, pending: ChangeSet.Pending): ReadonlyArray<ReviewLine> {
  const name = (c: number) => table.columns[c]?.name ?? "?"
  const { change } = pending
  const label = change._tag === "Insert" ? "fila nueva" : table.key.map((i) => `${name(i)} ${display(change.original.cells[i] ?? null)}`).join(", ")
  const [mark, color] = change._tag === "Insert" ? ["+", C.accent] : change._tag === "Delete" ? ["−", C.danger] : ["~", C.warn]
  const detail =
    change._tag === "Update"
      ? [...change.cells].map(([c, v]) => `${name(c)}: ${display(change.original.cells[c] ?? null)} → ${display(v)}`).join("   ")
      : change._tag === "Insert"
        ? [...change.cells].map(([c, v]) => `${name(c)} = ${display(v)}`).join("   ") || "todo por defecto"
        : "se borra"
  const lines: Array<ReviewLine> = [{ kind: "change", key: id, mark, color, label, detail }]
  const problems = [...pending.invalid].map(([c, message]) => `${name(c)}: ${message}`)
  if (pending.refused) problems.push(pending.refused)
  for (const [i, problem] of problems.entries()) lines.push({ kind: "note", key: `${id}!${i}`, color: C.danger, text: problem })
  if (pending.conflict) lines.push({ kind: "note", key: `${id}?`, color: C.warn, text: "cambió en el servidor: se guarda encima de lo que ves ahora" })
  return lines
}
