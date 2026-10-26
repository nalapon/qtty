// Pop-ups over the workspace: the keys after a prefix (which-key), the full key
// list (?), the text lines (`:`, `/`, `:unlock`), the table finder (␣␣), the gr
// picker, the cell editor and the review of the changes before saving (:w).

import { useRef } from "react"
import type * as ChangeSet from "../../domain/ChangeSet.ts"
import type { Catalog, Incoming, Table } from "../../db/Catalog.ts"
import { findTables } from "../../state/TableFinder.ts"
import type { EditMode } from "../../state/Workspace.ts"
import { C, compact, HELP, lockLabel, reviewLines, WHICH_KEY, type ReviewLine } from "../present.ts"
import { ROW_H } from "./layout.ts"
import { Backdrop, Hints, Kbd, MONO, SHADOW, T } from "./theme.tsx"

export function WhichKey({ prefix }: { prefix: "g" | "space" | "d" }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 64,
        left: 20,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 12,
        minWidth: 260,
        backgroundColor: C.raised,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: C.line,
        boxShadow: { offsetX: 0, offsetY: 10, blurRadius: 30, spreadRadius: 0, color: "#00000099" },
      }}
    >
      <T size={11} weight={700} color={C.accent} style={{ marginBottom: 4 }}>
        {prefix === "space" ? "␣" : prefix} …
      </T>
      {WHICH_KEY[prefix].map(([k, description]) => (
        <div key={k} style={{ display: "flex", gap: 10, alignItems: "center", height: 20 }}>
          <Kbd k={k} />
          <T size={12.5}>{description}</T>
        </div>
      ))}
    </div>
  )
}

