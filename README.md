# qtty

qtty is a TUI PostgreSQL client.

## Why build this?

I needed a better pgAdmin client, so I built it myself.

## Connections

In `~/.config/qtty/connections.json`, on Windows `%APPDATA%\qtty\connections.json` (or in `$QTTY_CONFIG_DIR`):

```json
{
  "connections": [
    { "id": "pagila", "name": "Pagila", "env": "local", "host": "127.0.0.1", "port": 54329, "database": "pagila", "user": "postgres" }
  ]
}
```

- `env` is `local`, `staging` or `prod` and sets the header colour.
- `sslmode` (`disable`, `require`, `verify-full`) is optional: `disable` on localhost, `require` otherwise.
- The password never goes in the file. qtty looks for it in the system keychain, then in the pgpass file, where PostgreSQL looks for it: `~/.pgpass`, on Windows `%APPDATA%\postgresql\pgpass.conf` (or `$PGPASSFILE`). If it isn't there, qtty asks for it and saves it in the keychain. URLs never save anything.
- Every session opens with `default_transaction_read_only`: reads (and any `:where`) never write. Only saving asks for a `READ WRITE` transaction.
- A `prod` connection opens locked: editing is off and saving doesn't ask for `READ WRITE`, so PostgreSQL would reject any write. `:unlock` asks you to type the database name and unlocks until the session closes.

## Keys

`?` shows them all.

| | |
|---|---|
| `h j k l`, `w b`, `0 $` | move between cells and columns |
| `gg G`, `^d ^u`, `^f ^b` | start and end of the table, half page, page |
| `Tab` | table list ↔ data (shows the list if hidden) |
| `␣ e` | hide or show the table list |
| `gt gT` | next or previous table |
| `␣ ␣` | find a table by name |
| `K` | row sheet: `j k` attributes, `h l` rows, `esc` closes |
| `y` | copy the cell (`pbcopy` on macOS, `clip.exe` on Windows) |
| `/text`, `n N` | search every column (on the server; case-sensitive only if you type capitals) |
| `:where <SQL condition>` | filter; bare `:where` removes it |
| `:sort <column> [desc]` | sort; bare `:sort` goes back to key order |
| `gd` | go to the row the foreign key points to |
| `gr` | rows in other tables that point to this one |
| `^o ^i` | back and forward through jumps (`gd`, `gr`, `␣ ␣`, searches, `gg G`) |
| `esc` | cancel the current read (PostgreSQL cancels the query) |
| `:e` | read the table again |
| `i` `⏎` / `c` | edit the cell / retype it; `esc` or `⏎` leaves it as a pending change |
| `o` | new row (pinned at the top of the grid) |
| `dd`, `V … d` | mark rows for deletion (`dd` again restores it) |
| `␣ n`, `␣ d` | NULL; DEFAULT in new rows |
| `u` | undo the last pending change |
| `:w` | review the changes and the SQL; `⏎` saves everything in one transaction |
| `:e!` | discard all changes |
| `:unlock` | edit on a prod connection |
| `:q`, `:q!` | quit (`:q` refuses with unsaved changes) |
| `^c` | quit (see below) |

While editing, PostgreSQL checks each value when you leave the cell and marks it red if it doesn't fit the type; `:w` won't save until it's fixed. On save, each UPDATE and DELETE checks the row is still as it was read. If someone changed it, nothing is saved: the row reloads with its current values, your changes stay on top marked in amber, and the next `:w` saves them over that.

Tables without a primary key (or a unique NOT NULL key), views and foreign tables are read-only: without a key the row can't be found again.

`^c`: with OpenTUI, if there are unsaved changes it doesn't quit and says so. With GPUIX in the terminal it always quits and pending changes are lost: GPUIX closes the app on `^c` before the app sees the key.

## For agents

qtty is a PostgreSQL client that runs entirely in the terminal, driven by Vim-style keys. It browses, searches and edits tables, and saves pending changes in one transaction after a review screen.

### Stack

| | |
|---|---|
| Runtime, package manager, bundler | Bun, pinned in `.bun-version` (1.4.2) |
| Language | TypeScript 7 (`tsc --noEmit`), ESM |
| Effects, services, config, schemas | `effect` 4.0.6 |
| PostgreSQL driver | `@effect/sql-pg` 4.0.6 (pure TypeScript protocol; interrupting a fiber cancels the query on the server) |
| UI state | `@effect/atom-react` atoms, React 19 |
| Renderer: GPUIX | `@gpuix/react` + `@gpuix/native` 0.11.0: GPU-drawn UI sent to the terminal through the Kitty graphics protocol |
| Renderer: OpenTUI | `@opentui/core` + `@opentui/react` 0.7.0: text cells, works in any terminal |
| Tests | `bun test` (integration and e2e), Stryker for mutation testing |
| Dev database | PostgreSQL 18 in Docker (`scripts/db-up.ts`; no Compose required) |

Dependency versions are exact on purpose; don't widen them.

Both renderers share everything except drawing. `src/main.ts` picks one:

- GPUIX on macOS when `TERM_PROGRAM=ghostty` or `TERM=xterm-kitty`, outside tmux.
- OpenTUI everywhere else (Terminal.app, tmux, Windows Terminal, Linux).
- `--renderer gpuix|opentui` forces one; `--window` opens GPUIX in a native window (used by the GPUIX e2e test).

### Install

Requirements: Bun at the version in `.bun-version`, and Docker for the dev database and tests.

