// Starts the development PostgreSQL in Docker. Downloads pagila (pinned commit)
// into docker/initdb the first time; the container loads it on its first start.
// `--files-only` stops after the download (CI runners without Docker load it with psql).

import { fileURLToPath } from "node:url"

const PAGILA = "https://raw.githubusercontent.com/devrimgunduz/pagila/ce6e114236bb828e5ec0dc835f65f1bf1b9179f5"
const files = [
  ["pagila-schema.sql", "10-pagila-schema.sql"],
  ["pagila-data.sql", "11-pagila-data.sql"],
] as const

for (const [remote, local] of files) {
  const target = Bun.file(new URL(`../docker/initdb/${local}`, import.meta.url))
  if (await target.exists()) continue
  console.log(`Descargando ${remote}…`)
  const response = await fetch(`${PAGILA}/${remote}`)
  if (!response.ok) throw new Error(`${remote}: HTTP ${response.status}`)
  await Bun.write(target, response)
}

if (process.argv.includes("--files-only")) process.exit(0)

console.log("Arrancando PostgreSQL (la primera vez carga pagila y catalogo, tarda unos minutos)…")
// Preserve the container name and volume used by existing development databases.
const container = "qtty-postgres-1"
const current = Bun.spawnSync(["docker", "inspect", "--format", "{{.State.Running}}", container], { stdout: "pipe", stderr: "ignore" })
if (current.stdout.toString().trim() !== "true") {
  const up = Bun.spawn(current.exitCode === 0 ? ["docker", "start", container] : [
    "docker", "run", "--detach", "--name", container,
    "--env", "POSTGRES_USER=postgres", "--env", "POSTGRES_PASSWORD=qtty", "--env", "POSTGRES_DB=pagila",
    "--publish", "127.0.0.1:54329:5432",
    "--mount", `type=bind,source=${fileURLToPath(new URL("../docker/initdb", import.meta.url))},target=/docker-entrypoint-initdb.d,readonly`,
    "--volume", "qtty_pgdata:/var/lib/postgresql",
    // TCP avoids reporting readiness during the socket-only initialization server.
    "--health-cmd", "pg_isready -h 127.0.0.1 -U postgres -d pagila",
    "--health-interval", "2s", "--health-timeout", "3s", "--health-retries", "300",
    "pgvector/pgvector:pg18",
  ], { stdout: "inherit", stderr: "inherit" })
  const exitCode = await up.exited
  if (exitCode !== 0) process.exit(exitCode)
}

for (let attempt = 0; attempt < 300; attempt++) {
  const inspect = Bun.spawn(["docker", "inspect", "--format", "{{.State.Status}} {{.State.Health.Status}}", container], { stdout: "pipe", stderr: "inherit" })
  const state = (await new Response(inspect.stdout).text()).trim()
  const inspectExitCode = await inspect.exited
  if (inspectExitCode !== 0) process.exit(inspectExitCode)
  if (state === "running healthy") process.exit(0)
  if (state !== "running starting") throw new Error(`PostgreSQL: ${state}. Check docker logs ${container}`)
  await Bun.sleep(2_000)
}
throw new Error(`PostgreSQL did not become healthy within 10 minutes. Check docker logs ${container}`)
