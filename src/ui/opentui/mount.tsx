/** @jsxImportSource @opentui/react */
// Mounts the OpenTUI views: text in any terminal (Terminal.app, tmux, Windows
// Terminal…). The renderer lives in the caller's scope; closing it restores the terminal.

import { RegistryContext } from "@effect/atom-react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import type * as App from "../../App.ts"
import { C } from "../present.ts"
import { Root } from "./Root.tsx"

/** The React tree, also rendered by the e2e tests into OpenTUI's test renderer. */
export const view = (app: App.Interface, registry: AtomRegistry.AtomRegistry, run: (effect: Effect.Effect<void>) => void) => (
  <RegistryContext.Provider value={registry}>
    <Root app={app} run={run} />
  </RegistryContext.Provider>
)

export const mount = Effect.fn("OpenTui.mount")(function* (app: App.Interface, registry: AtomRegistry.AtomRegistry, run: (effect: Effect.Effect<void>) => void) {
  const renderer = yield* Effect.acquireRelease(
    // ^c reaches the key handler, which keeps unsaved changes from being dropped. OpenTUI
    // destroys the renderer on SIGHUP, SIGTERM… (a closed terminal); then the App leaves too.
    Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, useMouse: false, backgroundColor: C.bg, onDestroy: () => run(app.quit) })),
    (renderer) => Effect.sync(() => renderer.destroy()),
  )
  createRoot(renderer).render(view(app, registry, run))
})
