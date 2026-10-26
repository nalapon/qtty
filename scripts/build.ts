// Compiles qtty into one executable for this machine (`bun run build`):
//
//   macOS    dist/qtty      both interfaces; src/bin.ts embeds GPUIX's native addon
//   Windows  dist/qtty.exe  OpenTUI (GPUIX's terminal mode needs macOS)
//
// `bun run build:windows` cross-compiles dist/qtty.exe from macOS (`--windows`). It first
// installs OpenTUI's Windows library, an optional dependency bun only installs on Windows.
//
// `qtty --version` loads the interfaces the binary carries; CI runs it to check the build.

const cross = process.argv.includes("--windows") && process.platform !== "win32"
const windows = cross || process.platform === "win32"
const outfile = windows ? "dist/qtty.exe" : "dist/qtty"

const result = await Bun.build({
  entrypoints: [windows ? "src/main.ts" : "src/bin.ts"],
  compile: cross ? { outfile, target: "bun-windows-x64" } : { outfile },
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`Compilado ${outfile}`)
