// Connection profiles: `connections.json` in the config folder (`%APPDATA%\qtty` on
// Windows, `~/.config/qtty` elsewhere), or a `postgres://` URL given on the command
// line. Profiles never hold passwords (see Credentials).
//
//   { "connections": [
//       { "id": "pagila", "name": "Pagila", "env": "local", "host": "localhost",
//         "port": 5432, "database": "pagila", "user": "postgres" } ] }

import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

/** Drives the colour of the header and, from the editing step on, what is writable. */
export const Env = Schema.Literals(["local", "staging", "prod"])
export type Env = typeof Env.Type

export const SslMode = Schema.Literals(["disable", "require", "verify-full"])
export type SslMode = typeof SslMode.Type

export const Profile = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  env: Env,
  host: Schema.NonEmptyString,
  port: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5432))),
  database: Schema.NonEmptyString,
  user: Schema.NonEmptyString,
  /** Defaults to `disable` for localhost and `require` elsewhere. */
  sslmode: Schema.optionalKey(SslMode),
})
export interface Profile extends Schema.Schema.Type<typeof Profile> {}

const ConnectionsFile = Schema.Struct({ connections: Schema.Array(Profile) })

/** What the user picked: a profile, plus the password if it came inside a URL. */
export interface Target {
  readonly profile: Profile
  readonly password: Option.Option<Redacted.Redacted>
  /** URL targets are not saved anywhere, so their password is never stored. */
  readonly fromUrl: boolean
}

export class ProfilesError extends Schema.TaggedError<ProfilesError>()("Profiles.ProfilesError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("/")

export const sslModeOf = (profile: Profile): SslMode => profile.sslmode ?? (isLocalHost(profile.host) ? "disable" : "require")

/**
 * Parses `postgres://user:pass@host:port/db?sslmode=…`. A URL has no environment
 * label, so anything that is not localhost is treated as production.
 */
export const fromUrl = (input: string): Option.Option<Target> => {
  if (!/^postgres(ql)?:\/\//.test(input) || !URL.canParse(input)) return Option.none()
  const url = new URL(input)
  const host = decodeURIComponent(url.hostname).replace(/^\[(.*)\]$/, "$1")
  const database = decodeURIComponent(url.pathname.slice(1)) || "postgres"
  const sslmode = Schema.decodeUnknownOption(SslMode)(url.searchParams.get("sslmode"))
  const profile: Profile = {
    id: `url:${host}:${url.port || 5432}/${database}`,
    name: `${host}/${database}`,
    env: isLocalHost(host) ? "local" : "prod",
    host: host || "localhost",
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username) || "postgres",
    ...(Option.isSome(sslmode) ? { sslmode: sslmode.value } : {}),
  }
  const password = url.password ? Option.some(Redacted.make(decodeURIComponent(url.password))) : Option.none()
  return Option.some({ profile, password, fromUrl: true })
}

export interface Interface {
  /** The config file, to tell the user where profiles go. */
  readonly file: string
  /** Profiles from the config file; an absent file is an empty list. */
  readonly list: () => Effect.Effect<ReadonlyArray<Profile>, ProfilesError>
}

export class Service extends Context.Service<Service, Interface>()("@qtty/Profiles") {}

/** Where Windows keeps each user's settings (%APPDATA%); libpq's pgpass.conf lives there too. */
export const appData = Config.String("APPDATA").pipe(Config.withDefault(join(homedir(), "AppData", "Roaming")))

// QTTY_CONFIG_DIR, else the platform's place for settings.
const configDir = Config.String("QTTY_CONFIG_DIR").pipe(
  Config.orElse(() =>
    process.platform === "win32"
      ? appData.pipe(Config.map((dir) => join(dir, "qtty")))
      : Config.String("XDG_CONFIG_HOME").pipe(
          Config.map((dir) => join(dir, "qtty")),
          Config.withDefault(join(homedir(), ".config", "qtty")),
        ),
  ),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const path = join(yield* configDir, "connections.json")

    const list = Effect.fn("Profiles.list")(function* () {
      const file = Bun.file(path)
      if (!(yield* Effect.promise(() => file.exists()))) return []
      const text = yield* Effect.tryPromise({
        try: () => file.text(),
        catch: (cause) => new ProfilesError({ path, message: String(cause) }),
      })
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionsFile))(text).pipe(
        Effect.mapError((error) => new ProfilesError({ path, message: error.message })),
      )
      return decoded.connections
    })

    return Service.of({ file: path, list })
  }),
)
