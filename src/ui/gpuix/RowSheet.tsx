// Row sheet (K): the current row as a grouped list of attributes (key, relations,
// attributes, timestamps) with the tables it points to and that point to it.

import type { Catalog, Table } from "../../db/Catalog.ts"
import type { Row } from "../../db/Rows.ts"
import { position, tableOf, type Workspace } from "../../state/Workspace.ts"
import { C, compact, display, lockLabel, NUM, sheetEntries, titleOf, valueColor } from "../present.ts"
import { Backdrop, Chip, Hints, Kbd, SHADOW, T } from "./theme.tsx"

export function RowSheet({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const table = tableOf(catalog, ws)
  const row = ws.buffer.rows[ws.row]
  if (!table || !row) return null
  const w = Math.min(1180, width - 60)
  const h = height - 60
  const barH = 40
  const hintsH = 34
  const relW = w < 900 ? 0 : 300
  const bodyH = h - barH - hintsH
  const lock = lockLabel(table)
  return (
    <Backdrop width={width} height={height}>
      <div style={{ display: "flex", flexDirection: "column", width: w, height: h, backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.line, boxShadow: SHADOW, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: barH, flexShrink: 0, paddingLeft: 18, paddingRight: 14, backgroundColor: C.panel, borderBottomWidth: 1, borderColor: C.line }}>
          <T mono size={12.5} color={C.muted}>
            {table.schema}.{table.name}
          </T>
          {table.estimate !== null && <Chip text={`≈${compact(table.estimate)} filas`} />}
          {lock && <Chip text={lock} tone="warn" />}
          <div style={{ flexGrow: 1 }} />
          <Kbd k="esc" />
        </div>
        <div style={{ display: "flex", height: bodyH }}>
          <Sheet catalog={catalog} ws={ws} table={table} row={row} width={w - relW} height={bodyH} />
          {relW > 0 && <Related catalog={catalog} table={table} row={row} col={ws.col} width={relW} height={bodyH} />}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, height: hintsH, flexShrink: 0, paddingLeft: 14, paddingRight: 14, backgroundColor: C.panel, borderTopWidth: 1, borderColor: C.line }}>
          <Hints items={[["j k", "atributo"], ["h l", "fila anterior / siguiente"], ["gd", "seguir la clave"], ["y", "copiar"], ["esc", "cerrar"]]} />
          <div style={{ flexGrow: 1 }} />
          {ws.toast && (
            <T size={12} color={C.warn}>
              {ws.toast}
            </T>
          )}
        </div>
      </div>
    </Backdrop>
  )
}

