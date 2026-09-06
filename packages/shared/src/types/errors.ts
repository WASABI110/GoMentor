import { z } from 'zod'

/**
 * Typed errors with a discriminating code.
 *
 * A thrown string cannot be branched on by the caller, translated for the
 * user, or asserted on in a test. Every error crossing a boundary carries a
 * `code`. See `.trellis/spec/backend/error-handling.md`.
 */

export const errorCodeSchema = z.enum([
  // SGF parsing. Distinct codes deliberately — the user-facing message
  // differs for each, and tests assert on the specific code.
  'SGF_TRUNCATED',
  'SGF_EMPTY',
  'SGF_NOT_SGF',
  'SGF_INVALID_PROPERTY',
  'SGF_UNSUPPORTED_BOARD_SIZE',
  // Distinct from SGF_INVALID_PROPERTY: the file's syntax is fine, it is the
  // nesting that exceeds what a recursive-descent parser can handle. Without
  // its own code the parser would have to either mislabel it or let a bare
  // RangeError escape, which carries no code at all.
  'SGF_TOO_DEEP',
  // Re-encoding to the file's original codepage is not possible (TextEncoder
  // only emits UTF-8). Distinct because it is a *write*-side limitation of ours,
  // not a defect in the user's file — the message and the offered remedy differ.
  'SGF_UNSUPPORTED_ENCODING',

  // Board geometry. Distinct from `SGF_INVALID_PROPERTY` because the two have
  // different causes and different remedies: an SGF property code says the
  // user's *file* is malformed, while this says a coordinate was out of range
  // for the board — reached from GTP encoding, canvas geometry, and flat-index
  // conversion, none of which involve a file. Since the renderer translates
  // `code` via the `errors` i18n namespace, reusing the SGF code would show
  // "this file is malformed" for a bug that has nothing to do with a file.
  // `sgf/props.ts` converts this to `SGF_INVALID_PROPERTY` when the coordinate
  // did come from a file, so that path is unaffected.
  'BOARD_INVALID_COORD',

  // KataGo lifecycle.
  'ENGINE_NOT_FOUND',
  // What the service actually reports when the binary or weights are absent
  // from a packaged install (`main/katago/service.ts`); distinct from
  // `ENGINE_NOT_FOUND`, which is the "no engine configured anywhere" state.
  'ENGINE_BINARY_MISSING',
  'ENGINE_START_TIMEOUT',
  'ENGINE_CRASHED',
  'ENGINE_CIRCUIT_OPEN',
  'ENGINE_QUERY_FAILED',
  'ENGINE_UNAVAILABLE',

  // LLM provider.
  'LLM_NO_KEY',
  'LLM_UNAUTHORIZED',
  'LLM_RATE_LIMITED',
  'LLM_TIMEOUT',
  'LLM_ABORTED',
  'LLM_NO_TOOL_SUPPORT',
  'LLM_BAD_RESPONSE',
  'LLM_UNREACHABLE',

  // IPC contract.
  'IPC_INVALID_REQUEST',
  'IPC_INVALID_RESPONSE',
  'IPC_HANDLER_FAILED',

  // Settings and secrets.
  'SETTINGS_INVALID',
  'SETTINGS_ENCRYPTION_UNAVAILABLE',
  'SETTINGS_WRITE_FAILED',

  // Library and filesystem.
  'LIBRARY_FILE_UNREADABLE',
  'LIBRARY_DUPLICATE',
  'LIBRARY_NOT_FOUND',

  // External integrations — inherently fragile, isolated by design.
  'SOURCE_UNREACHABLE',
  'SOURCE_AUTH_EXPIRED',
  'SOURCE_SCHEMA_CHANGED',
])
export type ErrorCode = z.infer<typeof errorCodeSchema>

/**
 * The wire form of an error. Note what is absent: no `cause`, no stack.
 * Stacks can carry filesystem paths and argument values, so they stay in the
 * main process and only the code crosses to the renderer, which translates it
 * via the `errors` i18n namespace.
 */
export const errorEnvelopeSchema = z.object({
  code: errorCodeSchema,
  /** Developer-facing. The renderer must not use this as primary UI text. */
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

/** Every IPC handler returns this shape; `register.ts` maps throws into it. */
export const ipcResultSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: errorEnvelopeSchema }),
  ])

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorEnvelope }

/** Carries a code so callers can branch and the UI can translate. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly context?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; context?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    if (options?.context !== undefined) this.context = options.context
  }

  /** Strips `cause` and stack — only this crosses the IPC boundary. */
  toEnvelope(): ErrorEnvelope {
    return this.context === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, context: this.context }
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
