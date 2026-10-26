/** @jsxImportSource @opentui/react */
// Screens before the workspace: pick a connection, type a password, wait.

import { TextAttributes } from "@opentui/core"
import { useState, type ReactNode } from "react"
import type { Profile, Target } from "../../config/Profiles.ts"
import { address, C, ENV } from "../present.ts"
import { Hints } from "./Workspace.tsx"

function Card({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <box width={width} height={height} justifyContent="center" alignItems="center" backgroundColor={C.bg}>
      <box width={Math.min(78, width - 4)} flexDirection="column" gap={1} border borderStyle="rounded" borderColor={C.line} backgroundColor={C.panel} paddingX={2} paddingY={1}>
        {children}
      </box>
    </box>
  )
}

export function ConnectionsView({ profiles, selected, error, file, width, height }: { profiles: ReadonlyArray<Profile>; selected: number; error: string | null; file: string; width: number; height: number }) {
  return (
    <Card width={width} height={height}>
      <text fg={C.text} attributes={TextAttributes.BOLD}>
        qtty
      </text>
      {error && <text fg={C.danger}>{error}</text>}
      {profiles.length === 0 ? (
        <box flexDirection="column">
          <text fg={C.muted}>No hay conexiones guardadas. Puedes abrir una URL:</text>
          <text fg={C.text}>  qtty postgres://usuario@host:5432/base</text>
          <text fg={C.muted}>{`o añadir perfiles en ${file}`}</text>
        </box>
      ) : (
        <box flexDirection="column">
          {profiles.map((p, i) => (
            <text key={p.id} bg={i === selected ? C.raised : undefined}>
              <span fg={i === selected ? C.accent : C.ghost}>{i === selected ? "▌ " : "  "}</span>
              <span fg={i === selected ? "#FFFFFF" : C.text}>{p.name.padEnd(24)}</span>
              <span fg={ENV[p.env].color}>{ENV[p.env].label.padEnd(9)}</span>
              <span fg={C.muted}>{address(p)}</span>
            </text>
          ))}
        </box>
      )}
      <Hints items={profiles.length ? [["j k", "elegir"], ["⏎", "conectar"], ["q", "salir"]] : [["q", "salir"]]} />
    </Card>
  )
}

/** OpenTUI inputs have no password mode: the field's text is drawn in the background colour and dots go over it. */
export function PasswordView({ target, error, onSubmit, width, height }: { target: Target; error: string | null; onSubmit: (password: string) => void; width: number; height: number }) {
  const [length, setLength] = useState(0)
  return (
    <Card width={width} height={height}>
      <text fg={C.text} attributes={TextAttributes.BOLD}>
        Contraseña para {target.profile.name}
      </text>
      <text fg={C.muted}>{address(target.profile)}</text>
      {error && <text fg={C.danger}>{error}</text>}
      <box height={1} backgroundColor={C.bg}>
        <input focused onInput={(value) => setLength(value.length)} onSubmit={(value) => typeof value === "string" && onSubmit(value)} textColor={C.bg} focusedTextColor={C.bg} backgroundColor={C.bg} focusedBackgroundColor={C.bg} />
        <text position="absolute" left={0} top={0} fg={C.text}>
          {"•".repeat(length)}
        </text>
      </box>
      <text fg={C.faint}>{target.fromUrl ? "No se guardará." : "Se guardará en el llavero del sistema."}</text>
      <Hints items={[["⏎", "conectar"], ["esc", "volver"]]} />
    </Card>
  )
}

export function ConnectingView({ target, width, height }: { target: Target; width: number; height: number }) {
  return (
    <Card width={width} height={height}>
      <text fg={C.text} attributes={TextAttributes.BOLD}>
        Conectando a {target.profile.name}…
      </text>
      <text fg={C.muted}>{address(target.profile)}</text>
      <Hints items={[["esc", "cancelar"]]} />
    </Card>
  )
}