```bash
bun install
bun run db:up            # PostgreSQL on 127.0.0.1:54329, password "qtty", databases pagila and catalogo
bun run start postgres://postgres:qtty@127.0.0.1:54329/pagila
bun run start            # pick a saved connection
```

`catalogo` is a synthetic database for testing at scale: 1,236 tables, 43,292 columns, tables up to 250 columns wide and three with a million rows.

To use qtty as a terminal command on the current machine:

```bash
bun run install:local    # builds, then installs: qtty, qtty <profile>, qtty postgres://…
```

- macOS and Linux: copies the binary to `~/.local/bin/qtty`. If that folder is not on `PATH`, it prints the line to add to the shell profile.
- Windows: copies it to `%LOCALAPPDATA%\Programs\qtty\qtty.exe` and adds that folder to the user's `PATH`. A new terminal is needed afterwards.
- Running it again installs the current build. To uninstall, delete the file.

### Commands

| Command | What it does |
|---|---|
| `bun run start [target]` | run from source |
| `bun run window` | run GPUIX in a native window |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test test/db.test.ts` | integration: catalog, paging, filter, sort, search, save, conflicts, read-only, cancellation |
| `bun test test/e2e.test.ts` | the real app: GPUIX through its automation, OpenTUI in its test renderer |
| `bun run test:mutation` | Stryker over row reading, the catalog and saving |
| `bun run build` | `dist/qtty` on macOS (both renderers, ~98 MB) or `dist/qtty.exe` on Windows (OpenTUI only) |
| `bun run build:windows` | cross-compile `dist/qtty.exe` for Windows x64 from macOS |
| `bun run install:local` | build and install as a terminal command |
| `bun run db:up` / `db:down` | start or stop the dev database |

Tests need `bun run db:up`. The binaries bundle Bun, so running them doesn't need Bun installed. `qtty --version` prints the version and the renderers the build loads, e.g. `qtty 0.1.0 (gpuix, opentui)`. `src/bin.ts` embeds GPUIX's native addon, because `bun build --compile` doesn't pick it up from npm. `build:windows` first installs OpenTUI's Windows library, an optional dependency Bun only installs on Windows.

`db:up` creates or starts the `qtty-postgres-1` container and waits until PostgreSQL is ready. Data stays in the `qtty_pgdata` Docker volume. `db:down` stops the container and keeps its data. Local Compose files are ignored and are not required by the project or CI.

### Testing without touching the user's setup

- Only connect to the Docker database. Never to real databases.
- Point config and passwords at temporary files: `QTTY_CONFIG_DIR=/tmp/… PGPASSFILE=/tmp/…`. Don't write to the user's keychain or `~/.config/qtty`.
- Don't commit `dist/` or any binary.

### Layout

```
src/
  main.ts           arguments, renderer choice, startup
  bin.ts            entry point of the macOS binary (compiled by scripts/build.ts)
  App.ts            screens, connection and commands (one atom holds the state)
  config/           profiles (connections.json, postgres:// URLs), keychain and pgpass
  db/               session, catalog, paged reading (keyset, filter, sort, search) and saving
  domain/           pending changes (ChangeSet)
  state/            workspace state, rows in memory, table finder
  keys/vim.ts       keys → new state + commands (pure)
  ui/present.ts     everything that isn't drawing: colours, labels, hints, help, review
  ui/gpuix/         React views for GPUIX (pixels)
  ui/opentui/       React views for OpenTUI (text cells)
scripts/            build, install and dev-database scripts
test/               db.test.ts (integration), e2e.test.ts (both renderers)
docker/initdb/      SQL that seeds pagila and catalogo
```

### Safety model

- Every session opens with `default_transaction_read_only`. Only saving asks for a `READ WRITE` transaction.
- A connection with `env: "prod"` opens locked; `:unlock` asks for the database name. A `postgres://` URL counts as prod unless the host is localhost.
- Saving runs DELETE, UPDATE and INSERT in one transaction. Each UPDATE and DELETE checks the row still holds the values that were read; if not, everything rolls back and the row is marked as a conflict.
- Tables without a primary key (or a unique NOT NULL key), views and foreign tables are read-only.

### CI and releases

GitHub Actions, in `.github/workflows/`:

| Workflow | When | What |
|---|---|---|
| `ci` | push to `main`, pull requests | types, integration and OpenTUI e2e on Linux against Docker PostgreSQL; GPUIX e2e on macOS (allowed to fail: runners have no real GPU); builds and checks both binaries |
| `release` | push of a `v*` tag | builds the binaries (signed if secrets exist) and publishes a GitHub Release with `qtty-macos-arm64` and `qtty-windows-x64.exe` |
| `mutation` | Mondays and on demand | Stryker; the HTML report is an artifact |
| `build` | called by `ci` and `release` | builds on macOS and Windows and checks `--version` |

To release: bump `version` in `package.json`, commit, then `git tag v0.2.0 && git push --tags`. The tag must match `package.json`.

Signing turns on only when these repository secrets exist:

- macOS (Developer ID and notarization): `MACOS_CERTIFICATE` (base64 .p12), `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`, `APPLE_API_KEY` (base64 .p8), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Hardened-runtime entitlements are in `scripts/entitlements.plist`.
- Windows: `WINDOWS_CERTIFICATE` (base64 .pfx) and `WINDOWS_CERTIFICATE_PASSWORD`.

Without them the binaries are unsigned: on macOS remove the warning with `xattr -d com.apple.quarantine qtty`; on Windows SmartScreen asks for confirmation.
