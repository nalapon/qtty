// End to end: the real app against the Docker PostgreSQL. GPUIX runs as a process
// driven through its automation, which talks over stdio, so the app runs in its
// window mode; the React tree and the key handling are the same as in the terminal.
// OpenTUI runs in this process, in its test renderer, with the same App.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launch } from "@gpuix/native/automation"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { SQL } from "bun"
import { Context, Effect, Exit, FiberSet, Layer, Scope } from "effect"
import { AtomRegistry } from "effect/reactivity"
import * as App from "../src/App.ts"
import * as Credentials from "../src/config/Credentials.ts"
import * as Profiles from "../src/config/Profiles.ts"
import { view } from "../src/ui/opentui/mount.tsx"

const SERVER = process.env.QTTY_TEST_URL ?? "postgres://postgres:qtty@127.0.0.1:54329"
const withoutPassword = SERVER.replace(/:[^:@/]*@/, "@")
// A table to edit, created before the app reads the catalog.
const EDIT_TABLE = `qtty_e2e_${process.pid}`
const admin = new SQL(`${SERVER}/pagila`)

beforeAll(async () => {
  await admin.unsafe(`CREATE TABLE public.${EDIT_TABLE} (id integer PRIMARY KEY, name text NOT NULL)`)
  await admin.unsafe(`INSERT INTO public.${EDIT_TABLE} SELECT g, 'fila ' || g FROM generate_series(1, 5) g`)
})
afterAll(async () => {
  await admin.unsafe(`DROP TABLE IF EXISTS public.${EDIT_TABLE}`)
  await admin.close()
})

describe("GPUIX", () => {
  let app: Awaited<ReturnType<typeof launch>>

  beforeAll(async () => {
    app = await launch({
      command: "bun",
      args: ["src/main.ts", `${withoutPassword}/pagila`, "--window"],
      cwd: new URL("..", import.meta.url).pathname,
      env: { GPUIX_BACKGROUND: "1", NODE_ENV: "production" },
    })
    await app.getByTestId("root").waitFor({ timeoutMs: 15_000 })
  })
  afterAll(() => app.close())

  /** Waits until something shows `text`. Several elements may (the grid and the inspector show the same
   *  values), which `waitFor` would reject as ambiguous. */
  const shows = async (text: string) => {
    for (let waited = 0; waited < 5_000; waited += 50) {
      if ((await app.getByText(text).count()) > 0) return
      await Bun.sleep(50)
    }
    throw new Error(`nothing showed «${text}»`)
  }

  test("asks for the password, then opens the first table", async () => {
    await app.getByTestId("password").waitFor({ timeoutMs: 10_000 })
    await app.getByTestId("password").fill(new URL(SERVER).password || "qtty")
    await app.getByTestId("password").press("enter")
    await shows(`${new URL(SERVER).username}@${new URL(SERVER).host}/pagila`)
    await shows("public.actor")
    await shows("PENELOPE")
  })

  test("G reads the end of the table and K opens the row sheet", async () => {
    const root = app.getByTestId("root")
    await root.press("tab")
    await root.press("G")
    await shows("última fila")
    await root.press("K")
    await shows("CLAVE")
    await root.press("escape")
    expect(await app.getByText("CLAVE").count()).toBe(0)
  })

  test("space e hides the table list and Tab brings it back", async () => {
    const root = app.getByTestId("root")
    await root.press("space")
    await root.press("e")
    expect(await app.getByText("TABLAS").count()).toBe(0)
    await root.press("tab")
    await shows("TABLAS")
  })

  test("space space opens a table by name; gd follows a foreign key and ^o comes back", async () => {
    const root = app.getByTestId("root")
    await root.press("space")
    await root.press("space")
    const finder = app.getByTestId("finder")
    await finder.waitFor({ timeoutMs: 5_000 })
    await finder.fill("rental")
    await finder.press("enter")
    await shows("public.rental")
    // rental 1 was rented by customer 130, CHARLOTTE HUNTER.
    for (let i = 0; i < 3; i++) await root.press("l")
    await shows("customer_id: integer")
    await root.press("g")
    await root.press("d")
    await shows("public.customer")
    await shows("CHARLOTTE")
    await root.press("ctrl-o")
    await shows("public.rental")
  })

  test(":where filters the open table", async () => {
    await app.getByTestId("root").press(":")
    const line = app.getByTestId("command")
    await line.waitFor({ timeoutMs: 5_000 })
    await line.fill("where customer_id = 130")
    await line.press("enter")
    await shows("where customer_id = 130")
    await shows("fila 1 de 63")
  })

  test("edit a cell, add a row and delete another, then save them from the review", async () => {
    const root = app.getByTestId("root")
    await root.press("space")
    await root.press("space")
    await app.getByTestId("finder").fill(EDIT_TABLE)
    await app.getByTestId("finder").press("enter")
    await shows(`public.${EDIT_TABLE}`)

    const editor = app.getByTestId("cell-editor")
    const type = async (text: string) => {
      await editor.waitFor({ timeoutMs: 5_000 })
      await editor.fill(text)
      await editor.press("enter")
    }
    await root.press("l")
    await root.press("c")
    await type("editada")
    await root.press("o") // a new row, editing its id
    await type("50")
    await root.press("l")
    await root.press("c")
    await type("nueva")
    for (const key of ["j", "j", "j", "d", "d"]) await root.press(key) // row 3

    await root.press(":")
    await app.getByTestId("command").fill("w")
    await app.getByTestId("command").press("enter")
    await shows("Revisar cambios")
    await root.press("enter")
    await shows("Guardado: 3 cambios")
    const rows = await admin.unsafe(`SELECT id, name FROM public.${EDIT_TABLE} ORDER BY id`)
    expect(rows.map((r: { id: number; name: string }) => `${r.id} ${r.name}`)).toEqual(["1 editada", "2 fila 2", "4 fila 4", "5 fila 5", "50 nueva"])
  })
})

