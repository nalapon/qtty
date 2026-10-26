// The running application: which screen is up, connecting (and asking for a
// password when needed), and running what the key handler asks for. Screens live
// in one atom that the views read; key presses and text submissions come in here.

import { Cause, Context, Data, Deferred, Effect, Exit, FiberHandle, FiberSet, Layer, Option, Redacted, Scope } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Credentials from "./config/Credentials.ts"
import * as Profiles from "./config/Profiles.ts"
import { describe } from "./db/describe.ts"
import * as Edits from "./db/Edits.ts"
import type { Row } from "./db/Rows.ts"
import * as Session from "./db/Session.ts"
import * as Vim from "./keys/vim.ts"
import * as Workspace from "./state/Workspace.ts"

export type Screen = Data.TaggedEnum<{
  /** `file` is where profiles go, shown when there are none. */
  Connections: { readonly profiles: ReadonlyArray<Profiles.Profile>; readonly selected: number; readonly error: string | null; readonly file: string }
  Password: { readonly target: Profiles.Target; readonly error: string | null }
  Connecting: { readonly target: Profiles.Target }
  Workspace: { readonly session: Session.Interface; readonly ws: Workspace.Workspace }
}>
export const Screen = Data.taggedEnum<Screen>()

export interface Interface {
  readonly screen: Atom.Writable<Screen>
  readonly press: (key: string, viewport: Workspace.Viewport) => Effect.Effect<void>
  /** Enter in a text field: the password prompt, the `:` and `/` lines or the table finder. */
  readonly submit: (text: string, viewport: Workspace.Viewport) => Effect.Effect<void>
  /** A text field changed; the table finder narrows as you type. */
  readonly input: (text: string) => Effect.Effect<void>
  /** Leave now, e.g. when the terminal went away. */
  readonly quit: Effect.Effect<void>
  /** Completes when the user (or `quit`) leaves. */
  readonly done: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@qtty/App") {}

/** `start`: a `postgres://` URL or a profile id or name from the command line. */
export const layer = (start: string | undefined) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const profiles = yield* Profiles.Service
      const credentials = yield* Credentials.Service
      const appScope = yield* Effect.scope
      const quit = yield* Deferred.make<void>()
      const connecting = yield* FiberHandle.make()
      const loads = yield* FiberHandle.make()
      const saving = yield* FiberHandle.make()
      // Value checks and whole-value reads: small, independent, never cancelled by navigation.
      const lookups = yield* FiberSet.make()

      const screen = Atom.make<Screen>(Screen.Connections({ profiles: [], selected: 0, error: null, file: profiles.file })).pipe(Atom.keepAlive)
      const set = (next: Screen) => Effect.sync(() => registry.set(screen, next))
      const updateWorkspace = (f: (ws: Workspace.Workspace) => Workspace.Workspace) =>
        Effect.sync(() => registry.update(screen, (s) => (s._tag === "Workspace" ? Screen.Workspace({ ...s, ws: f(s.ws) }) : s)))

      const showConnections = Effect.fn("App.showConnections")(function* (error: string | null) {
        const listed = yield* profiles.list().pipe(Effect.result)
        if (listed._tag === "Failure") return yield* set(Screen.Connections({ profiles: [], selected: 0, error: listed.failure.message, file: profiles.file }))
        yield* set(Screen.Connections({ profiles: listed.success, selected: 0, error, file: profiles.file }))
      })

      // ── Running commands from the key handler ──────────────────────────────

      const load = (session: Session.Interface, { table, view, request }: Data.TaggedEnum.Value<Workspace.Command, "Load">): Effect.Effect<void> => {
        const meta = session.catalog.byOid.get(table)
        if (!meta) return Effect.void
        return session.page(meta, view, request).pipe(
          Effect.matchEffect({
            onFailure: (error) => updateWorkspace((ws) => Workspace.loadFailed(ws, table, request, describe(error.cause))),
            onSuccess: (page) =>
              Effect.gen(function* () {
                // Holding j past the loaded rows keeps pages coming without another key press.
                const next = yield* Effect.sync(() => {
                  const current = registry.get(screen)
                  if (current._tag !== "Workspace") return null
                  const [ws, command] = Workspace.prefetch(session.catalog, Workspace.loaded(current.ws, table, request, page))
                  registry.set(screen, Screen.Workspace({ ...current, ws }))
                  return command
                })
                // Same fiber: a newer load still interrupts the whole chain.
                if (next && next._tag === "Load") yield* load(session, next)
              }),
          }),
        )
      }

