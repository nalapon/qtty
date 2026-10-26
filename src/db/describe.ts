import { SqlError } from "effect/sql"

/** The server's own words for a failure, falling back to the error's message. */
export function describe(error: unknown): string {
  const reason = SqlError.isSqlError(error) ? error.reason : error
  const cause = typeof reason === "object" && reason !== null && "cause" in reason ? reason.cause : undefined
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  if (cause instanceof Error) return cause.message
  return reason instanceof Error ? reason.message : String(reason)
}
