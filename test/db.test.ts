// Integration tests against the development PostgreSQL in Docker (`bun run db:up`).
// They read pagila and catalogo through a real Session, and use a separate
// writable connection only to set up and to check what the server saw.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { PgClient } from "@effect/sql-pg"
import { Effect, Exit, Fiber, Option, Scope } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { fromUrl, type Target } from "../src/config/Profiles.ts"
import type { Table } from "../src/db/Catalog.ts"
import { ident, literal, Match, MAX_CELL, PAGE_SIZE, PageRequest, pagingOf, wholeTable, type Page, type View } from "../src/db/Rows.ts"
import * as Session from "../src/db/Session.ts"
import * as ChangeSet from "../src/domain/ChangeSet.ts"
import * as Edits from "../src/db/Edits.ts"

const SERVER = process.env.QTTY_TEST_URL ?? "postgres://postgres:qtty@127.0.0.1:54329"
const targetFor = (database: string, server = SERVER): Target => Option.getOrThrow(fromUrl(`${server}/${database}`))

const scope = Effect.runSync(Scope.make())
const inScope = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(effect.pipe(Scope.provide(scope)))

/** A client with the session's own settings, or a writable one for setup and checks. */
const connect = (database: string, mode: "session" | "admin") => {
  const target = targetFor(database)
  const options = Session.clientOptions(target, target.password)
  return inScope(
    PgClient.make(mode === "session" ? options : { ...options, startupParameters: {}, applicationName: "qtty-tests" }).pipe(Effect.provide(Reactivity.layer)),
  )
}
const sessionSettings = await connect("pagila", "session")
const adminPagila = await connect("pagila", "admin")
const adminCatalogo = await connect("catalogo", "admin")
const adminQuery = (text: string, client: SqlClient.SqlClient = adminPagila) => Effect.runPromise(client.unsafe<Record<string, unknown>>(text))

