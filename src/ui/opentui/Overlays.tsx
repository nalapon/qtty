/** @jsxImportSource @opentui/react */
// Pop-ups over the workspace, in text, built like the GPUIX ones (../gpuix/Overlays.tsx
// and RowSheet.tsx): the same cards with a header and a footer, the same backdrop, a
// line wherever GPUIX draws a 1px border. Which-key, help, the bottom lines (`:`, `/`,
// `:unlock`), the table finder (␣␣), the gr picker, the cell editor, the review before
// saving (:w) and the row sheet (K).

import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useRef, type ReactNode } from "react"
import type * as ChangeSet from "../../domain/ChangeSet.ts"
import type { Catalog, Incoming, Table } from "../../db/Catalog.ts"
import type { Row } from "../../db/Rows.ts"
import { findTables } from "../../state/TableFinder.ts"
import { position, tableOf, type EditMode, type Workspace } from "../../state/Workspace.ts"
import { C, changesText, compact, display, HELP, lockLabel, NUM, reviewLines, sheetEntries, titleOf, valueColor, WHICH_KEY } from "../present.ts"
import { cellRect } from "./layout.ts"
import { fit, solid, width as cells } from "./text.ts"
import { Hints } from "./Workspace.tsx"

const BOLD = TextAttributes.BOLD

/** The workspace dimmed behind a modal; OpenTUI blends the translucent colour over what is below. */
function Backdrop({ width, height }: { width: number; height: number }) {
  return <box position="absolute" zIndex={15} left={0} top={0} width={width} height={height} backgroundColor={C.backdrop} />
}

/** A modal card: rounded border, an optional header and footer split off by lines, and a body
 *  that clips. Centred unless `top` is given; `padded={false}` leaves the body's sides to the caller. */
function Card({ width, height, w, h, top, bg = C.panel, padded = true, header, footer, children }: {
  width: number
  height: number
  w: number
  h: number
  top?: number
  bg?: string
  padded?: boolean
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const boxH = Math.min(h, height)
  return (
    <box
      position="absolute"
      zIndex={20}
      left={Math.max(0, Math.floor((width - w) / 2))}
      top={top ?? Math.max(0, Math.floor((height - boxH) / 2))}
      width={w}
      height={boxH}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.line}
      backgroundColor={bg}
    >
      {header && <Band side="bottom">{header}</Band>}
      <box flexGrow={1} flexDirection="column" paddingX={padded ? 1 : 0} overflow="hidden">
        {children}
      </box>
      {footer && <Band side="top">{footer}</Band>}
    </box>
  )
}

/** A card's header or footer: one row on the panel colour and the line between it and the body. */
function Band({ side, children }: { side: "top" | "bottom"; children: ReactNode }) {
  return (
    <box height={2} flexShrink={0} flexDirection="row" paddingX={1} border={[side]} borderColor={C.line} backgroundColor={C.panel}>
      {children}
    </box>
  )
}

const Spacer = () => <box flexGrow={1} />

export function WhichKey({ prefix, height }: { prefix: "g" | "space" | "d"; height: number }) {
  const items = WHICH_KEY[prefix]
  const w = Math.max(30, ...items.map(([k, description]) => cells(k) + cells(description) + 7))
  const h = items.length + 3
  return (
    <box position="absolute" zIndex={20} left={2} top={Math.max(0, height - 2 - h)} width={w} height={h} flexDirection="column" border borderStyle="rounded" borderColor={C.line} backgroundColor={C.raised} paddingX={1}>
      <text fg={C.accent} attributes={BOLD}>
        {`${prefix === "space" ? "␣" : prefix} …`}
      </text>
      {items.map(([k, description]) => (
        <text key={k}>
          <span fg={C.text} bg={C.bg}>{` ${k} `}</span>
          <span fg={C.text}>{` ${description}`}</span>
        </text>
      ))}
    </box>
  )
}

const HELP_KEY_W = 12
const HELP_COL_W = 52

