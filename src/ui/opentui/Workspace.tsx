/** @jsxImportSource @opentui/react */
// Workspace, layout A in text: table list | grid | row inspector, with a status
// line and the keys for what is on screen. Each grid row is one line of text.

import { TextAttributes } from "@opentui/core"
import type { ReactNode } from "react"
import * as ChangeSet from "../../domain/ChangeSet.ts"
import type { Catalog, Table } from "../../db/Catalog.ts"
import type { Interface as Session } from "../../db/Session.ts"
import { newRows, position, tableOf, type Workspace } from "../../state/Workspace.ts"
import { C, changesText, compact, display, ENV, hints, kindOf, lockLabel, modeLabel, NUM, positionText, valueColor, viewText, type Hint } from "../present.ts"
import { columnWidths, gridViewport, MARK, workspaceLayout } from "./layout.ts"
import { CellEditor, CommandLine, Help, ReferencesPicker, Review, RowSheet, TableFinder, WhichKey } from "./Overlays.tsx"
import { fit, solid, wash, width as cells } from "./text.ts"

export function WorkspaceView({ session, ws, width, height, onSubmit, onInput }: { session: Session; ws: Workspace; width: number; height: number; onSubmit: (text: string) => void; onInput: (text: string) => void }) {
  const { catalog, target } = session
  const layout = workspaceLayout(ws, width, height)
  const open = tableOf(catalog, ws)
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>
      <TopBar session={session} ws={ws} width={width} />
      <box height={layout.bodyH} flexDirection="row">
        {layout.sideW > 0 && <Sidebar catalog={catalog} ws={ws} width={layout.sideW} height={layout.bodyH} />}
        <Grid catalog={catalog} ws={ws} width={layout.gridW} height={layout.bodyH} />
        {layout.inspW > 0 && <Inspector catalog={catalog} ws={ws} width={layout.inspW} height={layout.bodyH} />}
      </box>
      <StatusLine catalog={catalog} ws={ws} width={width} />
      <box height={1} paddingLeft={1}>
        <Hints items={hints(catalog, ws)} />
      </box>
      {ws.sheet && open && <RowSheet catalog={catalog} ws={ws} width={width} height={height} />}
      {ws.prefix && <WhichKey prefix={ws.prefix} height={height} />}
      {ws.mode._tag === "Command" && <CommandLine prompt=":" width={width} height={height} onSubmit={onSubmit} />}
      {ws.mode._tag === "Search" && <CommandLine prompt="/" width={width} height={height} onSubmit={onSubmit} />}
      {ws.mode._tag === "Unlock" && <CommandLine prompt={`Escribe «${target.profile.database}» para editar en prod: `} width={width} height={height} onSubmit={onSubmit} />}
      {ws.mode._tag === "Edit" && open && <CellEditor key={`${ws.mode.target.id}:${ws.mode.col}`} catalog={catalog} table={open} ws={ws} mode={ws.mode} width={width} height={height} onInput={onInput} onSubmit={onSubmit} />}
      {ws.mode._tag === "Review" && <Review catalog={catalog} changes={ws.changes} scroll={ws.mode.scroll} saving={ws.saving} toast={ws.toast} width={width} height={height} />}
      {ws.mode._tag === "Help" && <Help scroll={ws.mode.scroll} width={width} height={height} />}
      {ws.mode._tag === "Finder" && <TableFinder catalog={catalog} query={ws.mode.query} selected={ws.mode.selected} current={ws.table} width={width} height={height} onInput={onInput} onSubmit={onSubmit} />}
      {ws.mode._tag === "References" && ws.table !== null && <ReferencesPicker catalog={catalog} incoming={catalog.incoming.get(ws.table) ?? []} selected={ws.mode.selected} width={width} height={height} />}
    </box>
  )
}

/** Key caps and what they do. `chip` is the caps' colour; on a raised card they take the background's. */
export function Hints({ items, chip = C.raised }: { items: ReadonlyArray<Hint>; chip?: string }) {
  return (
    <text>
      {items.map(([k, label]) => (
        <span key={k + label}>
          <span fg={C.text} bg={chip}>{` ${k} `}</span>
          <span fg={C.muted}>{` ${label}  `}</span>
        </span>
      ))}
    </text>
  )
}