describe("OpenTUI", () => {
  const scope = Effect.runSync(Scope.make())
  let app: App.Interface
  let screen: TestRendererSetup

  beforeAll(async () => {
    const layer = App.layer(`${SERVER}/pagila`).pipe(Layer.provideMerge(AtomRegistry.layer), Layer.provide([Profiles.layer, Credentials.layer]))
    const services = await Effect.runPromise(Layer.build(layer).pipe(Scope.provide(scope)))
    app = Context.get(services, App.Service)
    const runFork = await Effect.runPromise(FiberSet.makeRuntime<never>().pipe(Scope.provide(scope)))
    screen = await testRender(
      view(app, Context.get(services, AtomRegistry.AtomRegistry), (effect) => void runFork(effect)),
      { width: 140, height: 40, exitOnCtrlC: false },
    )
    // The screen changes when the App's atom does, asynchronously as in the real app, not inside act().
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false)
  })
  afterAll(async () => {
    await screen.dispose()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  /** Renders until the screen shows `text`; reads come from the real database, so this waits on time. */
  const sees = async (text: string) => {
    for (let waited = 0; waited < 5_000; waited += 20) {
      await screen.renderOnce()
      if (screen.captureCharFrame().includes(text)) return
      await Bun.sleep(20)
    }
    throw new Error(`the screen never showed «${text}»:\n${screen.captureCharFrame()}`)
  }
  const keys = (...names: ReadonlyArray<string>) => {
    for (const name of names) screen.mockInput.pressKey(name)
  }
  /** ␣␣, then the table name once the finder is up. */
  const openTable = async (name: string) => {
    keys(" ", " ")
    await sees("TABLA ")
    await screen.mockInput.typeText(name)
    await sees(`TABLA ${name}`)
    screen.mockInput.pressEnter()
    await sees(`public.${name}`)
    await sees("fila 1 ")
  }
  const command = async (text: string) => {
    keys(":")
    await sees("COMANDO")
    await screen.mockInput.typeText(text)
    screen.mockInput.pressEnter()
  }

  test("opens the URL, and G reads the end of the table", async () => {
    await sees("PENELOPE")
    keys("TAB", "G")
    await sees("última fila")
  })

  test("space space opens a table; gd follows a foreign key and ^o comes back", async () => {
    await openTable("rental")
    keys("l", "l", "l", "g", "d")
    await sees("CHARLOTTE")
    screen.mockInput.pressKey("o", { ctrl: true })
    await sees("public.rental ")
  })

  test("edit a cell and save it from the review", async () => {
    await openTable(EDIT_TABLE)
    keys("j", "l", "c")
    await sees("EDITAR")
    await screen.mockInput.typeText("desde opentui")
    screen.mockInput.pressEnter()
    await command("w")
    await sees("Revisar cambios")
    screen.mockInput.pressEnter()
    await sees("Guardado: 1 cambio")
    const [row] = await admin.unsafe(`SELECT name FROM public.${EDIT_TABLE} WHERE id = 2`)
    expect(row?.name).toBe("desde opentui")
  })

  test("^c keeps unsaved changes; without any it leaves", async () => {
    keys("d", "d")
    screen.mockInput.pressKey("c", { ctrl: true })
    await sees("sin guardar: :w guarda")
    await command("e!")
    await sees("Cambios descartados")
    screen.mockInput.pressKey("c", { ctrl: true })
    expect(await Effect.runPromise(app.done.pipe(Effect.timeout("2 seconds"), Effect.as("left")))).toBe("left")
  }, 15_000)
})
