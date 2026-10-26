// Screens before the workspace: pick a connection, type a password, wait.

import { useRef, useState } from "react"
import type { Profile, Target } from "../../config/Profiles.ts"
import { address, C } from "../present.ts"
import { EnvBadge, Hints, MONO, SHADOW, T } from "./theme.tsx"

function Card({ width, height, children }: { width: number; height: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", width, height, justifyContent: "center", alignItems: "center", backgroundColor: C.bg }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, width: Math.min(720, width - 60), padding: 28, backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.line, boxShadow: SHADOW }}>
        {children}
      </div>
    </div>
  )
}

export function ConnectionsView({ profiles, selected, error, file, width, height }: { profiles: ReadonlyArray<Profile>; selected: number; error: string | null; file: string; width: number; height: number }) {
  return (
    <Card width={width} height={height}>
      <T size={20} weight={800}>
        qtty
      </T>
      {error && (
        <T size={12.5} color={C.danger} style={{ whiteSpace: "normal" }}>
          {error}
        </T>
      )}
      {profiles.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <T size={13} color={C.muted}>
            No hay conexiones guardadas. Puedes abrir una URL:
          </T>
          <T mono size={12.5}>
            qtty postgres://usuario@host:5432/base
          </T>
          <T size={13} color={C.muted}>
            o añadir perfiles en {file}
          </T>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {profiles.map((p, i) => (
            <div
              key={p.id}
              style={{ display: "flex", alignItems: "center", gap: 12, height: 34, paddingLeft: 12, paddingRight: 12, borderRadius: 6, backgroundColor: i === selected ? C.accentSoft : undefined, borderLeftWidth: 2, borderColor: i === selected ? C.accent : "#00000000" }}
            >
              <T size={13.5} weight={600} color={i === selected ? "#FFFFFF" : C.text} style={{ width: 200, flexShrink: 0 }}>
                {p.name}
              </T>
              <EnvBadge env={p.env} />
              <T mono size={12} color={C.muted}>
                {address(p)}
              </T>
            </div>
          ))}
        </div>
      )}
      <Hints items={profiles.length ? [["j k", "elegir"], ["⏎", "conectar"], ["q", "salir"]] : [["q", "salir"]]} />
    </Card>
  )
}

/** GPUIX inputs have no password mode: the text is drawn transparent and shown as dots. */
export function PasswordView({ target, error, onSubmit, width, height }: { target: Target; error: string | null; onSubmit: (password: string) => void; width: number; height: number }) {
  const text = useRef("")
  const [length, setLength] = useState(0)
  return (
    <Card width={width} height={height}>
      <T size={16} weight={700}>
        Contraseña para {target.profile.name}
      </T>
      <T mono size={12} color={C.muted}>
        {address(target.profile)}
      </T>
      {error && (
        <T size={12.5} color={C.danger} style={{ whiteSpace: "normal" }}>
          {error}
        </T>
      )}
      <div style={{ display: "flex", alignItems: "center", height: 34, paddingLeft: 10, paddingRight: 10, borderRadius: 6, backgroundColor: C.bg, borderWidth: 1, borderColor: C.accent }}>
        <input
          autoFocus
          testId="password"
          value=""
          onChange={(e) => {
            text.current = e.value ?? ""
            setLength(text.current.length)
          }}
          onSubmit={() => onSubmit(text.current)}
          style={{ flexGrow: 1, color: "#00000000", fontFamily: MONO, fontSize: 14 }}
          theme={{ caret: C.accent }}
        />
        <div style={{ position: "absolute", left: 10, top: 0, bottom: 0, display: "flex", alignItems: "center", pointerEvents: "none" }}>
          <T mono size={14} color={C.text}>
            {"•".repeat(length)}
          </T>
        </div>
      </div>
      <T size={12} color={C.faint}>
        {target.fromUrl ? "No se guardará." : "Se guardará en el llavero del sistema."}
      </T>
      <Hints items={[["⏎", "conectar"], ["esc", "volver"]]} />
    </Card>
  )
}

export function ConnectingView({ target, width, height }: { target: Target; width: number; height: number }) {
  return (
    <Card width={width} height={height}>
      <T size={16} weight={700}>
        Conectando a {target.profile.name}…
      </T>
      <T mono size={12} color={C.muted}>
        {address(target.profile)}
      </T>
      <Hints items={[["esc", "cancelar"]]} />
    </Card>
  )
}