/** ?: every key, by group; j k scroll a group at a time when they do not fit. */
export function Help({ scroll, width, height }: { scroll: number; width: number; height: number }) {
  return (
    <Backdrop width={width} height={height}>
      <div style={{ display: "flex", flexDirection: "column", width: Math.min(900, width - 60), maxHeight: height - 60, backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.line, boxShadow: SHADOW, overflow: "hidden" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 28, padding: 28, flexShrink: 1, minHeight: 0, overflow: "hidden" }}>
          {HELP.slice(Math.min(scroll, HELP.length - 1)).map(([group, items]) => (
            <div key={group} style={{ display: "flex", flexDirection: "column", gap: 6, width: 380 }}>
              <T size={11} weight={700} color={C.accent}>
                {group.toUpperCase()}
              </T>
              {items.map(([k, description]) => (
                <div key={k} style={{ display: "flex", gap: 10, alignItems: "center", height: 20 }}>
                  <div style={{ display: "flex", width: 70 }}>
                    <Kbd k={k} />
                  </div>
                  <T size={12.5}>{description}</T>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", height: 32, flexShrink: 0, paddingLeft: 16, borderTopWidth: 1, borderColor: C.line }}>
          <Hints items={[["j k", "desplazar"], ["esc", "cerrar"]]} />
        </div>
      </div>
    </Backdrop>
  )
}

/** A line at the bottom: `:`, `/` or the `:unlock` prompt. Typing stays inside the input; Enter hands the text over. */
export function CommandLine({ prompt, testId, onSubmit }: { prompt: string; testId: string; onSubmit: (text: string) => void }) {
  const text = useRef("")
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", gap: 4, height: 30, paddingLeft: 10, backgroundColor: C.panel, borderTopWidth: 1, borderColor: C.line }}>
      <T mono size={14} weight={700} color={C.accent} style={{ flexShrink: 0 }}>
        {prompt}
      </T>
      <input
        autoFocus
        testId={testId}
        value=""
        onChange={(e) => {
          text.current = e.value ?? ""
        }}
        onSubmit={() => onSubmit(text.current)}
        style={{ flexGrow: 1, color: C.text, fontFamily: MONO, fontSize: 13 }}
        theme={{ caret: C.accent }}
      />
    </div>
  )
}

const FINDER_ROWS = 12
const PICK_H = 30

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
  const text = useRef(query)
  const found = findTables(catalog, query)
  const start = Math.max(0, Math.min(found.length - FINDER_ROWS, selected - Math.floor(FINDER_ROWS / 2)))
  return (
    <Backdrop width={width} height={height} align="flex-start">
      <div style={{ display: "flex", flexDirection: "column", marginTop: Math.min(120, height / 6), width: Math.min(620, width - 60), backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.line, boxShadow: SHADOW, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 46, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 1, borderColor: C.line }}>
          <T size={11} weight={700} color={C.accent} style={{ flexShrink: 0 }}>
            TABLA
          </T>
          <input
            autoFocus
            testId="finder"
            value=""
            onChange={(e) => {
              text.current = e.value ?? ""
              onInput(text.current)
            }}
            onSubmit={() => onSubmit(text.current)}
            style={{ flexGrow: 1, color: C.text, fontFamily: MONO, fontSize: 14 }}
            theme={{ caret: C.accent }}
          />
          <T size={11.5} color={C.faint}>
            {found.length === 50 ? "50+" : String(found.length)}
          </T>
        </div>
        <div style={{ display: "flex", flexDirection: "column", paddingTop: 6, paddingBottom: 6 }}>
          {found.slice(start, start + FINDER_ROWS).map((table, i) => {
            const active = start + i === selected
            const lock = lockLabel(table)
            return (
              <div key={table.oid} style={{ display: "flex", alignItems: "center", gap: 10, height: PICK_H, paddingLeft: 16, paddingRight: 16, backgroundColor: active ? C.accentSoft : undefined }}>
                <T mono size={13} color={active ? "#FFFFFF" : C.text}>
                  {table.name}
                </T>
                <T mono size={11.5} color={C.faint} style={{ flexGrow: 1, minWidth: 0 }}>
                  {table.schema}
                  {table.oid === current ? " · abierta" : ""}
                </T>
                {lock && (
                  <T size={10.5} color={C.faint}>
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
          {found.length === 0 && (
            <div style={{ display: "flex", height: PICK_H, paddingLeft: 16, alignItems: "center" }}>
              <T size={12.5} color={C.faint}>
                Ninguna tabla coincide
              </T>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", height: 32, paddingLeft: 16, borderTopWidth: 1, borderColor: C.line }}>
          <Hints items={[["↑ ↓", "elegir"], ["⏎", "abrir"], ["esc", "cerrar"]]} />
        </div>
      </div>
    </Backdrop>
  )
}

/** gr with several foreign keys pointing at this table: which one to follow. */
export function ReferencesPicker({ catalog, incoming, selected, width, height }: { catalog: Catalog; incoming: ReadonlyArray<Incoming>; selected: number; width: number; height: number }) {
  return (
    <Backdrop width={width} height={height}>
      <div style={{ display: "flex", flexDirection: "column", width: Math.min(560, width - 60), backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.line, boxShadow: SHADOW, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", height: 40, paddingLeft: 16, borderBottomWidth: 1, borderColor: C.line }}>
          <T size={11} weight={700} color={C.accent}>
            FILAS QUE APUNTAN A ESTA
          </T>
        </div>
        <div style={{ display: "flex", flexDirection: "column", paddingTop: 6, paddingBottom: 6 }}>
          {incoming.map((ref, i) => {
            const source = catalog.byOid.get(ref.table)
            const columns = ref.foreignKey.columns.map((c) => source?.columns[c]?.name ?? "?").join(", ")
            const active = i === selected
            return (
              <div key={`${ref.table}:${columns}`} style={{ display: "flex", alignItems: "center", gap: 10, height: PICK_H, paddingLeft: 16, paddingRight: 16, backgroundColor: active ? C.accentSoft : undefined }}>
                <T mono size={13} color={active ? "#FFFFFF" : C.text}>
                  {source ? `${source.schema}.${source.name}` : "?"}
                </T>
                <T mono size={11.5} color={C.fk}>
                  {columns}
                </T>
              </div>
            )
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", height: 32, paddingLeft: 16, borderTopWidth: 1, borderColor: C.line }}>
          <Hints items={[["j k", "elegir"], ["⏎", "abrir"], ["esc", "cerrar"]]} />
        </div>
      </div>
    </Backdrop>
  )
}

/** Under the cursor cell (above it near the bottom): the column, its type and the value being typed. */
export function CellEditor({ table, mode, rect, width, height, onInput, onSubmit }: {
  table: Table
  mode: EditMode
  rect: { readonly x: number; readonly y: number; readonly w: number }
  width: number
  height: number
  onInput: (text: string) => void
  onSubmit: (text: string) => void
}) {
  const text = useRef(mode.text)
  // The field starts from this and then owns its text; `mode.text` follows it for esc.
  const start = useRef(mode.text).current
  const column = table.columns[mode.col]
  const w = Math.min(640, Math.max(380, rect.w + 40), width - 16)
  const h = mode.multiline ? 250 : 96
  const below = rect.y + ROW_H + 4
  const top = below + h < height - 60 ? below : Math.max(8, rect.y - h - 4)
  const left = Math.max(8, Math.min(rect.x, width - w - 8))
  const field = {
    autoFocus: true,
    testId: "cell-editor",
    value: start,
    placeholder: mode.initial === null ? "vacío: se queda como está" : "vacío: cadena vacía",
    onChange: (e: { value?: string }) => {
      text.current = e.value ?? ""
      onInput(text.current)
    },
    style: { flexGrow: 1, color: C.text, fontFamily: MONO, fontSize: 13 },
    theme: { caret: C.accent },
  }
  return (
    <div style={{ position: "absolute", left, top, width: w, display: "flex", flexDirection: "column", gap: 8, padding: 12, backgroundColor: C.raised, borderRadius: 8, borderWidth: 1, borderColor: C.accent, boxShadow: SHADOW }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <T mono size={12} weight={700} color={C.accent}>
          {column?.name ?? ""}
        </T>
        <T mono size={11} color={C.faint}>
          {column?.type ?? ""}
          {column && !column.nullable ? " · not null" : ""}
          {column?.defaultExpr ? ` · default ${column.defaultExpr}` : ""}
        </T>
      </div>
      <div style={{ display: "flex", height: mode.multiline ? 170 : 26, paddingLeft: 8, paddingRight: 8, paddingTop: 4, borderRadius: 5, backgroundColor: C.bg, borderWidth: 1, borderColor: C.line }}>
        {mode.multiline ? <textarea {...field} minRows={8} maxRows={8} /> : <input {...field} onSubmit={() => onSubmit(text.current)} />}
      </div>
      <Hints items={[[mode.multiline ? "esc" : "⏎ esc", "listo"], ["u", "después, lo deshace"]]} />
    </div>
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
  const w = Math.min(1100, width - 60)
  const h = height - 80
  const fit = Math.max(1, Math.floor((h - 46 - 40) / 24))
  const start = Math.min(scroll, Math.max(0, lines.length - fit))
  return (
    <Backdrop width={width} height={height}>
      <div style={{ display: "flex", flexDirection: "column", width: w, height: h, backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.line, boxShadow: SHADOW, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, height: 46, flexShrink: 0, paddingLeft: 18, paddingRight: 18, backgroundColor: C.panel, borderBottomWidth: 1, borderColor: C.line }}>
          <T size={13} weight={800}>
            Revisar cambios
          </T>
          <T size={12} color={C.faint}>
            {changes.size} {changes.size === 1 ? "cambio" : "cambios"}
          </T>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, paddingLeft: 18, paddingRight: 18, paddingTop: 6, overflow: "hidden" }}>
          {lines.slice(start, start + fit).map((line) => (
            <div key={line.key} style={{ display: "flex", alignItems: "center", gap: 10, height: 24, flexShrink: 0 }}>
              <ReviewRow line={line} />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, height: 40, flexShrink: 0, paddingLeft: 18, paddingRight: 18, backgroundColor: C.panel, borderTopWidth: 1, borderColor: C.line }}>
          <Hints items={[["⏎", "guardar"], ["j k", "desplazar"], ["esc", "volver"]]} />
          <div style={{ flexGrow: 1 }} />
          <T size={12} color={saving ? C.faint : C.danger}>
            {saving ? "Guardando…" : toast}
          </T>
        </div>
      </div>
    </Backdrop>
  )
}

function ReviewRow({ line }: { line: ReviewLine }) {
  switch (line.kind) {
    case "table":
      return (
        <T mono size={12.5} weight={700} color={C.muted}>
          {line.text}
        </T>
      )
    case "change":
      return (
        <>
          <T mono size={13} weight={800} color={line.color} style={{ width: 14 }}>
            {line.mark}
          </T>
          <T mono size={12.5} style={{ flexShrink: 0 }}>
            {line.label}
          </T>
          <T mono size={12} color={C.muted}>
            {line.detail}
          </T>
        </>
      )
    case "note":
      return (
        <T size={12} color={line.color} style={{ paddingLeft: 24 }}>
          {line.text}
        </T>
      )
    case "sql":
      return line.title ? (
        <T size={11} weight={700} color={C.accent}>
          {line.text}
        </T>
      ) : (
        <T mono size={11.5} color={C.faint}>
          {line.text}
        </T>
      )
  }
}
