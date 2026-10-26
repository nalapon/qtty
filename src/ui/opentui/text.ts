// Text in terminal cells: colours without transparency (the palette's translucent
// washes, blended over the background) and strings cut or padded to a width.

import { C } from "../present.ts"

/** `color` laid over `under` at `alpha` (0 to 1), as one solid colour: GPUIX's translucent tints. */
export function wash(color: string, alpha: number, under: string = C.panel): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const mixed = [0, 1, 2].map((i) => Math.round(channel(under, i) + (channel(color, i) - channel(under, i)) * alpha))
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

/** Solid stand-ins for the GPUIX washes, which a terminal cannot blend. */
export const solid = {
  cursor: "#174A45",
  row: "#12201F",
  changed: "#3A3219",
  conflict: "#2C2614",
  selected: "#1C3B38",
  /** GPUIX's warning chips (C.warnSoft). */
  warn: wash(C.warn, 0x24 / 255),
  topBar: C.panel,
} as const

/** Display width of `text` in cells (wide characters take two). */
export const width = (text: string): number => Bun.stringWidth(text)

/** `text` cut to `cells` (with … when cut) and padded to exactly that width. */
export function fit(text: string, cells: number, align: "left" | "right" = "left"): string {
  if (cells <= 0) return ""
  let out = text
  if (width(out) > cells) {
    let cut = ""
    for (const ch of out) {
      if (width(cut + ch) > cells - 1) break
      cut += ch
    }
    out = `${cut}…`
  }
  const pad = " ".repeat(Math.max(0, cells - width(out)))
  return align === "right" ? pad + out : out + pad
}