function TopBar({ session, ws, width }: { session: Session; ws: Workspace; width: number }) {
  const { catalog, target } = session
  const { profile } = target
  const env = ENV[profile.env]
  const right = `${NUM.format(catalog.tables.length)} tablas · ${NUM.format(catalog.columnCount)} columnas `
  const left = [" qtty ", ` ● ${env.label} `, ` ${profile.user}@${profile.host}:${profile.port}/${profile.database} `, ws.locked ? " solo lectura · :unlock para editar " : " editable ", ws.changes.size ? ` ${changesText(ws.changes.size)} sin guardar · :w ` : ""]
  // The counts on the right go first when the line runs out of room.
  const room = width - cells(left.join(""))
  const counts = room > cells(right) ? " ".repeat(room - cells(right)) + right : ""
  return (
    <text bg={solid.topBar}>
      <span fg={C.text} attributes={TextAttributes.BOLD}>{left[0]}</span>
      <span fg={env.color} bg={wash(env.color, 0x22 / 255)} attributes={TextAttributes.BOLD}>{left[1]}</span>
      <span fg={C.muted}>{left[2]}</span>
      <span fg={ws.locked ? C.warn : C.faint}>{left[3]}</span>
      <span fg={C.warn} bg={solid.warn}>{left[4]}</span>
      <span fg={C.faint}>{counts}</span>
    </text>
  )
}

function StatusLine({ catalog, ws, width }: { catalog: Catalog; ws: Workspace; width: number }) {
  const table = tableOf(catalog, ws)
  const column = table?.columns[ws.col]
  const view = viewText(catalog, ws)
  const parts: Array<readonly [string, string]> = []
  if (table) parts.push([`${table.schema}.${table.name}`, C.text])
  if (view.where) parts.push([view.where, C.warn])
  if (view.sort) parts.push([view.sort, C.warn])
  const where = positionText(catalog, ws)
  if (where) parts.push([where, C.muted])
  if (column) parts.push([`${column.name}: ${column.type}`, C.muted])
  if (ws.buffer.pending) parts.push(["cargando…", C.faint])
  if (ws.buffer.error && ws.buffer.rows.length > 0) parts.push([ws.buffer.error, C.danger])
  if (ws.toast) parts.push([ws.toast, C.warn])
  const pill = ` ${modeLabel(ws)} `
  const lock = table ? (lockLabel(table) ?? "") : ""
  const text = parts.map(([t]) => ` ${t} `).join("")
  const gap = Math.max(1, width - cells(pill) - cells(text) - cells(lock) - 1)
  return (
    <text bg={C.panel}>
      <span fg={C.onAccent} bg={C.accent} attributes={TextAttributes.BOLD}>{pill}</span>
      {parts.map(([t, color], i) => (
        <span key={i} fg={color}>{` ${t} `}</span>
      ))}
      <span fg={C.faint}>{" ".repeat(gap) + lock + " "}</span>
    </text>
  )
}

function Sidebar({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const count = Math.max(1, height - 1)
  const tables = catalog.tables
  const at = Math.max(0, tables.findIndex((t) => t.oid === ws.table))
  // A window around the open table, with a schema heading wherever the schema changes.
  const start = Math.max(0, Math.min(tables.length - count, at - Math.floor(count / 2)))
  const lines: Array<{ readonly key: string; readonly node: ReactNode }> = []
  let lastSchema = start > 0 ? (tables[start - 1]?.schema ?? "") : ""
  const focused = ws.focus === "tables"
  for (let i = start; i < tables.length && lines.length < count; i++) {
    const table = tables[i]
    if (!table) break
    if (table.schema !== lastSchema) {
      lines.push({ key: `s:${table.schema}`, node: <text fg={C.faint} attributes={TextAttributes.BOLD}>{fit(` ${table.schema.toUpperCase()}`, width - 1)}</text> })
      lastSchema = table.schema
      if (lines.length >= count) break
    }
    const current = table.oid === ws.table
    const extra = lockLabel(table) ?? (table.estimate !== null ? compact(table.estimate) : "")
    const extraW = Math.min(10, cells(extra))
    const nameW = width - 4 - extraW
    lines.push({
      key: String(table.oid),
      node: (
        <text bg={current ? (focused ? solid.cursor : C.raised) : undefined}>
          <span fg={current ? C.accent : C.ghost}>{current ? "▌ " : "  "}</span>
          <span fg={current ? "#FFFFFF" : C.text}>{fit(table.name, nameW)}</span>
          <span fg={C.faint}>{` ${fit(extra, extraW, "right")}`}</span>
        </text>
      ),
    })
  }
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.panel}>
      <text>
        <span fg={focused ? C.accent : C.faint} attributes={TextAttributes.BOLD}>{" TABLAS"}</span>
        <span fg={C.faint}>{fit(`${NUM.format(at + 1)} / ${NUM.format(tables.length)}`, width - 8, "right")}</span>
      </text>
      {lines.map((line) => (
        <box key={line.key} height={1}>
          {line.node}
        </box>
      ))}
    </box>
  )
}

