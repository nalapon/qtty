// qtty entry point.
//
//   qtty                        pick a saved connection
//   qtty <profile>              open a saved connection by id or name
//   qtty postgres://…           open a URL without saving anything
//   qtty … --renderer opentui   force a renderer (gpuix | opentui)
//   qtty … --window             a native GPUIX window instead of the terminal (development)
//   qtty --version              the version and the interfaces this build loads
//
// GPUIX draws the richer UI and needs Ghostty or kitty on macOS outside tmux;
// anywhere else (Terminal.app, tmux, Windows Terminal…) OpenTUI draws it in text.

import { Config, Effect, FiberSet, Layer, Option } from "effect"
import { AtomRegistry } from "effect/reactivity"
import * as App from "./App.ts"
import * as Credentials from "./config/Credentials.ts"
import * as Profiles from "./config/Profiles.ts"
import pkg from "../package.json" with { type: "json" }

const args = process.argv.slice(2)
const windowMode = args.includes("--window")
const rendererAt = args.indexOf("--renderer")
const forced = rendererAt >= 0 ? args[rendererAt + 1] : undefined
const start = args.find((arg, i) => !arg.startsWith("--") && !(rendererAt >= 0 && i === rendererAt + 1))

/** GPUIX draws through the Kitty graphics protocol: Ghostty or kitty on macOS, outside tmux. */
const gpuixTerminal = Effect.gen(function* () {
  const term = yield* Config.String("TERM").pipe(Config.withDefault(""))
  const program = yield* Config.String("TERM_PROGRAM").pipe(Config.withDefault(""))
  const tmux = yield* Config.option(Config.String("TMUX"))
  return process.platform === "darwin" && Option.isNone(tmux) && (program === "ghostty" || term === "xterm-ghostty" || term === "xterm-kitty")
})

const ui = (renderer: "gpuix" | "opentui") =>
  Effect.gen(function* () {
    const app = yield* App.Service
    const registry = yield* AtomRegistry.AtomRegistry
    const runFork = yield* FiberSet.makeRuntime<never>()
    const run = (effect: Effect.Effect<void>) => void runFork(effect)
    // Each renderer is loaded only when used: OpenTUI builds carry no GPUIX addon.
    if (renderer === "gpuix") {
      const { mount } = yield* Effect.promise(() => import("./ui/gpuix/mount.tsx"))
      yield* mount(app, registry, run, windowMode)
    } else {
      const { mount } = yield* Effect.promise(() => import("./ui/opentui/mount.tsx"))
      yield* mount(app, registry, run)
    }
    yield* app.done
  })

/** Loads each interface's native library, as using it would. CI runs this on the compiled binary. */
const version = Effect.gen(function* () {
  const interfaces: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    // GPUIX's terminal mode is macOS-only, and other builds do not carry its addon.
    ...(process.platform === "darwin" ? [["gpuix", () => import("@gpuix/react")] as const] : []),
    ["opentui", () => import("@opentui/core").then((core) => core.resolveRenderLib())],
  ]
  for (const [name, load] of interfaces) {
    const loaded = yield* Effect.tryPromise(load).pipe(Effect.result)
    if (loaded._tag === "Failure") {
      console.error(`qtty ${pkg.version}: no se pudo cargar ${name}: ${String(loaded.failure.cause)}`)
      return 1
    }
  }
  console.log(`qtty ${pkg.version} (${interfaces.map(([name]) => name).join(", ")})`)
  return 0
})

const MainLayer = App.layer(start).pipe(Layer.provideMerge(AtomRegistry.layer), Layer.provide([Profiles.layer, Credentials.layer]))

const main = Effect.gen(function* () {
  if (args.includes("--version")) return yield* version
  if (forced !== undefined && forced !== "gpuix" && forced !== "opentui") {
    console.error(`--renderer admite gpuix u opentui, no «${forced}».`)
    return 1
  }
  const supported = yield* gpuixTerminal
  if (forced === "gpuix" && !supported && !windowMode) {
    console.error("GPUIX necesita Ghostty o kitty en macOS, fuera de tmux. Usa --window para abrirlo en una ventana.")
    return 1
  }
  const renderer = windowMode ? "gpuix" : (forced ?? (supported ? "gpuix" : "opentui"))
  yield* ui(renderer).pipe(Effect.scoped, Effect.provide(MainLayer))
  return 0
})

// GPUIX keeps the process alive, so leave explicitly once the scope (and the pool) is closed.
Effect.runPromise(main).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
