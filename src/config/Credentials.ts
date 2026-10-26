// Where passwords come from, in order: the OS keychain (Bun.secrets), then the pgpass
// file where libpq looks for it (~/.pgpass; %APPDATA%\postgresql\pgpass.conf on Windows).
// A password typed by the user is remembered in the keychain for that profile.

import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { appData, type Profile } from "./Profiles.ts"

const SERVICE = "qtty"

export class CredentialsError extends Schema.TaggedError<CredentialsError>()("Credentials.CredentialsError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly lookup: (profile: Profile) => Effect.Effect<Option.Option<Redacted.Redacted>>
  readonly remember: (profile: Profile, password: Redacted.Redacted) => Effect.Effect<void, CredentialsError>
}

export class Service extends Context.Service<Service, Interface>()("@qtty/Credentials") {}

/** First matching line of a pgpass file. Fields may be `*`; `\:` and `\\` are escapes. */
export const matchPgPass = (content: string, profile: Profile): Option.Option<string> => {
  const wanted = [profile.host, String(profile.port), profile.database, profile.user]
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue
    const fields: string[] = []
    let current = ""
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === "\\" && i + 1 < line.length) current += line[++i]
      else if (ch === ":" && fields.length < 4) {
        fields.push(current)
        current = ""
      } else current += ch
    }
    if (fields.length < 4) continue
    const matches = wanted.every((value, i) => fields[i] === "*" || fields[i] === value || (i === 0 && fields[i] === "localhost" && value.startsWith("/")))
    if (matches) return Option.some(current)
  }
  return Option.none()
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pgpassDefault = process.platform === "win32" ? join(yield* appData, "postgresql", "pgpass.conf") : join(homedir(), ".pgpass")
    const pgpassPath = yield* Config.String("PGPASSFILE").pipe(Config.withDefault(pgpassDefault))

    const fromKeychain = (profile: Profile) =>
      Effect.tryPromise(() => Bun.secrets.get({ service: SERVICE, name: profile.id })).pipe(
        Effect.map((value) => Option.fromNullishOr(value).pipe(Option.map(Redacted.make))),
        // An unavailable keychain is the same as an empty one: the user is asked instead.
        Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
      )

    const fromPgPass = (profile: Profile) =>
      Effect.tryPromise(() => Bun.file(pgpassPath).text()).pipe(
        Effect.map((content) => matchPgPass(content, profile).pipe(Option.map(Redacted.make))),
        Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
      )

    const lookup = Effect.fn("Credentials.lookup")(function* (profile: Profile) {
      const stored = yield* fromKeychain(profile)
      return Option.isSome(stored) ? stored : yield* fromPgPass(profile)
    })

    const remember = Effect.fn("Credentials.remember")(function* (profile: Profile, password: Redacted.Redacted) {
      yield* Effect.tryPromise({
        try: () => Bun.secrets.set({ service: SERVICE, name: profile.id, value: Redacted.value(password) }),
        catch: (cause) => new CredentialsError({ message: `No se pudo guardar en el llavero: ${String(cause)}` }),
      })
    })

  return Service.of({ lookup, remember })
  }),
)