/** ?: every key, by group; j k scroll a group at a time when they do not fit. */
export function Help({ scroll, width, height }: { scroll: number; width: number; height: number }) {
  // Two columns when they fit, as GPUIX; groups fill them row by row.
  const columns = width >= 2 * HELP_COL_W + 6 ? 2 : 1
  const groups = HELP.slice(Math.min(scroll, HELP.length - 1))
  const groupH = groups.map(([, items]) => items.length + 2)
  let lines = 0
  for (let i = 0; i < groupH.length; i += columns) lines += Math.max(...groupH.slice(i, i + columns))
  const colW = Math.min(HELP_COL_W, width - 4)
  return (
    <>
      <Backdrop width={width} height={height} />
      <Card width={width} height={height - 2} w={columns * colW + (columns - 1) * 2 + 4} h={lines + 3} footer={<Hints items={[["j k", "desplazar"], ["esc", "cerrar"]]} />}>
        <box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {groups.map(([group, items]) => (
            <box key={group} width={colW} flexDirection="column" marginBottom={1}>
              <text fg={C.accent} attributes={BOLD}>
                {group.toUpperCase()}
              </text>
              {items.map(([k, description]) => (
                <text key={k}>
                  <span fg={C.text} bg={C.raised}>{` ${k} `}</span>
                  <span>{" ".repeat(Math.max(1, HELP_KEY_W - cells(k) - 2))}</span>
                  <span fg={C.text}>{fit(description, colW - HELP_KEY_W)}</span>
                </text>
              ))}
            </box>
          ))}
        </box>
      </Card>
    </>
  )
}

/** A line at the bottom: `:`, `/` or the `:unlock` prompt. Enter hands the text over. */
export function CommandLine({ prompt, width, height, onSubmit }: { prompt: string; width: number; height: number; onSubmit: (text: string) => void }) {
  return (
    <box position="absolute" zIndex={20} left={0} top={height - 1} width={width} height={1} flexDirection="row" backgroundColor={C.panel}>
      <text fg={C.accent} attributes={BOLD}>
        {prompt}
      </text>
      <input focused flexGrow={1} onSubmit={(value) => typeof value === "string" && onSubmit(value)} textColor={C.text} focusedTextColor={C.text} backgroundColor={C.panel} focusedBackgroundColor={C.panel} />
    </box>
  )
}

const FINDER_ROWS = 12
const field = { textColor: C.text, focusedTextColor: C.text, backgroundColor: C.panel, focusedBackgroundColor: C.panel }

/** ␣␣: the matches for what is typed, best first; arrows (or ^n ^p) choose, Enter opens. */
export function TableFinder({ catalog, query, selected, current, width, height, onInput, onSubmit }: {
  catalog: Catalog
  query: string
  selected: number
  current: number | null
  width: number
  height: number
  onInput: (text: string) => void
  onSubmit: (text: string) => void
}) {
  const found = findTables(catalog, query)
  const start = Math.max(0, Math.min(found.length - FINDER_ROWS, selected - Math.floor(FINDER_ROWS / 2)))
  const shown = found.slice(start, start + FINDER_ROWS)
  const w = Math.min(80, width - 4)
  const inner = w - 4
  return (
    <>
      <Backdrop width={width} height={height} />
      <Card
        width={width}
        height={height}
        w={w}
        h={Math.max(1, shown.length) + 6}
        top={Math.min(4, Math.floor(height / 6))}
        header={
          <>
            <text fg={C.accent} attributes={BOLD}>
              {"TABLA "}
            </text>
            <input focused flexGrow={1} onInput={onInput} onSubmit={(value) => typeof value === "string" && onSubmit(value)} {...field} />
            <text fg={C.faint}>{found.length === 50 ? " 50+" : ` ${found.length}`}</text>
          </>
        }
        footer={<Hints items={[["↑ ↓", "elegir"], ["⏎", "abrir"], ["esc", "cerrar"]]} />}
      >
        {shown.map((table, i) => {
          const active = start + i === selected
          const extra = [lockLabel(table), table.estimate !== null ? compact(table.estimate) : null].filter((x) => x !== null).join(" · ")
          const extraW = extra ? cells(extra) + 1 : 0
          const nameW = Math.min(cells(table.name), inner - extraW)
          return (
            <text key={table.oid} bg={active ? solid.cursor : undefined}>
              <span fg={active ? "#FFFFFF" : C.text}>{fit(table.name, nameW)}</span>
              <span fg={C.faint}>{fit(`  ${table.schema}${table.oid === current ? " · abierta" : ""}`, inner - extraW - nameW)}</span>
              <span fg={C.faint}>{fit(extra, extraW, "right")}</span>
            </text>
          )
        })}
        {found.length === 0 && <text fg={C.faint}>Ninguna tabla coincide</text>}
      </Card>
    </>
  )
}

