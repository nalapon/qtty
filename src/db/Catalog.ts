// The database's shape, read once from pg_catalog on connect: schemas, tables,
// views, columns, the key used to identify rows, and foreign keys both ways.

import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

export type TableKind = "table" | "partitioned" | "view" | "matview" | "foreign"

export interface Column {
  readonly name: string
  /** As PostgreSQL prints it, e.g. `character varying(80)`. */
  readonly type: string
  readonly nullable: boolean
  readonly defaultExpr: string | null
  readonly identity: boolean
  readonly generated: boolean
  /** Set when the column alone is a foreign key. */
  readonly references: { readonly table: number; readonly column: string } | null
}

export interface ForeignKey {
  readonly columns: ReadonlyArray<number>
  readonly table: number
  readonly targetColumns: ReadonlyArray<string>
}

export interface Table {
  readonly oid: number
  readonly schema: string
  readonly name: string
  readonly kind: TableKind
  /** `pg_class.reltuples`; null until the table has been analyzed. */
  readonly estimate: number | null
  readonly columns: ReadonlyArray<Column>
  /** Column indexes of the primary key, or of a unique key whose columns are all NOT NULL. Empty when there is none. */
  readonly key: ReadonlyArray<number>
  readonly foreignKeys: ReadonlyArray<ForeignKey>
}

export interface Incoming {
  readonly table: number
  readonly foreignKey: ForeignKey
}

export interface Catalog {
  /** Sorted by schema, then name. */
  readonly tables: ReadonlyArray<Table>
  readonly byOid: ReadonlyMap<number, Table>
  /** Foreign keys in other tables that point at this one. */
  readonly incoming: ReadonlyMap<number, ReadonlyArray<Incoming>>
  readonly columnCount: number
}

export class CatalogError extends Schema.TaggedError<CatalogError>()("Catalog.CatalogError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const KIND: Record<string, TableKind> = { r: "table", p: "partitioned", v: "view", m: "matview", f: "foreign" }

// Partitions are hidden: their parent shows the rows.
const VISIBLE = `c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
  AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`

const RelationRow = Schema.Struct({
  oid: Schema.Number,
  schema: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  estimate: Schema.Number,
})

const ColumnRow = Schema.Struct({
  oid: Schema.Number,
  name: Schema.String,
  type: Schema.String,
  nullable: Schema.Boolean,
  default_expr: Schema.NullOr(Schema.String),
  identity: Schema.Boolean,
  generated: Schema.Boolean,
})

const ConstraintRow = Schema.Struct({
  oid: Schema.Number,
  kind: Schema.Literals(["p", "u", "f"]),
  columns: Schema.Array(Schema.String),
  target: Schema.Number,
  target_columns: Schema.Array(Schema.String),
})

const attnames = (rel: string, keys: string) =>
  `ARRAY(SELECT a.attname::text FROM unnest(${keys}) WITH ORDINALITY k(num, i)
     JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.num ORDER BY k.i)`

const RELATIONS = `
SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.reltuples::float8 AS estimate
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE ${VISIBLE}
ORDER BY n.nspname, c.relname`

const COLUMNS = `
SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
       NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
       a.attidentity <> '' AS identity, a.attgenerated <> '' AS generated
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0 AND NOT a.attisdropped AND ${VISIBLE}
ORDER BY a.attrelid, a.attnum`

const CONSTRAINTS = `
SELECT con.conrelid AS oid, con.contype::text AS kind, ${attnames("con.conrelid", "con.conkey")} AS columns,
       con.confrelid AS target, ${attnames("con.confrelid", "con.confkey")} AS target_columns
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype IN ('p','u','f') AND ${VISIBLE}
ORDER BY con.conrelid, con.contype, con.conname`

const query = <S extends Schema.Top>(sql: SqlClient.SqlClient, text: string, row: S) =>
  sql.unsafe(text).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row))))

export const load = Effect.fn("Catalog.load")(
  function* () {
    const sql = yield* SqlClient.SqlClient
    const [relations, columns, constraints] = yield* Effect.all(
      [query(sql, RELATIONS, RelationRow), query(sql, COLUMNS, ColumnRow), query(sql, CONSTRAINTS, ConstraintRow)],
      { concurrency: "unbounded" },
    )
    return build(relations, columns, constraints)
  },
  Effect.mapError((cause) => new CatalogError({ message: "No se pudo leer el catálogo", cause })),
)

function build(
  relations: ReadonlyArray<typeof RelationRow.Type>,
  columnRows: ReadonlyArray<typeof ColumnRow.Type>,
  constraints: ReadonlyArray<typeof ConstraintRow.Type>,
): Catalog {
  const columnsOf = new Map<number, Array<typeof ColumnRow.Type>>()
  for (const row of columnRows) {
    const list = columnsOf.get(row.oid)
    if (list) list.push(row)
    else columnsOf.set(row.oid, [row])
  }
  const constraintsOf = new Map<number, Array<typeof ConstraintRow.Type>>()
  for (const row of constraints) {
    const list = constraintsOf.get(row.oid)
    if (list) list.push(row)
    else constraintsOf.set(row.oid, [row])
  }

  const tables = relations.map((rel): Table => {
    const cols = columnsOf.get(rel.oid) ?? []
    const index = new Map(cols.map((c, i) => [c.name, i]))
    const indexes = (names: ReadonlyArray<string>) =>
      names.flatMap((n) => {
        const i = index.get(n)
        return i === undefined ? [] : [i]
      })
    const own = constraintsOf.get(rel.oid) ?? []
    const primary = own.find((c) => c.kind === "p")
    const unique = own.find((c) => c.kind === "u" && c.columns.every((n) => cols[index.get(n) ?? -1]?.nullable === false))
    const foreignKeys = own
      .filter((c) => c.kind === "f")
      .map((c): ForeignKey => ({ columns: indexes(c.columns), table: c.target, targetColumns: c.target_columns }))
    return {
      oid: rel.oid,
      schema: rel.schema,
      name: rel.name,
      kind: KIND[rel.kind] ?? "table",
      estimate: rel.estimate < 0 ? null : rel.estimate,
      columns: cols.map((c, i): Column => {
        const single = foreignKeys.find((fk) => fk.columns.length === 1 && fk.columns[0] === i)
        return {
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          defaultExpr: c.default_expr,
          identity: c.identity,
          generated: c.generated,
          references: single ? { table: single.table, column: single.targetColumns[0] ?? "" } : null,
        }
      }),
      key: indexes((primary ?? unique)?.columns ?? []),
      foreignKeys,
    }
  })

  const byOid = new Map(tables.map((t) => [t.oid, t]))
  const incoming = new Map<number, Array<Incoming>>()
  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      const list = incoming.get(foreignKey.table)
      if (list) list.push({ table: table.oid, foreignKey })
      else incoming.set(foreignKey.table, [{ table: table.oid, foreignKey }])
    }
  }
  return { tables, byOid, incoming, columnCount: columnRows.length }
}
