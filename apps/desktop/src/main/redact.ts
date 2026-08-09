/**
 * Secret redaction for log payloads.
 *
 * Deliberately a separate module from `logger.ts`, with **no `electron` or
 * `electron-log` import**. That is not tidiness — it is what makes A10
 * verifiable. `quality-guidelines.md` requires redaction to be "tested with a
 * key-shaped value, not assumed from the code"; if this lived inside the
 * `electron-log` wrapper, a unit test would have to mock the transport and
 * would then be asserting on the mock's arguments rather than on what reaches a
 * file. Pure in, pure out, tested directly.
 *
 * ## What this is and is not
 *
 * This is a **backstop** (`logging-guidelines.md`). The rule is not to pass
 * secrets, SGF content, or chat text to a log call at all. This exists because
 * "the rule was followed everywhere" is not a property anyone can verify by
 * review, and one leak into a file a user attaches to a bug report is a real
 * harm.
 *
 * Two consequences shape the code below:
 *
 * - **Over-redaction is cheap, under-redaction is not.** Where the two trade
 *   off, this errs toward redacting.
 * - **No redacted-looking prefixes.** `logging-guidelines.md` bans logging even
 *   a truncated key, so the replacement is a constant carrying no bytes of the
 *   original. A `sk-abc…` style preview is exactly what that rule forbids.
 */

/** Replacement for anything secret. Carries no bytes of the original. */
const REDACTED = '[redacted]'

/**
 * Field names whose *value* is secret regardless of shape. Matched as a
 * case-insensitive substring, so `llmApiKey`, `apiKey`, and `api_key` all hit
 * `apikey` — matching on equality would make this list a game of guessing
 * every casing a call site might use.
 */
const SECRET_FIELDS = [
  'apikey',
  'api_key',
  'secret',
  'token',
  'password',
  'passwd',
  'authorization',
  'auth',
  'credential',
  'privatekey',
  'sessionid',
  'cookie',
]

/**
 * Field names whose value is the user's private material rather than a
 * credential: game records and anything the model read or wrote. Separated
 * from `SECRET_FIELDS` because the reason differs — these are not credentials,
 * they are the study material and conversations the app exists to keep private
 * (`logging-guidelines.md`: "A user's private study material").
 */
const CONTENT_FIELDS = [
  'sgf',
  'sgfcontent',
  'content',
  'prompt',
  'completion',
  'message',
  'messages',
  'chunk',
  'delta',
  'comment',
  'text',
]

/**
 * Fields holding a URL, reduced to origin. `logging-guidelines.md`: "Log the
 * host, never userinfo or query params" — a `baseUrl` is a common place for a
 * key to arrive as `?api_key=` or as `https://user:pass@host`.
 */
const URL_FIELDS = ['baseurl', 'url', 'endpoint', 'uri', 'href']

/**
 * Fields exempted from `CONTENT_FIELDS` because their value is structural, not
 * content, and redacting them would make the log useless for the thing it is
 * most often read for.
 *
 * `code` is the whole point of an error entry (`error-handling.md`), and `msg`
 * is required to be a stable non-interpolated string
 * (`logging-guidelines.md` §Structured Logging) — so neither can carry user
 * content unless a call site already violated a different rule. Note this list
 * is checked *before* the content list, so a field named exactly `msg` is kept
 * even though `message` is redacted; that asymmetry is intentional and is why
 * the structured format names the field `msg`.
 */
const STRUCTURAL_FIELDS = ['code', 'msg', 'level', 'ts', 'scope', 'name', 'stack']

/**
 * Value shapes that are secret wherever they appear, including inside a string
 * that is mostly prose. This catches the case field names cannot: a key pasted
 * into an error message, or arriving under a field nobody thought to list.
 *
 * Each pattern is anchored on a vendor prefix rather than on entropy. A generic
 * "long random-looking string" rule would also match zobrist hashes, request
 * ids, and SHA digests — all things worth having in a log — so it would trade a
 * real diagnostic loss for a speculative gain.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI and compatible
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, // Authorization header value
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
]

/**
 * Strings longer than this are replaced by their length. An SGF file or a model
 * completion arriving under an unlisted field name is the case this covers —
 * the length is the only part that is diagnostically useful anyway, and it is
 * the same reasoning as `sgf/diagnostic.ts`.
 */
const MAX_STRING = 200

/**
 * Recursion bound. A cyclic object is handled by `seen`, but a legitimately
 * deep one still needs a stop: log serialisation must not be able to blow the
 * stack, because the crash would happen while trying to report a problem.
 */