/** gr with several foreign keys pointing at this table: which one to follow. */
export function ReferencesPicker({ catalog, incoming, selected, width, height }: { catalog: Catalog; incoming: ReadonlyArray<Incoming>; selected: number; width: number; height: number }) {
  const w = Math.min(72, width - 4)
  return (
    <>
      <Backdrop width={width} height={height} />
      <Card
        width={width}
        height={height}
        w={w}
        h={incoming.length + 6}
        header={
          <text fg={C.accent} attributes={BOLD}>
            FILAS QUE APUNTAN A ESTA
          </text>
        }
        footer={<Hints items={[["j k", "elegir"], ["⏎", "abrir"], ["esc", "cerrar"]]} />}
      >
        {incoming.map((ref, i) => {
          const source = catalog.byOid.get(ref.table)
          const columns = ref.foreignKey.columns.map((c) => source?.columns[c]?.name ?? "?").join(", ")
          const name = source ? `${source.schema}.${source.name}` : "?"
          const nameW = Math.min(cells(name), w - 4)
          return (
            <text key={`${ref.table}:${columns}`} bg={i === selected ? solid.cursor : undefined}>
              <span fg={i === selected ? "#FFFFFF" : C.text}>{fit(name, nameW)}</span>
              <span fg={C.fk}>{fit(`  ${columns}`, w - 4 - nameW)}</span>
            </text>
          )
        })}
      </Card>
    </>
  )
}

/** Under the cursor cell (above it near the bottom): the column, its type and the value being typed. */
export function CellEditor({ catalog, table, ws, mode, width, height, onInput, onSubmit }: {
  catalog: Catalog
  table: Table
  ws: Workspace
  mode: EditMode
  width: number
  height: number
  onInput: (text: string) => void
  onSubmit: (text: string) => void
}) {
  // The field starts from this and then owns its text; `mode.text` follows it for esc.
  const start = useRef(mode.text).current
  const area = useRef<TextareaRenderable>(null)
  const rect = cellRect(catalog, ws, width, height)
  const column = table.columns[mode.col]
  const w = Math.min(width - 2, Math.max(48, rect.w + 6))
  const h = mode.multiline ? 12 : 5
  const below = rect.y + 1
  const top = below + h < height - 2 ? below : Math.max(0, rect.y - h)
  const left = Math.max(0, Math.min(rect.x - 1, width - w))
  const name = column?.name ?? ""
  const about = [column?.type, column && !column.nullable ? "not null" : null, column?.defaultExpr ? `default ${column.defaultExpr}` : null].filter((x) => x).join(" · ")
  // The field on the darker background, as GPUIX's framed input.
  const colors = { textColor: C.text, focusedTextColor: C.text, backgroundColor: C.bg, focusedBackgroundColor: C.bg, placeholderColor: C.faint }
  return (
    <box position="absolute" zIndex={30} left={left} top={top} width={w} height={h} flexDirection="column" border borderStyle="rounded" borderColor={C.accent} backgroundColor={C.raised} paddingX={1}>
      <text>
        <span fg={C.accent} attributes={BOLD}>{name}</span>
        <span fg={C.faint}>{fit(`  ${about}`, Math.max(0, w - 4 - cells(name)))}</span>
      </text>
      {mode.multiline ? (
        <textarea ref={area} focused flexGrow={1} initialValue={start} onContentChange={() => onInput(area.current?.plainText ?? "")} {...colors} />
      ) : (
        <input focused value={start} placeholder={mode.initial === null ? "vacío: se queda como está" : "vacío: cadena vacía"} onInput={onInput} onSubmit={(value) => typeof value === "string" && onSubmit(value)} {...colors} />
      )}
      <Hints items={[[mode.multiline ? "esc" : "⏎ esc", "listo"], ["u", "después, lo deshace"]]} chip={C.bg} />
    </box>
  )
}