function Grid({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const table = tableOf(catalog, ws)
  if (!table) return <box width={width} height={height} />
  const fresh = newRows(ws)
  const widths = columnWidths(table)
  const viewport = gridViewport(table, width, height, fresh.length)
  const left = Math.max(1, ws.left)
  const count = Math.max(0, Math.min(viewport.colsFrom(left) + 1, table.columns.length - left))
  const visible = table.columns.length ? [0, ...Array.from({ length: count }, (_, i) => left + i)] : []
  // The last column is cut to what is left of the width.
  const shown: Array<readonly [number, number]> = []
  let used = MARK
  for (const ci of visible) {
    const w = Math.min(widths[ci] ?? 0, width - used - 1)
    if (w <= 0) break
    shown.push([ci, w])
    used += w + 1
  }
  const rows = ws.buffer.rows.slice(ws.top, ws.top + viewport.rows)
  const selection = ws.mode._tag === "Visual" ? ([Math.min(ws.mode.anchor, ws.row), Math.max(ws.mode.anchor, ws.row)] as const) : null
  const selected = (r: number) => selection !== null && r >= selection[0] && r <= selection[1]
  const key = new Set(table.key)
  const header = (line: 0 | 1) => (
    <text bg={C.panel}>
      <span>{" ".repeat(MARK)}</span>
      {shown.map(([ci, w]) => {
        const column = table.columns[ci]
        const active = ci === ws.col
        if (!column) return null
        if (line === 1) {
          const about = `${column.references ? `→ ${catalog.byOid.get(column.references.table)?.name ?? "?"}` : column.type}${column.nullable ? "" : " · not null"}`
          return (
            <span key={ci}>
              <span fg={C.faint}>{fit(about, w)}</span>
              <span fg={C.ghost}>│</span>
            </span>
          )
        }
        // As GPUIX: a dot before a key column, an arrow after a foreign key.
        const dot = key.has(ci) && w > 2 ? "● " : ""
        const arrow = column.references ? " →" : ""
        const nameW = Math.max(0, Math.min(cells(column.name), w - cells(dot) - cells(arrow)))
        return (
          <span key={ci}>
            <span fg={C.warn}>{dot}</span>
            <span fg={active ? C.accent : C.text} attributes={active ? TextAttributes.BOLD : 0}>
              {fit(column.name, nameW)}
            </span>
            <span fg={C.fk}>{fit(arrow, w - cells(dot) - nameW)}</span>
            <span fg={C.ghost}>│</span>
          </span>
        )
      })}
    </text>
  )
  return (
    <box width={width} height={height} flexDirection="column">
      {header(0)}
      {header(1)}
      {fresh.map(([id, pending], i) => {
        const r = i - fresh.length
        return <GridRow key={id} table={table} cells={cellsOf(table, null, pending)} pending={pending} shown={shown} cursorCol={r === ws.row ? ws.col : -1} selected={selected(r)} width={width} />
      })}
      {rows.map((row, i) => {
        const r = ws.top + i
        const pending = ws.changes.size ? (ws.changes.get(ChangeSet.rowId(table, row)) ?? null) : null
        return <GridRow key={r} table={table} cells={pending ? cellsOf(table, row.cells, pending) : row.cells} pending={pending} shown={shown} cursorCol={r === ws.row ? ws.col : -1} selected={selected(r)} width={width} />
      })}
      {rows.length === 0 && <Placeholder ws={ws} />}
    </box>
  )
}

/** What a row shows: the values read with the pending ones over them (`undefined`: DEFAULT, in a new row). */
function cellsOf(table: Table, read: ReadonlyArray<string | null> | null, pending: ChangeSet.Pending): ReadonlyArray<string | null | undefined> {
  return table.columns.map((_, i) => {
    const changed = ChangeSet.cellOf(pending.change, i)
    return changed !== undefined ? changed : read ? (read[i] ?? null) : undefined
  })
}

function markOf(pending: ChangeSet.Pending | null): string {
  if (!pending) return C.bg
  if (pending.refused || pending.invalid.size) return C.danger
  if (pending.change._tag === "Insert") return C.accent
  if (pending.change._tag === "Delete") return C.danger
  return C.warn
}

function GridRow({ table, cells: values, pending, shown, cursorCol, selected, width }: {
  table: Table
  cells: ReadonlyArray<string | null | undefined>
  pending: ChangeSet.Pending | null
  shown: ReadonlyArray<readonly [number, number]>
  cursorCol: number
  selected: boolean
  width: number
}) {
  const deleted = pending?.change._tag === "Delete"
  const rowBg = selected ? solid.selected : pending?.conflict ? solid.conflict : cursorCol >= 0 ? solid.row : undefined
  const used = MARK + shown.reduce((sum, [, w]) => sum + w + 1, 0)
  return (
    <text bg={rowBg}>
      <span fg={markOf(pending)}>{pending ? "▌" : " "}</span>
      {shown.map(([ci, w]) => {
        const value = values[ci]
        const cursor = ci === cursorCol
        const column = table.columns[ci]
        const numeric = column ? kindOf(column.type) === "number" : false
        const changed = pending ? ChangeSet.cellOf(pending.change, ci) !== undefined : false
        const invalid = pending?.invalid.has(ci) ?? false
        const fg = cursor ? "#FFFFFF" : deleted ? C.danger : value === undefined ? C.faint : changed ? C.warn : valueColor(table, ci, value)
        const bg = cursor ? solid.cursor : invalid ? "#4A1E20" : changed ? solid.changed : undefined
        return (
          <span key={ci}>
            <span fg={fg} bg={bg} attributes={deleted ? TextAttributes.STRIKETHROUGH : 0}>
              {fit(display(value), w, numeric && value !== null && value !== undefined ? "right" : "left")}
            </span>
            <span fg={C.ghost}>│</span>
          </span>
        )
      })}
      <span>{" ".repeat(Math.max(0, width - used))}</span>
    </text>
  )
}

function Placeholder({ ws }: { ws: Workspace }) {
  const { buffer } = ws
  const message = buffer.error ? buffer.error : buffer.pending ? "Cargando…" : buffer.atEnd ? "La tabla está vacía" : ""
  return (
    <box paddingLeft={2} paddingTop={1}>
      <text fg={buffer.error ? C.danger : C.faint}>{message}</text>
    </box>
  )
}

function Inspector({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const table = tableOf(catalog, ws)
  const row = ws.buffer.rows[ws.row]
  if (!table || !row) return <box width={width} height={height} backgroundColor={C.panel} />
  const count = Math.max(1, height - 3)
  const start = Math.max(0, Math.min(table.columns.length - count, ws.col - Math.floor(count / 2)))
  const keyText = table.key.map((i) => `${table.columns[i]?.name} = ${row.cells[i] ?? "∅"}`).join(", ")
  const nameW = Math.min(14, Math.floor(width / 2.5))
  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.panel} paddingLeft={1}>
      <text fg={C.text} attributes={TextAttributes.BOLD}>
        {fit(keyText || `Fila ${position(ws) ?? ""}`, width - 2)}
      </text>
      <text fg={C.faint}>{fit(`${table.columns.length} columnas · K abre la ficha`, width - 2)}</text>
      <text> </text>
      {table.columns.slice(start, start + count).map((column, i) => {
        const ci = start + i
        const value = row.cells[ci] ?? null
        const current = ci === ws.col
        const target = column.references ? catalog.byOid.get(column.references.table) : undefined
        return (
          <text key={ci} bg={current ? solid.row : undefined}>
            <span fg={current ? C.accent : C.muted}>{fit(column.name, nameW)} </span>
            <span fg={valueColor(table, ci, value)}>{fit(value !== null && target ? `${display(value)} → ${target.name}` : display(value), width - nameW - 3)}</span>
          </text>
        )
      })}
    </box>
  )
}