const MAX_DEPTH = 8

function matches(field: string, list: readonly string[]): boolean {
  const lower = field.toLowerCase()
  return list.some((entry) => lower.includes(entry))
}

/** Applies the value-shape patterns to free text. */
function scrubText(value: string): string {
  let out = value
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // `lastIndex` is per-regex state and these literals are module-level, so a
    // `/g` regex reused across calls would resume mid-string and miss matches.
    // `replace` with `/g` resets it, but being explicit costs nothing and the
    // failure mode — intermittent non-redaction depending on call order — is
    // the worst kind to debug.
    pattern.lastIndex = 0
    out = out.replace(pattern, REDACTED)
  }
  return out
}

function redactString(value: string): string {
  const scrubbed = scrubText(value)
  return scrubbed.length > MAX_STRING
    ? `<${String(scrubbed.length)} characters>`
    : scrubbed
}

/**
 * Reduces a URL to scheme, host, and port. Anything that fails to parse is
 * treated as a plain string rather than passed through: an unparseable value in
 * a URL field is exactly where a malformed credential would hide.
 */
function redactUrl(value: unknown): unknown {
  if (typeof value !== 'string') return redactValue(value, MAX_DEPTH)
  try {
    const url = new URL(value)
    // Rebuilt from parts rather than mutated: assigning `url.search = ''` and
    // `url.username = ''` leaves the rest intact but reads as if it might not,
    // and `origin` is `"null"` for opaque origins like `file:`.
    return `${url.protocol}//${url.host}`
  } catch {
    return redactString(value)
  }
}

/**
 * An `Error` has no enumerable own properties, so `JSON.stringify` renders it
 * as `{}` and a naive walk drops the only useful part. Converted explicitly.
 *
 * `cause` is followed here on purpose: this runs in the **main process**, where
 * `logging-guidelines.md` line 54 requires errors to be logged with their
 * cause. What must never carry a cause is the envelope crossing to the
 * renderer, and that is `AppError.toEnvelope()`'s job, not this function's.
 */
function redactError(error: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    // The message is scrubbed but kept: it is the diagnostic. Bounding raw
    // input belongs at the point the message is built — see
    // `logging-guidelines.md` "Error messages are log payloads" — and this is
    // the backstop for messages that skipped it.
    message: redactString(error.message),
  }
  if (typeof error.stack === 'string') out['stack'] = redactString(error.stack)
  // `code` and `context` come from AppError. Read structurally rather than
  // importing AppError, so a plain error carrying a `code` is handled too.
  const withCode: unknown = (error as unknown as Record<string, unknown>)['code']
  if (withCode !== undefined) out['code'] = withCode
  const context: unknown = (error as unknown as Record<string, unknown>)['context']
  if (context !== undefined) out['context'] = redactValue(context, depth - 1)
  if (error.cause !== undefined) out['cause'] = redactValue(error.cause, depth - 1)
  return out
}

function redactValue(value: unknown, depth: number, seen?: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[function]'

  if (depth <= 0) return '[depth limit]'

  const tracked = seen ?? new WeakSet<object>()
  if (typeof value === 'object') {
    if (tracked.has(value)) return '[circular]'
    tracked.add(value)
  }

  if (value instanceof Error) return redactError(value, depth)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof URL) return redactUrl(value.href)
  if (value instanceof Map)
    return { '[Map]': redactValue([...value.entries()], depth - 1, tracked) }
  if (value instanceof Set)
    return { '[Set]': redactValue([...value.values()], depth - 1, tracked) }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth - 1, tracked))
  }

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (matches(key, STRUCTURAL_FIELDS)) {
      // Still walked rather than passed through: `stack` is structural but is
      // also free text, and `context` arrives under an unlisted name.
      out[key] = redactValue(entry, depth - 1, tracked)
      continue
    }
    if (matches(key, SECRET_FIELDS) || matches(key, CONTENT_FIELDS)) {
      // Redacted by *name*, whatever the type. A secret under a boolean-looking
      // field is still not something to print, and preserving the type here
      // would leak the value's shape.
      out[key] = REDACTED
      continue
    }
    if (matches(key, URL_FIELDS)) {
      out[key] = redactUrl(entry)
      continue
    }
    out[key] = redactValue(entry, depth - 1, tracked)
  }
  return out
}

/**
 * Redacts an arbitrary log payload. Safe on cycles, deep objects, `Error`s, and
 * values that are not JSON at all.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, MAX_DEPTH)
}

/** Exposed for tests and for the "did we bound this?" review question. */
export const REDACTION_PLACEHOLDER = REDACTED
