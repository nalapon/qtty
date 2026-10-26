// Cell layout of the OpenTUI workspace. The views draw with it and the key handler
// gets the same numbers (how many rows and columns fit) through `viewportFor`.
//
//   top bar      1 line
//   body         table list | grid (2 header lines, then rows) | inspector
//   status       1 line
//   hints        1 line

import type { Catalog, Column, Table } from "../../db/Catalog.ts"
import { newRows, tableOf, type Viewport, type Workspace } from "../../state/Workspace.ts"
import { kindOf, type ValueKind } from "../present.ts"

export const HEAD = 2
/** The strip on the left of each row that marks new, changed or deleted rows. */
export const MARK = 1

const BASE: Record<ValueKind, number> = { number: 10, bool: 5, time: 22, json: 24, uuid: 36, text: 18, other: 14 }

function columnWidth(column: Column): number {
  let cells = BASE[kindOf(column.type)]
  if (column.type === "date") cells = 10
  const sized = /^character(?: varying)?\((\d+)\)/.exec(column.type)
  if (sized) cells = Math.min(28, Math.max(6, Number(sized[1])))
  // Room for the name in the header.
  return Math.min(32, Math.max(4, cells, column.name.length + (column.references ? 2 : 0)))
}

const widthCache = new WeakMap<Table, ReadonlyArray<number>>()

export function columnWidths(table: Table): ReadonlyArray<number> {
  let widths = widthCache.get(table)
  if (!widths) {
    widths = table.columns.map(columnWidth)
    widthCache.set(table, widths)
  }
  return widths
}

export interface WorkspaceLayout {
  readonly sideW: number
  readonly inspW: number
  readonly gridW: number
  readonly bodyH: number
}

export function workspaceLayout(ws: Workspace, width: number, height: number): WorkspaceLayout {
  const sideW = !ws.sidebar ? 0 : width < 100 ? 22 : 28
  // The inspector only appears when the grid keeps a useful width next to it.
  const inspW = width < 150 ? 0 : 36
  return { sideW, inspW, gridW: Math.max(10, width - sideW - inspW), bodyH: Math.max(4, height - 3) }
}

/** Columns are separated by one cell; column 0 stays pinned. `pinned`: new rows above the grid. */
export function gridViewport(table: Table | undefined, width: number, height: number, pinned = 0): Viewport {
  const widths = table ? columnWidths(table) : []
  const avail = width - MARK - (widths[0] ?? 0) - 1
  return {
    rows: Math.max(1, height - HEAD - pinned),
    colsFrom(left) {
      let used = 0
      let n = 0
      for (let i = Math.max(1, left); i < widths.length; i++) {
        used += (widths[i] ?? 0) + 1
        if (used > avail && n > 0) break
        n++
      }
      return n
    },
  }
}

export function viewportFor(catalog: Catalog, ws: Workspace, width: number, height: number): Viewport {
  const { gridW, bodyH } = workspaceLayout(ws, width, height)
  return gridViewport(tableOf(catalog, ws), gridW, bodyH, newRows(ws).length)
}

/** Where the cursor cell is drawn, in screen cells: the cell editor opens under it. */
export function cellRect(catalog: Catalog, ws: Workspace, width: number, height: number): { readonly x: number; readonly y: number; readonly w: number } {
  const table = tableOf(catalog, ws)
  const widths = table ? columnWidths(table) : []
  const { sideW } = workspaceLayout(ws, width, height)
  let x = sideW + MARK
  if (ws.col >= 1) {
    x += (widths[0] ?? 0) + 1
    for (let i = Math.max(1, ws.left); i < ws.col; i++) x += (widths[i] ?? 0) + 1
  }
  const pinned = newRows(ws).length
  const line = ws.row < 0 ? pinned + ws.row : pinned + ws.row - ws.top
  return { x, y: 1 + HEAD + line, w: widths[ws.col] ?? 14 }
}