      /** Into the system clipboard: pbcopy on macOS, clip.exe on Windows. clip.exe reads the
       *  console's code page unless the text is UTF-16 with its byte order mark, so it gets that. */
      const copy = (text: string) =>
        Effect.tryPromise(async () => {
          const windows = process.platform === "win32"
          const input = windows ? Buffer.from(`﻿${text}`, "utf16le") : text
          const child = Bun.spawn([windows ? "clip.exe" : "pbcopy"], { stdin: new Blob([input]) })
          if ((await child.exited) !== 0) throw new Error(`exit ${child.exitCode}`)
        }).pipe(Effect.catch(() => updateWorkspace((ws) => ({ ...ws, toast: "No se pudo copiar" }))))

      /** Saves every pending change; a conflict rereads the rows that changed so the next save writes over them. */
      const save = Effect.fn("App.save")(function* (session: Session.Interface) {
        const before = registry.get(screen)
        if (before._tag !== "Workspace") return
        const { catalog } = session
        const result = yield* session.save(Edits.statements(catalog, before.ws.changes), !before.ws.locked).pipe(Effect.result)
        if (result._tag === "Success") {
          const next = yield* Effect.sync(() => {
            const current = registry.get(screen)
            if (current._tag !== "Workspace") return null
            const [ws, command] = Workspace.saved(catalog, current.ws)
            registry.set(screen, Screen.Workspace({ ...current, ws }))
            return command
          })
          if (next) yield* run(session, [next])
          return
        }
        const failure = result.failure
        if (failure._tag === "Edits.Refused") return yield* updateWorkspace((ws) => Workspace.saveRefused(ws, failure.id, failure.message))
        const now = yield* Effect.forEach(failure.ids, (id) => {
          const pending = before.ws.changes.get(id)
          const table = pending && catalog.byOid.get(pending.table)
          const original = pending && pending.change._tag !== "Insert" ? pending.change.original : null
          if (!table || !original) return Effect.succeed(null)
          return session.reread(table, original).pipe(Effect.map((row): readonly [string, Row | null] => [id, row]))
        }).pipe(Effect.result)
        if (now._tag === "Failure") return yield* updateWorkspace((ws) => Workspace.saveRefused(ws, null, describe(now.failure.cause)))
        yield* updateWorkspace((ws) => Workspace.conflicted(catalog, ws, now.success.filter((entry) => entry !== null)))
      })

      const run = (session: Session.Interface, commands: ReadonlyArray<Workspace.Command>): Effect.Effect<void> =>
        Effect.forEach(
          commands,
          Workspace.Command.$match({
            // A new load replaces the one in flight; interrupting it cancels its query on the server.
            Load: (command) => FiberHandle.run(loads, load(session, command)).pipe(Effect.asVoid),
            Cancel: () => FiberHandle.clear(loads),
            Check: (command) =>
              FiberSet.run(
                lookups,
                session.check(command.type, command.value).pipe(Effect.flatMap((problem) => updateWorkspace((ws) => Workspace.checked(ws, command, problem)))),
              ).pipe(Effect.asVoid),
            FetchValue: ({ target, col }) => {
              const table = session.catalog.byOid.get(target.table)
              if (!table || !target.original) return Effect.void
              return FiberSet.run(
                lookups,
                session.fullValue(table, target.original, col).pipe(
                  Effect.matchEffect({
                    onFailure: (error) => updateWorkspace((ws) => ({ ...ws, toast: `${error.message}: ${describe(error.cause)}` })),
                    onSuccess: (value) => updateWorkspace((ws) => Workspace.valueFetched(ws, target, col, value)),
                  }),
                ),
              ).pipe(Effect.asVoid)
            },
            Save: () => FiberHandle.run(saving, save(session), { onlyIfMissing: true }).pipe(Effect.asVoid),
            Copy: ({ text }) => copy(text),
            Quit: () => Deferred.succeed(quit, undefined).pipe(Effect.asVoid),
          }),
          { discard: true },
        )

      // ── Connecting ─────────────────────────────────────────────────────────

