// Pixel layout of the workspace. The views draw with it and the key handler gets
// the same numbers (how many rows and columns fit) through `viewportFor`.

import type { Catalog, Column, Table } from "../../db/Catalog.ts"
import { kindOf, type ValueKind } from "../present.ts"
import { newRows, tableOf, type Viewport, type Workspace } from "../../state/Workspace.ts"

export const TOP_H = 38
export const STATUS_H = 26
export const HINTS_H = 30
export const ROW_H = 24
export const HEAD_H = 40

const BASE_WIDTH: Record<ValueKind, number> = { number: 100, bool: 76, time: 236, json: 260, uuid: 290, text: 200, other: 150 }

function columnWidth(column: Column): number {
  let width = BASE_WIDTH[kindOf(column.type)]
  if (column.type === "date") width = 110
  const sized = /^character(?: varying)?\((\d+)\)/.exec(column.type)
  if (sized) width = Math.min(260, Math.max(56, Number(sized[1]) * 8 + 24))
  // Room for the header: name, FK arrow, padding.
  const header = column.name.length * 7.6 + 40
  return Math.round(Math.min(320, Math.max(width, header)))
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
  const sideW = !ws.sidebar ? 0 : width < 1000 ? 220 : 270
  // The row inspector only appears when the grid keeps a useful width next to it.
  const inspW = width < 1150 ? 0 : Math.round(Math.min(340, Math.max(260, width * 0.22)))
  return { sideW, inspW, gridW: width - sideW - inspW, bodyH: height - TOP_H - STATUS_H - HINTS_H }
}

/** `pinned`: new rows shown above the grid, which take its height. */
export function gridViewport(table: Table | undefined, width: number, height: number, pinned = 0): Viewport {
  const widths = table ? columnWidths(table) : []
  const avail = width - (widths[0] ?? 0)
  return {
    rows: Math.max(1, Math.floor((height - HEAD_H - pinned * ROW_H) / ROW_H)),
    colsFrom(left) {
      let used = 0
      let n = 0
      for (let i = Math.max(1, left); i < widths.length; i++) {
        used += widths[i] ?? 0
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

/** Where the cursor cell is drawn, in window coordinates: the cell editor opens under it. */
export function cellRect(catalog: Catalog, ws: Workspace, width: number, height: number): { readonly x: number; readonly y: number; readonly w: number } {
  const table = tableOf(catalog, ws)
  const widths = table ? columnWidths(table) : []
  const { sideW } = workspaceLayout(ws, width, height)
  const left = Math.max(1, ws.left)
  let x = sideW
  if (ws.col >= 1) {
    x += widths[0] ?? 0
    for (let i = left; i < ws.col; i++) x += widths[i] ?? 0
  }
  const pinned = newRows(ws).length
  const line = ws.row < 0 ? pinned + ws.row : pinned + ws.row - ws.top
  return { x, y: TOP_H + HEAD_H + line * ROW_H, w: widths[ws.col] ?? 160 }
}
