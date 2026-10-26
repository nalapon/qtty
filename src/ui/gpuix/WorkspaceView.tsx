// Workspace, layout A: table list | grid | row inspector, with a status line and
// the keys for what is on screen. `␣ e` hides the list; `K` opens the row sheet;
// `␣␣`, `/`, `:` and `gr` open their pop-ups over it.

import type { Catalog, Table } from "../../db/Catalog.ts"
import type { Interface as Session } from "../../db/Session.ts"
import { position, tableOf, type Workspace } from "../../state/Workspace.ts"
import { C, changesText, compact, display, hints, lockLabel, modeLabel, NUM, positionText, valueColor, viewText } from "../present.ts"
import { Grid } from "./Grid.tsx"
import { cellRect, HINTS_H, STATUS_H, TOP_H, workspaceLayout } from "./layout.ts"
import { CellEditor, CommandLine, Help, ReferencesPicker, Review, TableFinder, WhichKey } from "./Overlays.tsx"
import { RowSheet } from "./RowSheet.tsx"
import { Chip, EnvBadge, Hints, Pill, T } from "./theme.tsx"

export function WorkspaceView({ session, ws, width, height, onSubmit, onInput }: { session: Session; ws: Workspace; width: number; height: number; onSubmit: (text: string) => void; onInput: (text: string) => void }) {
  const { catalog, target } = session
  const { profile } = target
  const layout = workspaceLayout(ws, width, height)
  const open = tableOf(catalog, ws)
  const editing = ws.mode._tag === "Edit" ? ws.mode : null
  return (
    <div style={{ display: "flex", flexDirection: "column", width, height }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, height: TOP_H, flexShrink: 0, paddingLeft: 14, paddingRight: 14, backgroundColor: C.panel, borderBottomWidth: 1, borderColor: C.line }}>
        <T size={13} weight={800}>
          qtty
        </T>
        <EnvBadge env={profile.env} />
        <T mono size={12} color={C.muted}>
          {profile.user}@{profile.host}:{profile.port}/{profile.database}
        </T>
        <T size={11.5} color={ws.locked ? C.warn : C.faint}>
          {ws.locked ? "solo lectura · :unlock para editar" : "editable"}
        </T>
        {ws.changes.size > 0 && <Chip text={`${changesText(ws.changes.size)} sin guardar · :w`} tone="warn" />}
        <div style={{ flexGrow: 1 }} />
        <T size={12} color={C.faint}>
          {NUM.format(catalog.tables.length)} tablas · {NUM.format(catalog.columnCount)} columnas
        </T>
      </div>
      <div style={{ display: "flex", height: layout.bodyH }}>
        {layout.sideW > 0 && <Sidebar catalog={catalog} ws={ws} width={layout.sideW} height={layout.bodyH} />}
        <Grid catalog={catalog} ws={ws} width={layout.gridW} height={layout.bodyH} />
        {layout.inspW > 0 && <Inspector catalog={catalog} ws={ws} width={layout.inspW} height={layout.bodyH} />}
      </div>
      <StatusBar catalog={catalog} ws={ws} />
      <div style={{ display: "flex", alignItems: "center", height: HINTS_H, flexShrink: 0, paddingLeft: 14, backgroundColor: C.bg }}>
        <Hints items={hints(catalog, ws)} />
      </div>
      {ws.sheet && <RowSheet catalog={catalog} ws={ws} width={width} height={height} />}
      {ws.prefix && <WhichKey prefix={ws.prefix} />}
      {ws.mode._tag === "Command" && <CommandLine prompt=":" testId="command" onSubmit={onSubmit} />}
      {ws.mode._tag === "Search" && <CommandLine prompt="/" testId="search" onSubmit={onSubmit} />}
      {ws.mode._tag === "Unlock" && <CommandLine prompt={`Escribe «${profile.database}» para editar en prod:`} testId="unlock" onSubmit={onSubmit} />}
      {editing && open && (
        <CellEditor
          key={`${editing.target.id}:${editing.col}`}
          table={open}
          mode={editing}
          rect={cellRect(catalog, ws, width, height)}
          width={width}
          height={height}
          onInput={onInput}
          onSubmit={onSubmit}
        />
      )}
      {ws.mode._tag === "Review" && <Review catalog={catalog} changes={ws.changes} scroll={ws.mode.scroll} saving={ws.saving} toast={ws.toast} width={width} height={height} />}
      {ws.mode._tag === "Help" && <Help scroll={ws.mode.scroll} width={width} height={height} />}
      {ws.mode._tag === "Finder" && (
        <TableFinder catalog={catalog} query={ws.mode.query} selected={ws.mode.selected} current={ws.table} width={width} height={height} onInput={onInput} onSubmit={onSubmit} />
      )}
      {ws.mode._tag === "References" && ws.table !== null && (
        <ReferencesPicker catalog={catalog} incoming={catalog.incoming.get(ws.table) ?? []} selected={ws.mode.selected} width={width} height={height} />
      )}
    </div>
  )
}