      const connect = Effect.fn("App.connect")(function* (target: Profiles.Target, typed: Option.Option<Redacted.Redacted>) {
        yield* set(Screen.Connecting({ target }))
        const password = Option.isSome(typed) ? typed : Option.isSome(target.password) ? target.password : yield* credentials.lookup(target.profile)

        // Each attempt gets its own scope so a failed one releases whatever it opened.
        const scope = yield* Scope.fork(appScope)
        const exit = yield* Session.make(target, password).pipe(Scope.provide(scope), Effect.exit)
        if (Exit.isFailure(exit)) {
          yield* Scope.close(scope, exit)
          const error = Cause.findErrorOption(exit.cause)
          if (Option.isNone(error)) return yield* Effect.failCause(exit.cause)
          if (error.value.reason === "password") {
            return yield* set(Screen.Password({ target, error: Option.isSome(password) ? error.value.message : null }))
          }
          return yield* showConnections(`${target.profile.name}: ${error.value.message}`)
        }

        const session = exit.value
        let toast = ""
        if (Option.isSome(typed) && !target.fromUrl) {
          const saved = yield* credentials.remember(target.profile, typed.value).pipe(Effect.result)
          toast = saved._tag === "Success" ? "Contraseña guardada en el llavero" : saved.failure.message
        }
        const [ws, first] = Workspace.prefetch(session.catalog, { ...Workspace.initial(session.catalog, target.profile.env === "prod"), toast })
        yield* set(Screen.Workspace({ session, ws }))
        if (first) yield* run(session, [first])
      })

      const startConnecting = (target: Profiles.Target, typed: Option.Option<Redacted.Redacted>) =>
        FiberHandle.run(connecting, connect(target, typed)).pipe(Effect.asVoid)

      // ── Input ──────────────────────────────────────────────────────────────

      const vimContext = (session: Session.Interface, viewport: Workspace.Viewport): Vim.Context => ({
        catalog: session.catalog,
        viewport,
        database: session.target.profile.database,
      })

      const press = Effect.fn("App.press")(function* (key: string, viewport: Workspace.Viewport) {
        const current = registry.get(screen)
        // In the workspace the key handler decides: ^c will not drop unsaved changes. (GPUIX's
        // terminal mode quits on ^c by itself before any handler runs; OpenTUI and the window do not.)
        if (key === "ctrl-c" && current._tag !== "Workspace") return yield* Deferred.succeed(quit, undefined)
        switch (current._tag) {
          case "Connections": {
            const count = current.profiles.length
            if (key === "j" || key === "down") return yield* set(Screen.Connections({ ...current, selected: Math.min(count - 1, current.selected + 1) }))
            if (key === "k" || key === "up") return yield* set(Screen.Connections({ ...current, selected: Math.max(0, current.selected - 1) }))
            if (key === "q") return yield* Deferred.succeed(quit, undefined)
            const profile = current.profiles[current.selected]
            if (key === "enter" && profile) return yield* startConnecting({ profile, password: Option.none(), fromUrl: false }, Option.none())
            return
          }
          case "Password":
            if (key === "escape") return yield* showConnections(null)
            return
          case "Connecting":
            if (key === "escape") {
              yield* FiberHandle.clear(connecting)
              return yield* showConnections(null)
            }
            return
          case "Workspace": {
            const [ws, commands] = Vim.reduce(vimContext(current.session, viewport), current.ws, key)
            if (ws !== current.ws) yield* set(Screen.Workspace({ ...current, ws }))
            return yield* run(current.session, commands)
          }
        }
      })

      const submit = Effect.fn("App.submit")(function* (text: string, viewport: Workspace.Viewport) {
        const current = registry.get(screen)
        if (current._tag === "Password") return yield* startConnecting(current.target, Option.some(Redacted.make(text)))
        if (current._tag === "Workspace") {
          const [ws, commands] = Vim.submit(vimContext(current.session, viewport), current.ws, text)
          if (ws !== current.ws) yield* set(Screen.Workspace({ ...current, ws }))
          return yield* run(current.session, commands)
        }
      })

      const input = (text: string) => updateWorkspace((ws) => Vim.typed(ws, text))

      // ── Start ──────────────────────────────────────────────────────────────

      const fromUrl = start === undefined ? Option.none() : Profiles.fromUrl(start)
      if (Option.isSome(fromUrl)) {
        yield* startConnecting(fromUrl.value, Option.none())
      } else if (start !== undefined) {
        const listed = yield* profiles.list().pipe(Effect.orElseSucceed(() => []))
        const profile = listed.find((p) => p.id === start || p.name === start)
        if (profile) yield* startConnecting({ profile, password: Option.none(), fromUrl: false }, Option.none())
        else yield* showConnections(`No hay ningún perfil llamado «${start}»`)
      } else {
        yield* showConnections(null)
      }

      return Service.of({ screen, press, submit, input, quit: Deferred.succeed(quit, undefined).pipe(Effect.asVoid), done: Deferred.await(quit) })
    }),
  )
