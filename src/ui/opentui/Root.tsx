/** @jsxImportSource @opentui/react */
// Top of the OpenTUI view: reads the current screen from the App atom and sends
// every key press back to the App, with the grid size this layout gives it.

import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { Effect } from "effect"
import { useContext } from "react"
import type * as App from "../../App.ts"
import type { Viewport } from "../../state/Workspace.ts"
import { ConnectingView, ConnectionsView, PasswordView } from "./Connections.tsx"
import { viewportFor } from "./layout.ts"
import { WorkspaceView } from "./Workspace.tsx"

const NO_GRID: Viewport = { rows: 1, colsFrom: () => 1 }
/** Workspace modes with a focused text field. */
const TEXT_MODES = new Set(["Command", "Search", "Finder", "Edit", "Unlock"])
/** Keys that still reach the key handler while a text field has focus: closing it, the finder's arrows, ^c. */
const FROM_FIELDS = new Set(["escape", "up", "down", "ctrl-n", "ctrl-p", "ctrl-j", "ctrl-k", "ctrl-c"])

/** OpenTUI key event → the names the key handler uses ("j", "G", "ctrl-d", "space"…). */
function keyName(event: KeyEvent): string {
  if (event.ctrl) return `ctrl-${event.name}`
  if (event.name === "return") return "enter"
  if (event.name === "space" || event.name === "escape" || event.name === "tab") return event.name
  const ch = event.sequence
  if (ch.length === 1 && ch > " ") return ch
  return event.name
}

const typing = (screen: App.Screen) => screen._tag === "Password" || (screen._tag === "Workspace" && TEXT_MODES.has(screen.ws.mode._tag))

export function Root({ app, run }: { app: App.Interface; run: (effect: Effect.Effect<void>) => void }) {
  const registry = useContext(RegistryContext)
  const screen = useAtomValue(app.screen)
  const { width, height } = useTerminalDimensions()
  const viewport = () => (screen._tag === "Workspace" ? viewportFor(screen.session.catalog, screen.ws, width, height) : NO_GRID)

  useKeyboard((event) => {
    const key = keyName(event)
    // The screen as it is now, not as last drawn: keys can arrive faster than frames
    // (Enter on a field, then `:` before the field is gone).
    if (typing(registry.get(app.screen)) && !FROM_FIELDS.has(key)) return
    run(app.press(key, viewport()))
  })
  const submit = (text: string) => run(app.submit(text, viewport()))
  const input = (text: string) => run(app.input(text))

  switch (screen._tag) {
    case "Connections":
      return <ConnectionsView profiles={screen.profiles} selected={screen.selected} error={screen.error} file={screen.file} width={width} height={height} />
    case "Password":
      return <PasswordView key={screen.error ?? ""} target={screen.target} error={screen.error} onSubmit={submit} width={width} height={height} />
    case "Connecting":
      return <ConnectingView target={screen.target} width={width} height={height} />
    case "Workspace":
      return <WorkspaceView session={screen.session} ws={screen.ws} width={width} height={height} onSubmit={submit} onInput={input} />
  }
}