/** :w — every change, grouped by table, then the SQL the save runs in one transaction. */
export function Review({ catalog, changes, scroll, saving, toast, width, height }: {
  catalog: Catalog
  changes: ChangeSet.ChangeSet
  scroll: number
  saving: boolean
  toast: string
  width: number
  height: number
}) {
  const lines = reviewLines(catalog, changes)
  const w = Math.min(130, width - 6)
  const h = height - 4
  const inner = w - 4
  const count = Math.max(1, h - 6)
  const start = Math.min(scroll, Math.max(0, lines.length - count))
  return (
    <>
      <Backdrop width={width} height={height} />
      <Card
        width={width}
        height={height}
        w={w}
        h={h}
        bg={C.bg}
        header={
          <>
            <text fg={C.text} attributes={BOLD}>
              Revisar cambios
            </text>
            <text fg={C.faint}>{`  ${changesText(changes.size)}`}</text>
          </>
        }
        footer={
          <>
            <Hints items={[["⏎", "guardar"], ["j k", "desplazar"], ["esc", "volver"]]} />
            <Spacer />
            <text fg={saving ? C.faint : C.danger}>{saving ? "Guardando…" : toast}</text>
          </>
        }
      >
        {lines.slice(start, start + count).map((line) => {
          switch (line.kind) {
            case "table":
              return (
                <text key={line.key} fg={C.muted} attributes={BOLD}>
                  {fit(line.text, inner)}
                </text>
              )
            case "change":
              return (
                <text key={line.key}>
                  <span fg={line.color} attributes={BOLD}>{`${line.mark} `}</span>
                  <span fg={C.text}>{`${line.label}  `}</span>
                  <span fg={C.muted}>{fit(line.detail, Math.max(1, inner - 4 - cells(line.label)))}</span>
                </text>
              )
            case "note":
              return (
                <text key={line.key} fg={line.color}>
                  {fit(`    ${line.text}`, inner)}
                </text>
              )
            case "sql":
              return (
                <text key={line.key} fg={line.title ? C.accent : C.faint} attributes={line.title ? BOLD : 0}>
                  {fit(line.text, inner)}
                </text>
              )
          }
        })}
      </Card>
    </>
  )
}

/** K: the current row as a grouped list of attributes, and (when there is room) the tables
 *  it points to and that point to it. j k walk the attributes, h l the rows. */
export function RowSheet({ catalog, ws, width, height }: { catalog: Catalog; ws: Workspace; width: number; height: number }) {
  const table = tableOf(catalog, ws)
  const row = ws.buffer.rows[ws.row]
  if (!table || !row) return null
  const w = Math.min(150, width - 6)
  const h = height - 4
  const bodyH = h - 6
  const relW = w < 110 ? 0 : 36
  const lock = lockLabel(table)
  return (
    <>
      <Backdrop width={width} height={height} />
      <Card
        width={width}
        height={height}
        w={w}
        h={h}
        bg={C.bg}
        padded={false}
        header={
          <>
            <text fg={C.muted}>{`${table.schema}.${table.name}`}</text>
            {table.estimate !== null && (
              <text>
                <span>{"  "}</span>
                <span fg={C.muted} bg={C.raised}>{` ≈${compact(table.estimate)} filas `}</span>
              </text>
            )}
            {lock && (
              <text>
                <span>{"  "}</span>
                <span fg={C.warn} bg={solid.warn}>{` ${lock} `}</span>
              </text>
            )}
            <Spacer />
            <text fg={C.text} bg={C.raised}>
              {" esc "}
            </text>
          </>
        }
        footer={
          <>
            <Hints items={[["j k", "atributo"], ["h l", "fila anterior / siguiente"], ["gd", "seguir la clave"], ["y", "copiar"], ["esc", "cerrar"]]} />
            <Spacer />
            <text fg={C.warn}>{ws.toast}</text>
          </>
        }
      >
        <box flexDirection="row" height={bodyH}>
          <Sheet catalog={catalog} ws={ws} table={table} row={row} width={w - 2 - relW} height={bodyH} />
          {relW > 0 && <Related catalog={catalog} table={table} row={row} col={ws.col} width={relW} height={bodyH} />}
        </box>
      </Card>
    </>
  )
}

