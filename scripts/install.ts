// Installs the binary from `bun run build` as a terminal command (`bun run install:local`):
//
//   macOS/Linux  ~/.local/bin/qtty
//   Windows      %LOCALAPPDATA%\Programs\qtty\qtty.exe, added to the user's PATH
//
// Running it again replaces the installed binary with a fresh build.

import { chmod, copyFile, mkdir, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

const windows = process.platform === "win32"
const name = windows ? "qtty.exe" : "qtty"
const dir = windows
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "qtty")
  : join(homedir(), ".local", "bin")
const target = join(dir, name)

await mkdir(dir, { recursive: true })
// A new file renamed over the old one, not the old one rewritten: macOS kills a binary
// whose contents changed under its code signature.
const temp = `${target}.new`
await copyFile(join("dist", name), temp)
await chmod(temp, 0o755)
await rename(temp, target)
console.log(`Instalado ${target}`)

const same = (a: string) => (windows ? a.toLowerCase() : a)
const inPath = (process.env.PATH ?? "").split(delimiter).some((entry) => same(entry) === same(dir))

if (inPath) console.log("Ya puedes usarlo: qtty")
else if (windows) {
  // The user's PATH lives in the registry; only terminals opened afterwards see it.
  const script = `$p = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($p -split ';') -contains $env:QTTY_DIR)) {
  [Environment]::SetEnvironmentVariable('Path', ((@($p, $env:QTTY_DIR) | Where-Object { $_ }) -join ';'), 'User')
}`
  const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], { env: { ...process.env, QTTY_DIR: dir } })
  if ((await child.exited) !== 0) console.log(`No se pudo añadir ${dir} al PATH: añádelo a mano`)
  else console.log("Añadido al PATH: abre una terminal nueva y usa qtty")
} else console.log(`${dir} no está en el PATH. Añade a tu ~/.zshrc o ~/.bashrc:\n  export PATH="$HOME/.local/bin:$PATH"`)
