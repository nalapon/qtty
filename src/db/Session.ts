// One open connection to a database: a small pool, the catalog read on connect,
// and page reads. Lives in the caller's scope; closing it closes the pool.
//
// Every session is read-only on the server (`default_transaction_read_only`), so a
// write is rejected by PostgreSQL itself, not just hidden by the UI.

import { PgClient } from "@effect/sql-pg"
import { Effect, Option, Redacted, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient, SqlError } from "effect/sql"
import { sslModeOf, type Target } from "../config/Profiles.ts"
import * as Catalog from "./Catalog.ts"
import { describe } from "./describe.ts"
import * as Edits from "./Edits.ts"
import * as Rows from "./Rows.ts"

export interface Interface {
  readonly target: Target
  readonly catalog: Catalog.Catalog
  readonly page: (table: Catalog.Table, view: Rows.View, request: Rows.PageRequest) => Effect.Effect<Rows.Page, Rows.QueryError>
  /** The row as the server has it now, cut like the grid; null when it is gone. */
  readonly reread: (table: Catalog.Table, row: Rows.Row) => Effect.Effect<Rows.Row | null, Rows.QueryError>
  readonly fullValue: (table: Catalog.Table, row: Rows.Row, col: number) => Effect.Effect<string | null, Rows.QueryError>
  readonly check: (type: string, text: string) => Effect.Effect<string | null>
  readonly save: (statements: ReadonlyArray<Edits.Statement>, writable: boolean) => Effect.Effect<void, Edits.Conflict | Edits.Refused>
}

export class SessionError extends Schema.TaggedError<SessionError>()("Session.SessionError", {
  /** `password`: the server wants a (different) password. */
  reason: Schema.Literals(["password", "connect", "catalog"]),
  message: Schema.String,
}) {}


// The pool connects lazily, so a bad host or password may only show up on the first query.
const reasonOf = (error: unknown, otherwise: SessionError["reason"]): SessionError["reason"] => {
  if (!SqlError.isSqlError(error)) return otherwise
  if (error.reason._tag === "AuthenticationError") return "password"
  return error.reason._tag === "ConnectionError" ? "connect" : otherwise
}

const ssl = (target: Target) => {
  switch (sslModeOf(target.profile)) {
    case "disable":
      return false
    case "require":
      return { rejectUnauthorized: false }
    case "verify-full":
      return true
  }
}

/** Pool settings for a target. Exported so the tests can check what the server enforces. */
export const clientOptions = (target: Target, password: Option.Option<Redacted.Redacted>): PgClient.PgPoolConfig => ({
  host: target.profile.host,
  port: target.profile.port,
  database: target.profile.database,
  username: target.profile.user,
  password: Option.getOrUndefined(password),
  ssl: ssl(target),
  applicationName: "qtty",
  connectTimeout: "10 seconds",
  // One connection for page reads, one spare so a slow read never blocks the catalog or a save.
  maxConnections: 2,
  startupParameters: { default_transaction_read_only: "on" },
})

export const make = Effect.fn("Session.make")(function* (target: Target, password: Option.Option<Redacted.Redacted>) {
  const client = yield* PgClient.make(clientOptions(target, password)).pipe(
    Effect.provide(Reactivity.layer),
    Effect.mapError((error) => new SessionError({ reason: reasonOf(error, "connect"), message: describe(error) })),
  )
  const withClient = Effect.provideService(SqlClient.SqlClient, client)

  const catalog = yield* Catalog.load().pipe(
    withClient,
    Effect.mapError((error) => new SessionError({ reason: reasonOf(error.cause, "catalog"), message: describe(error.cause) })),
  )

  const page = (table: Catalog.Table, view: Rows.View, request: Rows.PageRequest) => Rows.fetch(table, view, request).pipe(withClient)

  const reread = (table: Catalog.Table, row: Rows.Row) =>
    Rows.fetch(table, Rows.wholeTable, Rows.PageRequest.Seek({ match: Rows.Match.Equals({ columns: table.key, values: table.key.map((i) => row.cells[i] ?? "") }), from: null, backwards: false }), 1).pipe(
      Effect.map((page) => page.rows[0] ?? null),
      withClient,
    )

  const fullValue = (table: Catalog.Table, row: Rows.Row, col: number) =>
    Edits.fullValue(table, row, col).pipe(
      Effect.mapError((cause) => new Rows.QueryError({ message: `No se pudo leer el valor de ${table.columns[col]?.name ?? "la columna"}`, cause })),
      withClient,
    )

  const check = (type: string, text: string) => Edits.check(type, text).pipe(withClient)
  const save = (statements: ReadonlyArray<Edits.Statement>, writable: boolean) => Edits.save(statements, writable).pipe(withClient)

  return { target, catalog, page, reread, fullValue, check, save } satisfies Interface
})