function Sheet({ catalog, ws, table, row, width, height }: { catalog: Catalog; ws: Workspace; table: Table; row: Row; width: number; height: number }) {
  const rowH = 32
  const headH = 76
  const entries = sheetEntries(table)
  const count = Math.max(1, Math.floor((height - headH) / rowH))
  const cursor = entries.findIndex((e) => e.kind === "attr" && e.col === ws.col)
  const start = Math.max(0, Math.min(entries.length - count, cursor - Math.floor(count / 2)))
  const at = position(ws)
  return (
    <div style={{ display: "flex", flexDirection: "column", width, height, overflow: "hidden", backgroundColor: C.bg }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, height: headH, flexShrink: 0, paddingLeft: 28, paddingRight: 20, borderBottomWidth: 1, borderColor: C.lineSoft }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <T size={24} weight={750} style={{ flexShrink: 1, minWidth: 0 }}>
            {titleOf(table, row)}
          </T>
          {at !== null && (
            <T mono size={13} color={C.faint}>
              #{NUM.format(at)}
            </T>
          )}
        </div>
        <T size={12} color={C.faint}>
          {table.columns.length} atributos
        </T>
      </div>
      {entries.slice(start, start + count).map((entry) => {
        if (entry.kind === "section")
          return (
            <div key={`s:${entry.label}`} style={{ display: "flex", alignItems: "flex-end", height: rowH, flexShrink: 0, paddingLeft: 28, paddingBottom: 6 }}>
              <T size={10.5} weight={700} color={C.faint}>
                {entry.label.toUpperCase()}
              </T>
            </div>
          )
        const column = table.columns[entry.col]
        if (!column) return null
        const value = row.cells[entry.col] ?? null
        const current = entry.col === ws.col
        const target = column.references ? catalog.byOid.get(column.references.table) : undefined
        return (
          <div
            key={entry.col}
            style={{ display: "flex", alignItems: "center", gap: 14, height: rowH, flexShrink: 0, paddingLeft: 26, paddingRight: 20, backgroundColor: current ? C.accentRow : undefined, borderLeftWidth: 2, borderColor: current ? C.accent : "#00000000" }}
          >
            <T mono size={12.5} color={current ? C.accent : C.muted} style={{ width: width < 700 ? 140 : 190, flexShrink: 0 }}>
              {column.name}
            </T>
            <T mono size={10.5} color={C.ghost} style={{ width: 170, flexShrink: 0 }}>
              {column.type}
              {column.nullable ? "" : " !"}
            </T>
            <T mono size={13} color={current ? "#FFFFFF" : valueColor(table, entry.col, value)} style={{ flexShrink: 1, minWidth: 0 }}>
              {value === null ? "∅ null" : display(value)}
            </T>
            {target && value !== null && (
              <T size={11.5} color={C.fk} style={{ flexShrink: 0 }}>
                → {target.schema}.{target.name}
              </T>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Related({ catalog, table, row, col, width, height }: { catalog: Catalog; table: Table; row: Row; col: number; width: number; height: number }) {
  const incoming = catalog.incoming.get(table.oid) ?? []
  const maxIn = Math.max(0, Math.floor((height - 120 - table.foreignKeys.length * 46) / 26))
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, width, height, flexShrink: 0, paddingTop: 14, backgroundColor: C.panel, borderLeftWidth: 1, borderColor: C.line, overflow: "hidden" }}>
      <T size={10.5} weight={700} color={C.faint} style={{ paddingLeft: 16, marginBottom: 4 }}>
        APUNTA A
      </T>
      {table.foreignKeys.length === 0 && (
        <T size={11.5} color={C.ghost} style={{ paddingLeft: 16 }}>
          ninguna tabla
        </T>
      )}
      {table.foreignKeys.map((fk, i) => {
        const target = catalog.byOid.get(fk.table)
        const names = fk.columns.map((c) => `${table.columns[c]?.name} = ${row.cells[c] ?? "null"}`).join(", ")
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 1, paddingLeft: 16, paddingRight: 12, paddingTop: 4, paddingBottom: 4, backgroundColor: fk.columns.includes(col) ? C.accentRow : undefined }}>
            <T mono size={12} color={C.fk}>
              {target ? `${target.schema}.${target.name}` : "?"}
            </T>
            <T mono size={11} color={C.faint}>
              {names}
            </T>
          </div>
        )
      })}
      <T size={10.5} weight={700} color={C.faint} style={{ paddingLeft: 16, marginTop: 14, marginBottom: 4 }}>
        LA REFERENCIAN · {incoming.length}
      </T>
      {incoming.slice(0, maxIn).map(({ table: from, foreignKey }, i) => {
        const source = catalog.byOid.get(from)
        return (
          <div key={`${from}:${i}`} style={{ display: "flex", alignItems: "center", gap: 6, height: 26, flexShrink: 0, paddingLeft: 16, paddingRight: 12 }}>
            <T mono size={12} style={{ flexShrink: 1, minWidth: 0 }}>
              {source?.name ?? "?"}
            </T>
            <T mono size={11} color={C.faint}>
              .{foreignKey.columns.map((c) => source?.columns[c]?.name).join(", ")}
            </T>
          </div>
        )
      })}
      {incoming.length > maxIn && (
        <T size={11} color={C.faint} style={{ paddingLeft: 16 }}>
          y {incoming.length - maxIn} más
        </T>
      )}
    </div>
  )
}