function StatusBar({ catalog, ws }: { catalog: Catalog; ws: Workspace }) {
  const table = tableOf(catalog, ws)
  const column = table?.columns[ws.col]
  const where = positionText(catalog, ws)
  const view = viewText(catalog, ws)
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, height: STATUS_H, flexShrink: 0, paddingLeft: 10, paddingRight: 14, backgroundColor: C.panel, borderTopWidth: 1, borderColor: C.line }}>
      <Pill label={modeLabel(ws)} />
      {table && (
        <T mono size={12}>
          {table.schema}.{table.name}
        </T>
      )}
      {view.where && (
        <T mono size={12} color={C.warn} style={{ maxWidth: 420 }}>
          {view.where}
        </T>
      )}
      {view.sort && (
        <T mono size={12} color={C.warn}>
          {view.sort}
        </T>
      )}
      {where && (
        <T mono size={12} color={C.muted}>
          {where}
        </T>
      )}
      {column && (
        <T mono size={12} color={C.muted}>
          {column.name}: {column.type}
        </T>
      )}
      {ws.buffer.pending && (
        <T size={12} color={C.faint}>
          cargando…
        </T>
      )}
      {ws.buffer.error && ws.buffer.rows.length > 0 && (
        <T size={12} color={C.danger}>
          {ws.buffer.error}
        </T>
      )}
      {ws.toast && (
        <T size={12} color={C.warn}>
          {ws.toast}
        </T>
      )}
      <div style={{ flexGrow: 1 }} />
      {table && lockLabel(table) && (
        <T size={11.5} color={C.faint}>
          {lockLabel(table)}
        </T>
      )}
    </div>
  )
}

function Sidebar({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const rowH = 24
  const headH = 34
  const count = Math.max(1, Math.floor((height - headH) / rowH))
  const tables = catalog.tables
  const at = Math.max(0, tables.findIndex((t) => t.oid === ws.table))
  // A window around the open table, with a schema heading wherever the schema changes.
  const start = Math.max(0, Math.min(tables.length - count, at - Math.floor(count / 2)))
  const items: Array<{ readonly kind: "schema"; readonly schema: string } | { readonly kind: "table"; readonly table: Table }> = []
  let lastSchema = start > 0 ? (tables[start - 1]?.schema ?? "") : ""
  for (let i = start; i < tables.length && items.length < count; i++) {
    const table = tables[i]
    if (!table) break
    if (table.schema !== lastSchema) {
      items.push({ kind: "schema", schema: table.schema })
      lastSchema = table.schema
      if (items.length >= count) break
    }
    items.push({ kind: "table", table })
  }
  const focused = ws.focus === "tables"
  return (
    <div style={{ display: "flex", flexDirection: "column", width, height, flexShrink: 0, backgroundColor: C.panel, borderRightWidth: 1, borderColor: C.line, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: headH, flexShrink: 0, paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: C.lineSoft }}>
        <T size={11} weight={700} color={focused ? C.accent : C.faint}>
          TABLAS
        </T>
        <div style={{ flexGrow: 1 }} />
        <T size={11} color={C.faint}>
          {NUM.format(at + 1)} / {NUM.format(tables.length)}
        </T>
      </div>
      {items.map((item) => {
        if (item.kind === "schema")
          return (
            <div key={`s:${item.schema}`} style={{ display: "flex", alignItems: "flex-end", height: rowH, flexShrink: 0, paddingLeft: 12, paddingBottom: 3 }}>
              <T size={10.5} weight={700} color={C.faint}>
                {item.schema.toUpperCase()}
              </T>
            </div>
          )
        const { table } = item
        const current = table.oid === ws.table
        const lock = lockLabel(table)
        return (
          <div
            key={table.oid}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: rowH,
              flexShrink: 0,
              paddingLeft: 18,
              paddingRight: 12,
              backgroundColor: current ? (focused ? C.accentSoft : "#FFFFFF0A") : undefined,
              borderLeftWidth: 2,
              borderColor: current ? C.accent : "#00000000",
            }}
          >
            <T mono size={12.5} color={current ? "#FFFFFF" : C.text} style={{ flexGrow: 1, minWidth: 0 }}>
              {table.name}
            </T>
            {lock && (
              <T size={10} color={C.faint}>
                {lock}
              </T>
            )}
            {table.estimate !== null && (
              <T mono size={11} color={C.faint}>
                {compact(table.estimate)}
              </T>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Inspector({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const table = tableOf(catalog, ws)
  const row = ws.buffer.rows[ws.row]
  const rowH = 26
  const headH = 58
  const frame = { display: "flex", flexDirection: "column", width, height, flexShrink: 0, backgroundColor: C.panel, borderLeftWidth: 1, borderColor: C.line, overflow: "hidden" } as const
  if (!table || !row) return <div style={frame} />
  const count = Math.max(1, Math.floor((height - headH) / rowH))
  const start = Math.max(0, Math.min(table.columns.length - count, ws.col - Math.floor(count / 2)))
  const keyText = table.key.map((i) => `${table.columns[i]?.name} = ${row.cells[i] ?? "∅"}`).join(", ")
  return (
    <div style={frame}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, height: headH, flexShrink: 0, paddingLeft: 14, paddingRight: 12, borderBottomWidth: 1, borderColor: C.lineSoft }}>
        <T size={15} weight={700}>
          {keyText || `Fila ${position(ws) ?? ""}`}
        </T>
        <T size={11.5} color={C.faint}>
          {table.columns.length} columnas · K abre la ficha
        </T>
      </div>
      {table.columns.slice(start, start + count).map((column, i) => {
        const ci = start + i
        const value = row.cells[ci] ?? null
        const current = ci === ws.col
        const target = column.references ? catalog.byOid.get(column.references.table) : undefined
        return (
          <div
            key={ci}
            style={{ display: "flex", alignItems: "center", gap: 10, height: rowH, flexShrink: 0, paddingLeft: 14, paddingRight: 12, backgroundColor: current ? C.accentRow : undefined, borderLeftWidth: 2, borderColor: current ? C.accent : "#00000000" }}
          >
            <T mono size={11.5} color={current ? C.accent : C.muted} style={{ width: 120, flexShrink: 0 }}>
              {column.name}
            </T>
            <T mono size={12} color={valueColor(table, ci, value)} style={{ flexGrow: 1, minWidth: 0 }}>
              {value !== null && target ? `${display(value)} → ${target.name}` : display(value)}
            </T>
          </div>
        )
      })}
    </div>
  )
}
