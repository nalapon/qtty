// Reads a table one page at a time. Rows are ordered by the table's key and pages
// continue from the last key seen (keyset), so going deep never scans skipped rows.
// Every value comes back as PostgreSQL's own text output; NULL stays null.
//
//   table with a key            ORDER BY key, WHERE (key) > (last seen)
//   table or matview without    the same with the physical row id (ctid)
//   view, foreign, partitioned  OFFSET, in whatever order the server returns
//   without a key
//
// A view of the table narrows it with a condition (`:where`) and orders it by one
// column first (`:sort`); the key still breaks ties, so keyset paging keeps working.

import { Data, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { Table } from "./Catalog.ts"

/** Where a row sits in the view's order: the sort value (when sorted), then the paging key, as text. */
export type Key = ReadonlyArray<string | null>

export interface Sort {
  /** Column index. */
  readonly column: number
  readonly desc: boolean
}

/** What the grid shows of a table: the rows matching `where` (SQL as typed), in `sort` order. */
export interface View {
  readonly where: string | null
  readonly sort: Sort | null
}

export const wholeTable: View = { where: null, sort: null }

export type Match = Data.TaggedEnum<{
  /** Some column's text contains `text`. */
  Text: { readonly text: string; readonly caseSensitive: boolean }
  /** These columns hold these values: the row a foreign key points at. */
  Equals: { readonly columns: ReadonlyArray<number>; readonly values: ReadonlyArray<string> }
}>
export const Match = Data.taggedEnum<Match>()

export type PageRequest = Data.TaggedEnum<{
  First: {}
  Last: {}
  After: { readonly key: Key }
  Before: { readonly key: Key }
  /** OFFSET paging only. `limit` lets a backwards page stop right before the rows already loaded. */
  Offset: { readonly offset: number; readonly limit: number }
  /**
   * The first row matching after `from` (the last one before it, backwards; from the
   * start or the end when null), followed by a page of the rows after it. No rows
   * means no match. Keyset paging only.
   */
  Seek: { readonly match: Match; readonly from: Key | null; readonly backwards: boolean }
}>
export const PageRequest = Data.taggedEnum<PageRequest>()

export interface Row {
  /** The row's place in the view's order; empty with OFFSET paging. */
  readonly key: Key
  readonly cells: ReadonlyArray<string | null>
}

export interface Page {
  /** In view order, whatever the direction of the request. */
  readonly rows: ReadonlyArray<Row>
  /** Fewer rows than asked for: there is nothing more in that direction. */
  readonly complete: boolean
}

export const PAGE_SIZE = 200
/** Longer values are cut server-side; the UI shows them with an ellipsis. */
export const MAX_CELL = 1000

export class QueryError extends Schema.TaggedError<QueryError>()("Rows.QueryError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Paging = "keyset" | "offset"

export const pagingOf = (table: Table): Paging =>
  table.key.length > 0 || table.kind === "table" || table.kind === "matview" ? "keyset" : "offset"

export const ident = (name: string) => `"${name.replaceAll('"', '""')}"`
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

interface Term {
  readonly expr: string
  readonly type: string
}

/** The paging key: the table's key, `ctid` for keyless tables, nothing with OFFSET paging. */
function keyOf(table: Table): ReadonlyArray<Term> {
  if (table.key.length === 0) return pagingOf(table) === "keyset" ? [{ expr: "ctid", type: "tid" }] : []
  return table.key.flatMap((i) => table.columns[i] ?? []).map((c) => ({ expr: ident(c.name), type: c.type }))
}

/** One read: which way, past which row, and which rows qualify. */
interface Scan {
  /** In the view's order (backwards reads come back reversed). */
  readonly forward: boolean
  readonly from?: Key
  readonly match?: Match
  readonly offset?: number
  readonly limit: number
}

/** The SELECT for one scan of a view and its parameters. */
function select(table: Table, view: View, scan: Scan): { readonly text: string; readonly params: ReadonlyArray<string | null> } {
  const params: Array<string | null> = []
  const param = (value: string | null, type: string) => {
    params.push(value)
    return `$${params.length}::${type}`
  }
  const key = keyOf(table)
  const sortColumn = view.sort ? table.columns[view.sort.column] : undefined
  const sort: Term | null = sortColumn ? { expr: ident(sortColumn.name), type: sortColumn.type } : null
  const terms = sort ? [sort, ...key] : key
  const paging = key.length ? terms : []
  // Ascending on the server: forward in the view unless the view is sorted descending.
  const ascending = scan.forward !== (view.sort?.desc ?? false)

  const conditions: Array<string> = []
  // On its own lines, so a `--` comment in it cannot swallow the rest of the query.
  if (view.where) conditions.push(`(\n${view.where}\n)`)
  if (scan.match) conditions.push(matching(table, scan.match, param))
  if (scan.from) conditions.push(beyond(sort, key, scan.from, ascending, param))

  const from = `${ident(table.schema)}.${ident(table.name)}`
  const keyArray = `ARRAY[${paging.map((t) => `${t.expr}::text`).join(", ")}]::text[]`
  const cellArray = `ARRAY[${table.columns.map((c) => `left(${ident(c.name)}::text, ${MAX_CELL + 1})`).join(", ")}]::text[]`
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""
  // PostgreSQL puts NULLs last going up and first going down, so a descending read is
  // the exact reverse of an ascending one; `beyond` relies on it.
  const order = terms.length ? ` ORDER BY ${terms.map((t) => `${t.expr} ${ascending ? "ASC" : "DESC"}`).join(", ")}` : ""
  const offset = scan.offset ? ` OFFSET ${Math.max(0, Math.floor(scan.offset))}` : ""
  return { text: `SELECT ${keyArray} AS key, ${cellArray} AS cells FROM ${from}${where}${order}${offset} LIMIT ${scan.limit}`, params }
}

/** Rows past `from` going up (`greater`) or down the server order. The key itself is never NULL; the sort value may be. */
function beyond(sort: Term | null, key: ReadonlyArray<Term>, from: Key, greater: boolean, param: (value: string | null, type: string) => string): string {
  const op = greater ? ">" : "<"
  const tuple = (terms: ReadonlyArray<Term>, values: Key) =>
    `(${terms.map((t) => t.expr).join(", ")}) ${op} (${terms.map((t, i) => param(values[i] ?? null, t.type)).join(", ")})`
  if (!sort) return tuple(key, from)
  const [value = null, ...rest] = from
  if (value === null) return greater ? `(${sort.expr} IS NULL AND ${tuple(key, rest)})` : `(${sort.expr} IS NOT NULL OR ${tuple(key, rest)})`
  const both = tuple([sort, ...key], from)
  return greater ? `(${both} OR ${sort.expr} IS NULL)` : both
}

function matching(table: Table, match: Match, param: (value: string | null, type: string) => string): string {
  return Match.$match(match, {
    Text: ({ text, caseSensitive }) => {
      if (table.columns.length === 0) return "false"
      const fold = (expr: string) => (caseSensitive ? expr : `lower(${expr})`)
      const needle = fold(param(text, "text"))
      return `(${table.columns.map((c) => `strpos(${fold(`${ident(c.name)}::text`)}, ${needle}) > 0`).join(" OR ")})`
    },
    Equals: ({ columns, values }) => {
      const cols = columns.flatMap((i) => table.columns[i] ?? [])
      return `(${cols.map((c) => ident(c.name)).join(", ")}) = (${cols.map((c, i) => param(values[i] ?? null, c.type)).join(", ")})`
    },
  })
}

const PageRows = Schema.Array(
  Schema.Struct({
    key: Schema.Array(Schema.NullOr(Schema.String)),
    cells: Schema.Array(Schema.NullOr(Schema.String)),
  }),
)

/** Reads one page. Interrupting the fiber cancels the query on the server. */
export const fetch = Effect.fn("Rows.fetch")(
  function* (table: Table, view: View, request: PageRequest, limit: number = PAGE_SIZE) {
    const sql = yield* SqlClient.SqlClient
    const read = (scan: Scan) => {
      const { text, params } = select(table, view, scan)
      return sql.unsafe(text, params).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PageRows)))
    }
    const forward = (scan: Scan) => read(scan).pipe(Effect.map((rows): Page => ({ rows, complete: rows.length < scan.limit })))
    const backward = (scan: Scan) => read(scan).pipe(Effect.map((rows): Page => ({ rows: [...rows].reverse(), complete: rows.length < scan.limit })))

    return yield* PageRequest.$match(request, {
      First: () => forward({ forward: true, limit }),
      Last: () => backward({ forward: false, limit }),
      After: ({ key }) => forward({ forward: true, from: key, limit }),
      Before: ({ key }) => backward({ forward: false, from: key, limit }),
      Offset: ({ offset, limit: max }) => forward({ forward: true, offset, limit: Math.min(limit, max) }),
      Seek: ({ match, from, backwards }) =>
        Effect.gen(function* () {
          const [hit] = yield* read({ forward: !backwards, from: from ?? undefined, match, limit: 1 })
          if (!hit) return { rows: [], complete: true } satisfies Page
          const rest = yield* forward({ forward: true, from: hit.key, limit: limit - 1 })
          return { rows: [hit, ...rest.rows], complete: rest.complete }
        }),
    })
  },
  (effect, table) => effect.pipe(Effect.mapError((cause) => new QueryError({ message: `No se pudo leer ${table.schema}.${table.name}`, cause }))),
)
