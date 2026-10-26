// Mounts the GPUIX views: in the terminal through the Kitty graphics protocol, or in a
// native window (`--window`, used by the e2e tests). GPUIX keeps the process alive;
// the caller exits once the App is done.

import { RegistryContext } from "@effect/atom-react"
import { render } from "@gpuix/react"
import { Config, Effect } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import type * as App from "../../App.ts"
import { Root } from "./Root.tsx"

export const mount = Effect.fn("Gpuix.mount")(function* (app: App.Interface, registry: AtomRegistry.AtomRegistry, run: (effect: Effect.Effect<void>) => void, window: boolean) {
  // Automation (e2e) drives a window in the background without stealing focus.
  const background = yield* Config.Boolean("GPUIX_BACKGROUND").pipe(Config.withDefault(false))
  render(
    <RegistryContext.Provider value={registry}>
      <Root app={app} run={run} />
    </RegistryContext.Provider>,
    { terminal: !window, title: "qtty", width: 1440, height: 900, tabNavigation: false, keyboardFocusDim: false, focus: !background },
  )
})
