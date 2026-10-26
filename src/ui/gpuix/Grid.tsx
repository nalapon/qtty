// The data grid. Only the visible rows and columns exist in the tree (plus one
// clipped column so it reaches the right edge); column 0 stays pinned. New rows
// sit pinned under the header; pending changes show over the values read.

import { memo } from "react"
import * as ChangeSet from "../../domain/ChangeSet.ts"
import type { Catalog, Table } from "../../db/Catalog.ts"
import { newRows, tableOf, type Workspace } from "../../state/Workspace.ts"
import { C, display, kindOf, valueColor } from "../present.ts"
import { columnWidths, gridViewport, HEAD_H, ROW_H } from "./layout.ts"
import { MONO, T } from "./theme.tsx"

export function Grid({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const table = tableOf(catalog, ws)
  const frame = { display: "flex", flexDirection: "column", width, height, overflow: "hidden", backgroundColor: C.bg } as const
  if (!table) return <div style={frame} />

  const fresh = newRows(ws)
  const widths = columnWidths(table)
  const viewport = gridViewport(table, width, height, fresh.length)
  const left = Math.max(1, ws.left)
  const count = Math.max(0, Math.min(viewport.colsFrom(left) + 1, table.columns.length - left))
  const visible = table.columns.length ? [0, ...Array.from({ length: count }, (_, i) => left + i)] : []
  const rows = ws.buffer.rows.slice(ws.top, ws.top + viewport.rows)
  const key = new Set(table.key)
  const selection = ws.mode._tag === "Visual" ? ([Math.min(ws.mode.anchor, ws.row), Math.max(ws.mode.anchor, ws.row)] as const) : null
  const selected = (r: number) => selection !== null && r >= selection[0] && r <= selection[1]

  return (
    <div style={frame}>
      <div style={{ display: "flex", height: HEAD_H, flexShrink: 0, borderBottomWidth: 1, borderColor: C.line, backgroundColor: C.panel }}>
        {visible.map((ci) => {
          const column = table.columns[ci]
          if (!column) return null
          const active = ci === ws.col
          return (
            <div
              key={ci}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                width: widths[ci],
                flexShrink: 0,
                paddingLeft: 8,
                paddingRight: 8,
                borderRightWidth: 1,
                borderColor: ci === 0 ? C.line : C.lineSoft,
                backgroundColor: active ? C.accentRow : undefined,
              }}
            >
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {key.has(ci) && (
                  <T size={10} color={C.warn}>
                    ●
                  </T>
                )}
                <T mono size={12} weight={active ? 700 : 500} color={active ? C.accent : C.text}>
                  {column.name}
                </T>
                {column.references && (
                  <T size={11} color={C.fk}>
                    →
                  </T>
                )}
              </div>
              <T mono size={10.5} color={C.faint}>
                {column.references ? `→ ${catalog.byOid.get(column.references.table)?.name ?? "?"}` : column.type}
                {column.nullable ? "" : " · not null"}
              </T>
            </div>
          )
        })}
      </div>
      {fresh.map(([id, pending], i) => {
        const r = i - fresh.length
        return <GridRow key={id} table={table} cells={cellsOf(table, null, pending)} pending={pending} cols={visible} widths={widths} cursorCol={r === ws.row ? ws.col : -1} selected={selected(r)} />
      })}
      {rows.map((row, i) => {
        const r = ws.top + i
        const pending = ws.changes.size ? (ws.changes.get(ChangeSet.rowId(table, row)) ?? null) : null
        return <GridRow key={r} table={table} cells={pending ? cellsOf(table, row.cells, pending) : row.cells} pending={pending} cols={visible} widths={widths} cursorCol={r === ws.row ? ws.col : -1} selected={selected(r)} />
      })}
      {rows.length === 0 && <Placeholder ws={ws} />}
    </div>
  )
}