function Sheet({ catalog, ws, table, row, width, height }: { catalog: Catalog; ws: Workspace; table: Table; row: Row; width: number; height: number }) {
  const entries = sheetEntries(table)
  const count = Math.max(1, height - 3)
  const cursor = entries.findIndex((e) => e.kind === "attr" && e.col === ws.col)
  const start = Math.max(0, Math.min(entries.length - count, cursor - Math.floor(count / 2)))
  const at = position(ws)
  const title = titleOf(table, row)
  const inner = width - 4
  // Each column keeps two cells of gap after it, as GPUIX's 14px.
  const nameW = 24
  const typeW = 28
  return (
    <box width={width} height={height} flexDirection="column" paddingX={2} overflow="hidden">
      <box height={3} flexShrink={0} flexDirection="column" border={["bottom"]} borderColor={C.lineSoft}>
        <text>
          <span fg={C.text} attributes={BOLD}>{fit(title, Math.min(cells(title), inner - 12))}</span>
          <span fg={C.faint}>{at !== null ? `  #${NUM.format(at)}` : ""}</span>
        </text>
        <text fg={C.faint}>{`${table.columns.length} atributos`}</text>
      </box>
      {entries.slice(start, start + count).map((entry) => {
        if (entry.kind === "section")
          return (
            <text key={`s:${entry.label}`} fg={C.faint} attributes={BOLD}>
              {entry.label.toUpperCase()}
            </text>
          )
        const column = table.columns[entry.col]
        if (!column) return null
        const value = row.cells[entry.col] ?? null
        const current = entry.col === ws.col
        const target = column.references ? catalog.byOid.get(column.references.table) : undefined
        const link = target && value !== null ? ` → ${target.schema}.${target.name}` : ""
        const valueW = Math.max(1, inner - 2 - nameW - typeW - cells(link))
        return (
          <text key={entry.col} bg={current ? solid.row : undefined}>
            <span fg={C.accent}>{current ? "▌ " : "  "}</span>
            <span fg={current ? C.accent : C.muted}>{`${fit(column.name, nameW - 2)}  `}</span>
            <span fg={C.ghost}>{`${fit(`${column.type}${column.nullable ? "" : " !"}`, typeW - 2)}  `}</span>
            <span fg={current ? "#FFFFFF" : valueColor(table, entry.col, value)}>{fit(value === null ? "∅ null" : display(value), valueW)}</span>
            <span fg={C.fk}>{link}</span>
          </text>
        )
      })}
    </box>
  )
}

function Related({ catalog, table, row, col, width, height }: { catalog: Catalog; table: Table; row: Row; col: number; width: number; height: number }) {
  const incoming = catalog.incoming.get(table.oid) ?? []
  const inner = width - 3
  // Rows left for the incoming list after the outgoing one and both titles.
  const maxIn = Math.max(0, height - 5 - Math.max(1, table.foreignKeys.length * 2))
  const shown = incoming.length > maxIn ? Math.max(0, maxIn - 1) : maxIn
  return (
    <box width={width} height={height} flexShrink={0} flexDirection="column" paddingX={1} paddingTop={1} border={["left"]} borderColor={C.line} backgroundColor={C.panel} overflow="hidden">
      <text fg={C.faint} attributes={BOLD}>
        APUNTA A
      </text>
      {table.foreignKeys.length === 0 && <text fg={C.ghost}>ninguna tabla</text>}
      {table.foreignKeys.map((fk, i) => {
        const target = catalog.byOid.get(fk.table)
        const names = fk.columns.map((c) => `${table.columns[c]?.name} = ${row.cells[c] ?? "null"}`).join(", ")
        const current = fk.columns.includes(col)
        return (
          <box key={i} flexDirection="column" flexShrink={0} backgroundColor={current ? solid.row : undefined}>
            <text fg={C.fk}>{fit(target ? `${target.schema}.${target.name}` : "?", inner)}</text>
            <text fg={C.faint}>{fit(names, inner)}</text>
          </box>
        )
      })}
      <text> </text>
      <text fg={C.faint} attributes={BOLD}>
        {`LA REFERENCIAN · ${incoming.length}`}
      </text>
      {incoming.slice(0, shown).map(({ table: from, foreignKey }, i) => {
        const source = catalog.byOid.get(from)
        const name = source?.name ?? "?"
        return (
          <text key={`${from}:${i}`}>
            <span fg={C.text}>{fit(name, Math.min(cells(name), inner))}</span>
            <span fg={C.faint}>{fit(`.${foreignKey.columns.map((c) => source?.columns[c]?.name).join(", ")}`, Math.max(0, inner - cells(name)))}</span>
          </text>
        )
      })}
      {incoming.length > shown && <text fg={C.faint}>{`y ${incoming.length - shown} más`}</text>}
    </box>
  )
}
