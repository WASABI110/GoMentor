import log from 'electron-log/main'
import { isAppError } from '@gomentor/shared'
import { logFile } from './paths'
import { redact } from './redact'

/**
 * The logging wrapper. **Never import `electron-log` anywhere else**
 * (`logging-guidelines.md`) — this module is what enforces the structured
 * `{ level, ts, scope, msg, ...fields }` shape and runs the redaction backstop.
 *
 * ## Why a wrapper rather than configuring electron-log and using it directly
 *
 * Two things have to be true at every call site, and neither can be achieved by
 * configuration alone:
 *
 * 1. **`msg` is stable and non-interpolated**, with variables in `fields`. A
 *    `log.info(\`started in ${ms}ms\`)` is ungreppable. The signature here takes
 *    `msg` and `fields` as separate parameters so the interpolated form does not
 *    typecheck.
 * 2. **Payloads pass through `redact`.** electron-log's own `hooks` could do
 *    this, but then the redaction would be invisible at the call site and the
 *    only way to know it ran would be to read the transport config.
 */

/**
 * Subsystem tag, matching the module path (`logging-guidelines.md`). A string
 * union rather than a bare `string`: the value of `scope` is that
 * grep-by-subsystem works, which a typo silently defeats. New subsystems are
 * added here deliberately.
 */
export type Scope =
  | 'main:app'
  | 'main:window'
  | 'main:menu'
  | 'main:ipc'
  | 'main:settings'
  | 'main:secrets'
  | 'main:library'
  | 'main:sgf'
  | 'main:llm:service'
  | 'main:katago:process'
  | 'main:katago:service'
  | 'main:katago:session'
  | 'main:telemetry'
  | 'renderer'

export type LogFields = Record<string, unknown>

export interface Logger {
  /** Diagnostic detail. Off by default in production. */
  debug(msg: string, fields?: LogFields): void
  /** Significant lifecycle events. */
  info(msg: string, fields?: LogFields): void
  /** Expected but notable degradation. */
  warn(msg: string, fields?: LogFields): void
  /** Unexpected and actionable. */
  error(msg: string, fields?: LogFields): void
  /**
   * Logs an error with its `code` and `context`, and — main process only —
   * its `cause` (`logging-guidelines.md` line 54).
   *
   * Takes `unknown` because that is what a `catch` binding is. Narrowing at
   * every call site would mean a dozen copies of the same `isAppError` check,
   * and the one that got it wrong would log `{}`.
   */
  failure(msg: string, error: unknown, fields?: LogFields): void
}

let initialised = false

/**
 * Configures transports. Idempotent, and must run before the first log call —
 * `main/index.ts` calls it first, ahead of even the single-instance check, so
 * that a rejected second instance is still recorded.
 */
export function initLogging(options: { debugEnabled: boolean }): void {
  if (initialised) {
    setDebugEnabled(options.debugEnabled)
    return
  }
  initialised = true

  log.transports.file.resolvePathFn = () => logFile()
  // 5 MB then rotate. Large enough that a debug-level session survives, small
  // enough to attach to a bug report.
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.format = '{text}'
  log.transports.console.format = '{text}'

  setDebugEnabled(options.debugEnabled)

  // Renderer logs forward to main over IPC so there is one stream, not two
  // (`logging-guidelines.md`). This registers the receiving end; the renderer
  // side is electron-log's own preload-free path.
  log.initialize()

  // An unhandled rejection that only prints to stderr is invisible in a
  // packaged build, where there is no attached console.
  process.on('unhandledRejection', (reason: unknown) => {
    scoped('main:app').failure('unhandled rejection', reason)
  })
  process.on('uncaughtException', (error: unknown) => {
    scoped('main:app').failure('uncaught exception', error)
  })
}

/**
 * `debug` is off by default in production and toggleable in settings, so a user
 * can produce a useful log without a rebuild (`logging-guidelines.md`).
 */
export function setDebugEnabled(enabled: boolean): void {
  const level = enabled ? 'debug' : 'info'
  log.transports.file.level = level
  log.transports.console.level = level
}

/**
 * Serialises one entry. JSON on a single line: a log that has to be grepped
 * *and* parsed is worth more than a pretty one, and rotation means entries get
 * split across files where a multi-line format would break tooling.
 */
function emit(
  level: 'debug' | 'info' | 'warn' | 'error',
  scope: Scope,
  msg: string,
  fields?: LogFields,
): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
  }
  if (fields !== undefined) {
    const safe = redact(fields)
    // Flattened into the entry rather than nested under `fields`, so a grep for
    // `"backend":"cuda"` works. Guarded because `redact` returns `unknown`.
    if (safe !== null && typeof safe === 'object' && !Array.isArray(safe)) {
      Object.assign(entry, safe)
    } else {
      entry['fields'] = safe
    }
  }
  log[level](JSON.stringify(entry))
}

/**
 * Returns a logger bound to one subsystem. Module-level usage:
 * `const logger = scoped('main:settings')`.
 */
export function scoped(scope: Scope): Logger {
  return {
    debug: (msg, fields) => {
      emit('debug', scope, msg, fields)
    },
    info: (msg, fields) => {
      emit('info', scope, msg, fields)
    },
    warn: (msg, fields) => {
      emit('warn', scope, msg, fields)
    },
    error: (msg, fields) => {
      emit('error', scope, msg, fields)
    },
    failure: (msg, error, fields) => {
      // `redact` handles Error instances — including following `cause`, which
      // is correct here and only here. The envelope crossing to the renderer
      // strips it separately, in `AppError.toEnvelope()`.
      const payload: LogFields = { ...fields, err: error }
      if (isAppError(error)) payload['code'] = error.code
      emit('error', scope, msg, payload)
    },
  }
}
