// Top of the GPUIX view: reads the current screen from the App atom and sends
// every key press back to the App, with the grid size this layout gives it.

import { useAtomValue } from "@effect/atom-react"
import { useGpuix, useWindowSize, type KeyEvent, type PublicInstance } from "@gpuix/react"
import type { Effect } from "effect"
import { useEffect, useRef } from "react"
import type * as App from "../../App.ts"
import type { Viewport } from "../../state/Workspace.ts"
import { ConnectingView, ConnectionsView, PasswordView } from "./Connections.tsx"
import { viewportFor } from "./layout.ts"
import { C } from "../present.ts"
import { WorkspaceView } from "./WorkspaceView.tsx"

const NO_GRID: Viewport = { rows: 1, colsFrom: () => 1 }
/** Workspace modes with a focused text field. */
const TEXT_MODES = new Set(["Command", "Search", "Finder", "Edit", "Unlock"])

/** GPUIX key event → the names the key handler uses ("j", "G", "ctrl-d", "space"…). */
function keyName(event: KeyEvent): string {
  const key = event.key ?? ""
  if (event.modifiers?.ctrl) return `ctrl-${key}`
  if (event.modifiers?.cmd) return `cmd-${key}`
  if (key === "space") return "space"
  const ch = event.keyChar
  if (ch && ch.length === 1 && ch >= " " && key.length === 1) return ch
  return key
}

export function Root({ app, run }: { app: App.Interface; run: (effect: Effect.Effect<void>) => void }) {
  const screen = useAtomValue(app.screen)
  const { width, height } = useWindowSize()
  const { renderer } = useGpuix()
  const rootRef = useRef<PublicInstance>(null)

  // Text fields take focus while open; give it back to the root when they close.
  const typing = screen._tag === "Password" || (screen._tag === "Workspace" && TEXT_MODES.has(screen.ws.mode._tag))
  useEffect(() => {
    const id = rootRef.current?.id
    if (!typing && id !== undefined) renderer?.focusElement?.(id)
  }, [typing, screen._tag, renderer])

  const viewport = () => (screen._tag === "Workspace" ? viewportFor(screen.session.catalog, screen.ws, width, height) : NO_GRID)
  const onKeyDown = (event: KeyEvent) => {
    const key = keyName(event)
    if (key === "tab") event.preventDefault()
    run(app.press(key, viewport()))
  }
  const submit = (text: string) => run(app.submit(text, viewport()))
  const input = (text: string) => run(app.input(text))

  return (
    <div ref={rootRef} testId="root" tabIndex={0} autoFocus onKeyDown={onKeyDown} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg }}>
      {width > 0 &&
        (() => {
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
        })()}
    </div>
  )
}
