// GPUIX pieces of the visual identity (palette in ../present.ts): fonts, text,
// key caps, badges and the modal backdrop.

import type { ReactNode } from "react"
import type { StyleDesc } from "@gpuix/react"
import type { Env } from "../../config/Profiles.ts"
import { C, ENV } from "../present.ts"


export const MONO = "JetBrainsMonoNL Nerd Font"
export const SANS = ".SystemUIFont"
export function T({ children, color = C.text, size = 13, mono = false, weight, style }: { children: ReactNode; color?: string; size?: number; mono?: boolean; weight?: number; style?: StyleDesc }) {
  return (
    <text style={{ color, fontSize: size, fontFamily: mono ? MONO : SANS, fontWeight: weight, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden", ...style }}>
      {/* GPUIX lays out each text child as its own run, so join them into one string. */}
      {Array.isArray(children) ? children.join("") : children}
    </text>
  )
}

export function Kbd({ k }: { k: string }) {
  return (
    <div style={{ display: "flex", paddingLeft: 5, paddingRight: 5, height: 17, alignItems: "center", borderRadius: 4, backgroundColor: C.raised, borderWidth: 1, borderColor: C.line }}>
      <T mono size={11}>
        {k}
      </T>
    </div>
  )
}

export function Hints({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center", overflow: "hidden" }}>
      {items.map(([k, label]) => (
        <div key={k + label} style={{ display: "flex", gap: 5, alignItems: "center", flexShrink: 0 }}>
          <Kbd k={k} />
          <T size={12} color={C.muted}>
            {label}
          </T>
        </div>
      ))}
    </div>
  )
}

export function EnvBadge({ env }: { env: Env }) {
  const { label, color } = ENV[env]
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 8, paddingRight: 8, height: 20, borderRadius: 5, backgroundColor: `${color}22`, borderWidth: 1, borderColor: `${color}55` }}>
      <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <T size={11} weight={700} color={color}>
        {label}
      </T>
    </div>
  )
}

export function Pill({ label, color = C.accent }: { label: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", paddingLeft: 8, paddingRight: 8, height: 20, borderRadius: 4, backgroundColor: color, flexShrink: 0 }}>
      <T mono size={11} weight={800} color={C.onAccent}>
        {label}
      </T>
    </div>
  )
}

export function Chip({ text, tone }: { text: string; tone?: "warn" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 22, paddingLeft: 9, paddingRight: 9, borderRadius: 11, flexShrink: 0, backgroundColor: tone === "warn" ? C.warnSoft : C.raised, borderWidth: 1, borderColor: tone === "warn" ? "#E3B34155" : C.line }}>
      <T size={11.5} color={tone === "warn" ? C.warn : C.muted}>
        {text}
      </T>
    </div>
  )
}

/** Centered dimmed overlay used by modals. */
export function Backdrop({ width, height, children, align = "center" }: { width: number; height: number; children: ReactNode; align?: "center" | "flex-start" }) {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width, height, display: "flex", justifyContent: "center", alignItems: align, backgroundColor: C.backdrop }}>
      {children}
    </div>
  )
}

export const SHADOW = { offsetX: 0, offsetY: 18, blurRadius: 48, spreadRadius: 0, color: "#000000AA" }