// Per process, so parallel runs (Stryker) do not drop each other's table.
// Quotes in names, a unique key instead of a primary key (next to a nullable
// unique column that must not be used), and one long value.
const ODD_TABLE = `qtty test "odd" ${process.pid}`
// Rows the saving tests write to.
const EDIT_TABLE = `qtty test edits ${process.pid}`
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`
let pagila: Session.Interface
let catalogo: Session.Interface

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  // Runs killed before `afterAll` (Stryker times some out) leave their table behind.
  const tables = await adminQuery(`SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE 'qtty test %'`)
  for (const name of tables.map((t) => String(t.name))) {
    if (!alive(Number(name.split(" ").at(-1)))) await adminQuery(`DROP TABLE IF EXISTS public.${quoted(name)}`)
  }
  // pagila ships it unpopulated, which makes any read fail.
  await adminQuery(`REFRESH MATERIALIZED VIEW public.rental_by_category`)
  // The catalog test wants rental with a row estimate. Autovacuum gives it one, but only a while after the load.
  await adminQuery(`ANALYZE public.rental`)
  await adminQuery(`CREATE TABLE public.${quoted(ODD_TABLE)} (${quoted('weird "col"')} text, alt text UNIQUE, code text NOT NULL UNIQUE, note text)`)
  await adminQuery(
    `INSERT INTO public.${quoted(ODD_TABLE)} SELECT CASE WHEN g = 2 THEN 'v''2' ELSE 'v' || g END, 'a' || g, lpad(g::text, 5, '0'), CASE WHEN g = 1 THEN repeat('x', 5000) END FROM generate_series(450, 1, -1) g`,
  )
  // A key of two columns, and one value longer than the grid reads.
  await adminQuery(`CREATE TABLE public.${quoted(EDIT_TABLE)} (id integer, code varchar(5), name text NOT NULL, qty integer, note text, PRIMARY KEY (id, code))`)
  await adminQuery(`INSERT INTO public.${quoted(EDIT_TABLE)} SELECT g, 'c' || g, 'fila ' || g, g * 10, CASE WHEN g = 6 THEN repeat('x', 2000) END FROM generate_series(1, 6) g`)
  pagila = await inScope(Session.make(targetFor("pagila"), targetFor("pagila").password))
  catalogo = await inScope(Session.make(targetFor("catalogo"), targetFor("catalogo").password))
})
afterAll(async () => {
  await adminQuery(`DROP TABLE IF EXISTS public.${quoted(ODD_TABLE)}`)
  await adminQuery(`DROP TABLE IF EXISTS public.${quoted(EDIT_TABLE)}`)
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

const tableNamed = (session: Session.Interface, schema: string, name: string): Table => {
  const table = session.catalog.tables.find((t) => t.schema === schema && t.name === name)
  if (!table) throw new Error(`${schema}.${name} not in the catalog`)
  return table
}
const page = (session: Session.Interface, table: Table, request: PageRequest, view: View = wholeTable) => Effect.runPromise(session.page(table, view, request))
const column = (table: Table, name: string) => table.columns.findIndex((c) => c.name === name)

/** Follows pages in one direction until the view runs out, as scrolling would. */
async function walk(session: Session.Interface, table: Table, direction: "forward" | "backward", view: View = wholeTable): Promise<ReadonlyArray<Page["rows"][number]>> {
  const rows: Array<Page["rows"][number]> = []
  let current = await page(session, table, direction === "forward" ? PageRequest.First() : PageRequest.Last(), view)
  for (;;) {
    if (direction === "forward") rows.push(...current.rows)
    else rows.unshift(...current.rows)
    if (current.complete) return rows
    const edge = direction === "forward" ? current.rows.at(-1) : current.rows[0]
    if (!edge) return rows
    current = await page(session, table, direction === "forward" ? PageRequest.After({ key: edge.key }) : PageRequest.Before({ key: edge.key }), view)
  }
}

describe("catalog", () => {
  test("finds keys, foreign keys in both directions, views, and hides partitions", () => {
    const rental = tableNamed(pagila, "public", "rental")
    expect(rental.key.map((i) => rental.columns[i]?.name)).toEqual(["rental_id"])
    expect(rental.columns.filter((c) => c.references).map((c) => c.name).sort()).toEqual(["customer_id", "inventory_id", "staff_id"])
    expect(rental.estimate).toBeGreaterThan(0)
    expect(tableNamed(pagila, "public", "category").estimate).toBeNull() // never analyzed
    const customerId = rental.columns.find((c) => c.name === "customer_id")
    expect(customerId?.references && pagila.catalog.byOid.get(customerId.references.table)?.name).toBe("customer")

    const customer = tableNamed(pagila, "public", "customer")
    const pointing = (pagila.catalog.incoming.get(customer.oid) ?? []).map((i) => pagila.catalog.byOid.get(i.table)?.name)
    expect(pointing).toContain("rental")
    expect(pointing.every((name) => name !== undefined)).toBe(true)

    expect(tableNamed(pagila, "public", "actor_info")).toMatchObject({ kind: "view", key: [] })
    const payment = tableNamed(pagila, "public", "payment")
    expect(payment.kind).toBe("partitioned")
    expect(payment.key.map((i) => payment.columns[i]?.name)).toEqual(["payment_date", "payment_id"])
    expect(pagila.catalog.tables.some((t) => t.name.startsWith("payment_p20"))).toBe(false)
  })

  test("each kind of relation gets the paging it can support", () => {
    expect(pagingOf(tableNamed(pagila, "public", "payment"))).toBe("keyset")
    expect(pagingOf(tableNamed(pagila, "public", "rental_by_category"))).toBe("keyset")
    expect(pagingOf(tableNamed(pagila, "public", "actor_info"))).toBe("offset")
  })

  test("foreign keys are only the FK constraints, and a unique NOT NULL key stands in for a missing primary key", async () => {
    const rental = tableNamed(pagila, "public", "rental")
    const [{ count }] = (await adminQuery(`SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'public.rental'::regclass AND contype = 'f'`)) as [{ count: number }]
    expect(rental.foreignKeys.length).toBe(count)
    const odd = tableNamed(pagila, "public", ODD_TABLE)
    expect(odd.key.map((i) => odd.columns[i]?.name)).toEqual(["code"])
  })

  test("reads a wide catalog", async () => {
    const [{ count }] = (await adminQuery(
      `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`,
      adminCatalogo,
    )) as [{ count: number }]
    expect(catalogo.catalog.tables.length).toBe(count)
    expect(Math.max(...catalogo.catalog.tables.map((t) => t.columns.length))).toBeGreaterThan(120)
  })
})

describe("pages", () => {
  test("a composite key walks the whole table in order, forwards and backwards", async () => {
    const payment = tableNamed(pagila, "public", "payment")
    const expected = (await adminQuery(`SELECT ARRAY[payment_date::text, payment_id::text] AS key FROM public.payment ORDER BY payment_date, payment_id`)).map((r) => r.key)
    const forward = await walk(pagila, payment, "forward")
    expect(expected).toEqual(forward.map((r) => r.key))
    const backward = await walk(pagila, payment, "backward")
    expect(expected).toEqual(backward.map((r) => r.key))
  })

  test("a page shorter than asked is the last one, either way", async () => {
    const language = tableNamed(pagila, "public", "language")
    expect((await page(pagila, language, PageRequest.First())).complete).toBe(true)
    expect((await page(pagila, language, PageRequest.Last())).complete).toBe(true)
    const rental = tableNamed(pagila, "public", "rental")
    expect((await page(pagila, rental, PageRequest.Last())).complete).toBe(false)
  })

  test("values come back as PostgreSQL prints them, NULL stays null", async () => {
    const address = tableNamed(pagila, "public", "address")
    const first = await page(pagila, address, PageRequest.First())
    const [expected] = await adminQuery(`SELECT address_id::text, address2, last_update::text FROM public.address ORDER BY address_id LIMIT 1`)
    const cell = (name: string) => first.rows[0]?.cells[address.columns.findIndex((c) => c.name === name)]
    expect(cell("address_id")).toBe(String(expected?.address_id))
    expect(cell("address2")).toBe(expected?.address2 === null ? null : String(expected?.address2))
    expect(cell("last_update")).toBe(String(expected?.last_update))
  })

  test("a table without a key pages by row id without repeating or skipping rows", async () => {
    const keyless = catalogo.catalog.tables.find((t) => t.kind === "table" && t.key.length === 0 && (t.estimate ?? 0) > PAGE_SIZE)
    if (!keyless) throw new Error("catalogo has no keyless table bigger than a page")
    const rows = await walk(catalogo, keyless, "forward")
    const [{ count }] = (await adminQuery(`SELECT count(*)::int AS count FROM "${keyless.schema}"."${keyless.name}"`, adminCatalogo)) as [{ count: number }]
    expect(rows.length).toBe(count)
    expect(new Set(rows.map((r) => r.key.join())).size).toBe(count)
  })

  test("a view pages by offset, and a backwards page stops at the rows already loaded", async () => {
    const view = tableNamed(pagila, "public", "actor_info")
    const first = await page(pagila, view, PageRequest.First())
    const rest = await page(pagila, view, PageRequest.Offset({ offset: first.rows.length, limit: PAGE_SIZE }))
    const [{ count }] = (await adminQuery(`SELECT count(*)::int AS count FROM public.actor_info`)) as [{ count: number }]
    expect(first.rows.length + rest.rows.length).toBe(count)
    expect(rest.complete).toBe(true)
    const before = await page(pagila, view, PageRequest.Offset({ offset: 0, limit: 5 }))
    expect(before.rows.length).toBe(5)
    expect(before.complete).toBe(false)
    // Sorted, the offset counts in that order.
    const sorted = await page(pagila, view, PageRequest.Offset({ offset: 5, limit: 5 }), { where: null, sort: { column: column(view, "actor_id"), desc: true } })
    const expected = (await adminQuery(`SELECT actor_id::text AS id FROM public.actor_info ORDER BY actor_id DESC OFFSET 5 LIMIT 5`)).map((r) => String(r.id))
    expect(sorted.rows.map((r) => r.cells[column(view, "actor_id")])).toEqual(expected)
  })

  test("a materialized view pages by row id", async () => {
    const matview = tableNamed(pagila, "public", "rental_by_category")
    expect(matview.kind).toBe("matview")
    const rows = await walk(pagila, matview, "forward")
    const [{ count }] = (await adminQuery(`SELECT count(*)::int AS count FROM public.rental_by_category`)) as [{ count: number }]
    expect(rows.length).toBe(count)
  })

  test("quoted names and a unique key page in key order; long values are cut", async () => {
    const odd = tableNamed(pagila, "public", ODD_TABLE)
    const rows = await walk(pagila, odd, "forward")
    expect(rows.map((r) => r.key[0])).toEqual(Array.from({ length: 450 }, (_, i) => String(i + 1).padStart(5, "0")))
    const weird = odd.columns.findIndex((c) => c.name === 'weird "col"')
    const note = odd.columns.findIndex((c) => c.name === "note")
    expect(rows[0]?.cells[weird]).toBe("v1")
    expect(rows[1]?.cells[weird]).toBe("v'2")
    expect(rows[0]?.cells[note]?.length).toBe(MAX_CELL + 1)
    expect(rows[1]?.cells[note]).toBeNull()
    const backward = await walk(pagila, odd, "backward")
    expect(backward.map((r) => r.key[0])).toEqual(rows.map((r) => r.key[0]))
  })
})

describe("views", () => {
  const ids = (rows: ReadonlyArray<Page["rows"][number]>, table: Table, name: string) => rows.map((r) => r.cells[column(table, name)])

  test("sorting by a column with NULLs and ties walks every row once, in order, both ways", async () => {
    const address = tableNamed(pagila, "public", "address")
    for (const desc of [false, true]) {
      const view = { where: null, sort: { column: column(address, "address2"), desc } }
      const order = desc ? "address2 DESC NULLS FIRST, address_id DESC" : "address2 ASC NULLS LAST, address_id"
      const expected = (await adminQuery(`SELECT address_id::text AS id FROM public.address ORDER BY ${order}`)).map((r) => String(r.id))
      expect(ids(await walk(pagila, address, "forward", view), address, "address_id")).toEqual(expected)
      expect(ids(await walk(pagila, address, "backward", view), address, "address_id")).toEqual(expected)
    }

    // Going on from a row whose sort value is NULL, both ways.
    const view = { where: null, sort: { column: column(address, "address2"), desc: false } }
    const rows = await adminQuery(`SELECT address_id::text AS id, address2 FROM public.address ORDER BY address2, address_id`)
    const at = rows.findIndex((r) => r.address2 === null) + 1
    const key = [null, String(rows[at]?.id)]
    const all = rows.map((r) => String(r.id))
    expect(ids((await page(pagila, address, PageRequest.After({ key }), view)).rows, address, "address_id")).toEqual(all.slice(at + 1))
    expect(ids((await page(pagila, address, PageRequest.Before({ key }), view)).rows, address, "address_id")).toEqual(all.slice(at - PAGE_SIZE, at))
  })

  test("a filter applies to every page, together with the order", async () => {
    const rental = tableNamed(pagila, "public", "rental")
    const view = { where: "customer_id < 50 -- a comment must not hide the rest", sort: { column: column(rental, "rental_date"), desc: true } }
    const expected = (await adminQuery(`SELECT rental_id::text AS id FROM public.rental WHERE customer_id < 50 ORDER BY rental_date DESC, rental_id DESC`)).map((r) => String(r.id))
    expect(expected.length).toBeGreaterThan(PAGE_SIZE)
    expect(ids(await walk(pagila, rental, "forward", view), rental, "rental_id")).toEqual(expected)

    // What gr writes: quoted names and a value with a quote in it.
    const odd = tableNamed(pagila, "public", ODD_TABLE)
    const pointing = await walk(pagila, odd, "forward", { where: `${ident('weird "col"')} = ${literal("v'2")}`, sort: null })
    expect(pointing.map((r) => r.key)).toEqual([["00002"]])
  })

  test("a text seek visits each matching row in order, then finds nothing; uppercase makes it case-sensitive", async () => {
    const actor = tableNamed(pagila, "public", "actor")
    const expected = (await adminQuery(`SELECT actor_id::text AS id FROM public.actor WHERE lower(first_name || ' ' || last_name) LIKE '%pen%' ORDER BY actor_id`)).map((r) => String(r.id))
    const match = Match.Text({ text: "pen", caseSensitive: false })
    const found: Array<string | null | undefined> = []
    let from: Page["rows"][number]["key"] | null = null
    for (;;) {
      const result = await page(pagila, actor, PageRequest.Seek({ match, from, backwards: false }))
      const [hit, next] = result.rows
      if (!hit) break
      found.push(hit.cells[column(actor, "actor_id")])
      // The page goes on after the match, in table order.
      if (next) expect(Number(next.cells[column(actor, "actor_id")])).toBe(Number(hit.cells[column(actor, "actor_id")]) + 1)
      from = hit.key
    }
    expect(found).toEqual(expected)

    const last = await page(pagila, actor, PageRequest.Seek({ match, from: null, backwards: true }))
    expect(last.rows[0]?.cells[column(actor, "actor_id")]).toBe(expected.at(-1))
    const cased = await page(pagila, actor, PageRequest.Seek({ match: Match.Text({ text: "Pen", caseSensitive: true }), from: null, backwards: false }))
    expect(cased.rows).toEqual([])
  })

  test("an equality seek lands on the row a foreign key points at", async () => {
    const customer = tableNamed(pagila, "public", "customer")
    const id = column(customer, "customer_id")
    const result = await page(pagila, customer, PageRequest.Seek({ match: Match.Equals({ columns: [id], values: ["130"] }), from: null, backwards: false }))
    expect(result.rows.slice(0, 2).map((r) => r.cells[id])).toEqual(["130", "131"])
    expect(result.rows.length).toBe(PAGE_SIZE)

    // A key of two columns.
    const rental = tableNamed(pagila, "public", "rental")
    const pair = [column(rental, "customer_id"), column(rental, "staff_id")]
    const [first] = await adminQuery(`SELECT rental_id::text AS id FROM public.rental WHERE customer_id = 130 AND staff_id = 2 ORDER BY rental_id LIMIT 1`)
    const found = await page(pagila, rental, PageRequest.Seek({ match: Match.Equals({ columns: pair, values: ["130", "2"] }), from: null, backwards: false }))
    expect(found.rows[0]?.cells[column(rental, "rental_id")]).toBe(String(first?.id))
  })
})

describe("saving", () => {
  const edits = () => tableNamed(pagila, "public", EDIT_TABLE)
  const rowsNow = async () => (await adminQuery(`SELECT id, name, qty, code FROM public.${quoted(EDIT_TABLE)} ORDER BY id`)).map((r) => [r.id, r.name, r.qty, r.code])
  const read = async () => (await page(pagila, edits(), PageRequest.First())).rows
  const save = (changes: ChangeSet.ChangeSet, writable = true) => Effect.runPromise(pagila.save(Edits.statements(pagila.catalog, changes), writable).pipe(Effect.flip, Effect.option))
  const col = (name: string) => column(edits(), name)
  const idOf = (row: Page["rows"][number]) => ChangeSet.rowId(edits(), row)

  test("deletes, updates and inserts are saved in one transaction, in that order", async () => {
    const table = edits()
    const [one, two] = await read()
    if (!one || !two) throw new Error("fixture rows missing")
    let changes = ChangeSet.setCell(ChangeSet.empty, table, idOf(one), one, col("name"), "uno")
    changes = ChangeSet.setCell(changes, table, idOf(one), one, col("qty"), null)
    changes = ChangeSet.toggleDelete(changes, table, idOf(two), two)
    const fresh = ChangeSet.newRowId(table, 1)
    changes = ChangeSet.insert(changes, table, fresh)
    changes = ChangeSet.setCell(changes, table, fresh, null, col("id"), "100")
    changes = ChangeSet.setCell(changes, table, fresh, null, col("code"), "n")
    changes = ChangeSet.setCell(changes, table, fresh, null, col("name"), "it's new")
    expect(Edits.statements(pagila.catalog, changes).map((s) => s.kind)).toEqual(["delete", "update", "insert"])

    expect(Option.isNone(await save(changes))).toBe(true)
    const rows = await rowsNow()
    expect(rows.find((r) => r[0] === 1)).toEqual([1, "uno", null, "c1"])
    expect(rows.some((r) => r[0] === 2)).toBe(false)
    expect(rows.find((r) => r[0] === 100)).toEqual([100, "it's new", null, "n"])

    // A value the grid holds cut still matches what was read.
    const six = (await read()).find((r) => r.cells[col("id")] === "6")
    if (!six) throw new Error("fixture rows missing")
    expect(Option.isNone(await save(ChangeSet.setCell(ChangeSet.empty, table, idOf(six), six, col("note"), "corta")))).toBe(true)
    expect((await adminQuery(`SELECT note FROM public.${quoted(EDIT_TABLE)} WHERE id = 6`))[0]?.note).toBe("corta")
  })

  test("a row changed on the server since it was read is a conflict: nothing is saved until it is reread", async () => {
    const table = edits()
    const rows = await read()
    const three = rows.find((r) => r.cells[col("id")] === "3")
    const four = rows.find((r) => r.cells[col("id")] === "4")
    if (!three || !four) throw new Error("fixture rows missing")
    let changes = ChangeSet.setCell(ChangeSet.empty, table, idOf(three), three, col("name"), "mía")
    changes = ChangeSet.setCell(changes, table, idOf(four), four, col("name"), "también")
    await adminQuery(`UPDATE public.${quoted(EDIT_TABLE)} SET name = 'de otro' WHERE id = 3`)

    const failure = await save(changes)
    expect(Option.getOrUndefined(failure)).toMatchObject({ _tag: "Edits.Conflict", ids: [idOf(three)] })
    expect((await rowsNow()).filter((r) => r[0] === 3 || r[0] === 4).map((r) => r[1])).toEqual(["de otro", "fila 4"])

    const now = await Effect.runPromise(pagila.reread(table, three))
    expect(now?.cells[col("name")]).toBe("de otro")
    expect(Option.isNone(await save(ChangeSet.rebase(changes, idOf(three), now)))).toBe(true)
    expect((await rowsNow()).filter((r) => r[0] === 3 || r[0] === 4).map((r) => r[1])).toEqual(["mía", "también"])
  })

  test("the server refuses a value too long for its column, and any write from a locked session", async () => {
    const table = edits()
    const [, , , , five] = await read()
    if (!five) throw new Error("fixture rows missing")
    const tooLong = ChangeSet.setCell(ChangeSet.empty, table, idOf(five), five, col("code"), "demasiado")
    expect(Option.getOrUndefined(await save(tooLong))).toMatchObject({ _tag: "Edits.Refused", id: idOf(five) })

    const fine = ChangeSet.setCell(ChangeSet.empty, table, idOf(five), five, col("code"), "ok")
    const locked = Option.getOrUndefined(await save(fine, false))
    expect(locked?._tag).toBe("Edits.Refused")
    expect(locked?._tag === "Edits.Refused" ? locked.message : "").toContain("read-only")
    expect((await rowsNow()).find((r) => r[0] === 5)?.[3]).toBe("c5")
  })

  test("the server says whether a value reads as a type, and gives back a whole long value", async () => {
    expect(await Effect.runPromise(pagila.check("integer", "12"))).toBeNull()
    expect(await Effect.runPromise(pagila.check("integer", "abc"))).toContain("integer")
    const odd = tableNamed(pagila, "public", ODD_TABLE)
    const [first] = (await page(pagila, odd, PageRequest.First())).rows
    if (!first) throw new Error("fixture rows missing")
    expect((await Effect.runPromise(pagila.fullValue(odd, first, column(odd, "note"))))?.length).toBe(5000)
  })
})

describe("session", () => {
  test("the server refuses writes", async () => {
    const exit = await Effect.runPromiseExit(sessionSettings.unsafe(`CREATE TABLE public.qtty_should_not_exist (id int)`))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("25006") // read_only_sql_transaction
  })

  test("interrupting a page read cancels the query on the server", async () => {
    const language = tableNamed(pagila, "public", "language")
    // A filter that takes 30 s per row: what a slow `:where` looks like. The pid tells
    // this run's query apart from other runs' (Stryker runs several at once).
    const where = `pg_sleep(30) IS NOT NULL AND ${process.pid} > 0`
    const running = `SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'qtty' AND state = 'active' AND query LIKE '%${where}%'`
    const until = async (count: number) => {
      for (let i = 0; i < 100; i++) {
        const [row] = (await adminQuery(running)) as [{ count: number }]
        if (row.count === count) return
        await Bun.sleep(50)
      }
      throw new Error(`expected ${count} running slow queries`)
    }
    const fiber = Effect.runFork(pagila.page(language, { where, sort: null }, PageRequest.First()))
    await until(1)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await until(0)
  })

  test("a wrong password asks for the password; a closed port does not", async () => {
    const wrong = await inScope(Effect.flip(Session.make(targetFor("pagila", "postgres://postgres:wrong@127.0.0.1:54329"), targetFor("pagila", "postgres://postgres:wrong@127.0.0.1:54329").password)))
    expect(wrong.reason).toBe("password")
    const closed = await inScope(Effect.flip(Session.make(targetFor("pagila", "postgres://postgres:x@127.0.0.1:1"), Option.none())))
    expect(closed.reason).toBe("connect")
  })
})