/** What a row shows: the values read with the pending ones over them (`undefined`: DEFAULT, in a new row). */
function cellsOf(table: Table, read: ReadonlyArray<string | null> | null, pending: ChangeSet.Pending): ReadonlyArray<string | null | undefined> {
  return table.columns.map((_, i) => {
    const changed = ChangeSet.cellOf(pending.change, i)
    return changed !== undefined ? changed : read ? (read[i] ?? null) : undefined
  })
}

function Placeholder({ ws }: { ws: Workspace }) {
  const { buffer } = ws
  const message = buffer.error ? buffer.error : buffer.pending ? "Cargando…" : buffer.atEnd ? "La tabla está vacía" : ""
  return (
    <div style={{ display: "flex", paddingLeft: 16, paddingTop: 14 }}>
      <T size={13} color={buffer.error ? C.danger : C.faint} style={{ whiteSpace: "normal" }}>
        {message}
      </T>
    </div>
  )
}

interface RowProps {
  readonly table: Table
  readonly cells: ReadonlyArray<string | null | undefined>
  readonly pending: ChangeSet.Pending | null
  readonly cols: ReadonlyArray<number>
  readonly widths: ReadonlyArray<number>
  readonly cursorCol: number
  /** Inside a V selection. */
  readonly selected: boolean
}

/** Left edge of a row with a pending change: new, deleted, changed, or changed on the server too. */
function markOf(pending: ChangeSet.Pending | null): string {
  if (!pending) return "#00000000"
  if (pending.refused || pending.invalid.size) return C.danger
  if (pending.change._tag === "Insert") return C.accent
  if (pending.change._tag === "Delete") return C.danger
  return C.warn
}

const GridRow = memo(
  function GridRow({ table, cells, pending, cols, widths, cursorCol, selected }: RowProps) {
    const isCursorRow = cursorCol >= 0
    const deleted = pending?.change._tag === "Delete"
    const background = selected ? C.accentSoft : pending?.conflict ? C.warnSoft : isCursorRow ? C.accentRow : undefined
    return (
      <div style={{ display: "flex", height: ROW_H, flexShrink: 0, backgroundColor: background, borderBottomWidth: 1, borderColor: C.lineSoft }}>
        <div style={{ width: 3, flexShrink: 0, backgroundColor: markOf(pending) }} />
        {cols.map((ci) => {
          const value = cells[ci]
          const cursor = ci === cursorCol
          const column = table.columns[ci]
          const numeric = column ? kindOf(column.type) === "number" : false
          const changed = pending ? ChangeSet.cellOf(pending.change, ci) !== undefined : false
          const invalid = pending?.invalid.has(ci) ?? false
          const color = cursor ? "#FFFFFF" : deleted ? C.danger : value === undefined ? C.faint : changed ? C.warn : valueColor(table, ci, value)
          // One <text> per cell: the cell box and its text are the same element.
          return (
            <text
              key={ci}
              style={{
                width: ci === 0 ? (widths[ci] ?? 0) - 3 : widths[ci],
                flexShrink: 0,
                height: ROW_H - 1,
                lineHeight: ROW_H - 1,
                paddingLeft: 8,
                paddingRight: 8,
                borderRightWidth: 1,
                borderColor: ci === 0 ? C.line : C.lineSoft,
                backgroundColor: cursor ? C.accentSoft : changed ? C.warnSoft : undefined,
                outlineWidth: cursor || invalid ? 1 : 0,
                outlineColor: invalid ? C.danger : C.accent,
                color,
                fontFamily: MONO,
                fontSize: 12.5,
                textDecoration: deleted ? "line-through" : "none",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                overflow: "hidden",
                textAlign: numeric && value !== null && value !== undefined ? "right" : "left",
              }}
            >
              {display(value)}
            </text>
          )
        })}
      </div>
    )
  },
  (a, b) =>
    a.cells === b.cells && a.pending === b.pending && a.table === b.table && a.cursorCol === b.cursorCol && a.selected === b.selected && a.cols.length === b.cols.length && a.cols[1] === b.cols[1],
)
