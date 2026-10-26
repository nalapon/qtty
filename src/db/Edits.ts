// Writing: a change set becomes DELETE, UPDATE and INSERT statements, saved in one
// transaction. UPDATE and DELETE only touch the row if it still holds what was read
// (the touched columns for an UPDATE, the whole row for a DELETE); otherwise
// nothing is saved and the rows are reported as conflicts.
//
// Values bind untyped, so PostgreSQL reads them as the column's type with the same
// rules as any INSERT or UPDATE (a value too long for varchar(n) fails, not cut).

import { Effect, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { type ChangeSet, RowChange } from "../domain/ChangeSet.ts"
import type { Catalog, Table } from "./Catalog.ts"
import { describe } from "./describe.ts"
import { ident, literal, MAX_CELL, type Row } from "./Rows.ts"

export interface Statement {
  /** Row id of the change it saves. */
  readonly id: string
  readonly kind: "delete" | "update" | "insert"
  readonly text: string
  readonly params: ReadonlyArray<string | null>
  /** The statement with its values written in, for the review screen. */
  readonly display: string
}

/** Rows that changed on the server since they were read. Nothing was saved. */
export class Conflict extends Schema.TaggedError<Conflict>()("Edits.Conflict", {
  ids: Schema.Array(Schema.String),
}) {}

/** The server refused a statement (`id`) or the transaction (`id` null). Nothing was saved. */
export class Refused extends Schema.TaggedError<Refused>()("Edits.Refused", {
  id: Schema.NullOr(Schema.String),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** SQL text with its values kept apart until it is rendered. */
type Part = string | { readonly value: string | null; readonly type: string | null }

function render(id: string, kind: Statement["kind"], parts: ReadonlyArray<Part>): Statement {
  const params: Array<string | null> = []
  const text = parts.map((p) => (typeof p === "string" ? p : (params.push(p.value), `$${params.length}${p.type ? `::${p.type}` : ""}`))).join("")
  const display = parts.map((p) => (typeof p === "string" ? p : p.value === null ? "NULL" : literal(p.value))).join("")
  return { id, kind, text, params, display }
}

const relation = (table: Table) => `${ident(table.schema)}.${ident(table.name)}`
const columnName = (table: Table, col: number) => ident(table.columns[col]?.name ?? "")

/** `WHERE (key) = (values read)` plus, for each of `cols`, "still holds what was read". */
function sameRow(table: Table, original: Row, cols: ReadonlyArray<number>): ReadonlyArray<Part> {
  const key = table.key.flatMap((i, n): ReadonlyArray<Part> => [n ? ", " : "", { value: original.cells[i] ?? null, type: table.columns[i]?.type ?? "text" }])
  // Compared as the grid read them: text, cut where the grid cuts.
  const unchanged = cols.flatMap((c): ReadonlyArray<Part> => [` AND left(${columnName(table, c)}::text, ${MAX_CELL + 1}) IS NOT DISTINCT FROM `, { value: original.cells[c] ?? null, type: "text" }])
  return [` WHERE (${table.key.map((i) => columnName(table, i)).join(", ")}) = (`, ...key, ")", ...unchanged]
}

/** A value to write: untyped, or a plain NULL. */
const value = (v: string | null): Part => (v === null ? "NULL" : { value: v, type: null })

function statementOf(table: Table, id: string, change: RowChange): Statement {
  const from = relation(table)
  return RowChange.$match(change, {
    Delete: ({ original }) =>
      render(id, "delete", [`DELETE FROM ${from}`, ...sameRow(table, original, table.columns.map((_, i) => i)), " RETURNING 1"]),
    Update: ({ original, cells }) => {
      const set = [...cells].flatMap(([col, v], n): ReadonlyArray<Part> => [n ? ", " : "", `${columnName(table, col)} = `, value(v)])
      return render(id, "update", [`UPDATE ${from} SET `, ...set, ...sameRow(table, original, [...cells.keys()]), " RETURNING 1"])
    },
    Insert: ({ cells }) => {
      if (cells.size === 0) return render(id, "insert", [`INSERT INTO ${from} DEFAULT VALUES`])
      const values = [...cells.values()].flatMap((v, n): ReadonlyArray<Part> => [n ? ", " : "", value(v)])
      return render(id, "insert", [`INSERT INTO ${from} (${[...cells.keys()].map((c) => columnName(table, c)).join(", ")}) VALUES (`, ...values, ")"])
    },
  })
}

const ORDER = { delete: 0, update: 1, insert: 2 } as const

/** What a save runs, in order: deletes, updates, inserts. */
export function statements(catalog: Catalog, changes: ChangeSet): ReadonlyArray<Statement> {
  return [...changes]
    .flatMap(([id, p]) => {
      const table = catalog.byOid.get(p.table)
      return table ? [statementOf(table, id, p.change)] : []
    })
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
}

/**
 * Runs the statements in one transaction. Sessions start every transaction read-only,
 * so only `writable` asks for READ WRITE: a locked session's save is refused by the server.
 */
export const save = Effect.fn("Edits.save")(
  function* (statements: ReadonlyArray<Statement>, writable: boolean) {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (writable) yield* sql.unsafe("SET TRANSACTION READ WRITE")
        const conflicts: Array<string> = []
        for (const s of statements) {
          const rows = yield* sql.unsafe(s.text, s.params).pipe(Effect.mapError((cause) => new Refused({ id: s.id, message: describe(cause), cause })))
          if (s.kind !== "insert" && rows.length !== 1) conflicts.push(s.id)
        }
        if (conflicts.length) return yield* new Conflict({ ids: conflicts })
      }),
    )
  },
  // BEGIN or COMMIT failing (a lost connection, a deferred constraint).
  Effect.mapError((error) => (SqlError.isSqlError(error) ? new Refused({ id: null, message: describe(error), cause: error }) : error)),
)

/** Whether PostgreSQL reads `text` as `type`: null if it does, its complaint if not. */
export const check = Effect.fn("Edits.check")(function* (type: string, text: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.unsafe(`SELECT $1::${type}`, [text]).pipe(
    Effect.as(null),
    Effect.catch((error) => Effect.succeed(describe(error))),
  )
})

/** A whole value, for editing one the grid shows cut. Null when the row is gone. */
export const fullValue = Effect.fn("Edits.fullValue")(function* (table: Table, original: Row, col: number) {
  const sql = yield* SqlClient.SqlClient
  const { text, params } = render("", "update", [`SELECT ${columnName(table, col)}::text AS value FROM ${relation(table)}`, ...sameRow(table, original, [])])
  const rows = yield* sql.unsafe(text, params).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.NullOr(Schema.String) })))))
  const [row] = rows
  return row ? row.value : null
})
