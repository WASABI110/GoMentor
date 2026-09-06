import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { splitJsonLines } from '@gomentor/core/katago/analysis'
import { createLineBuffer } from './ring-buffer'
import type { Logger } from '../logger'

/**
 * Owns one spawned engine child: stdio plumbing, output framing, stderr
 * capture, and shutdown. Deliberately dumb about *meaning* — it frames bytes
 * and reports exits; the service decides what a line or an exit means
 * (`session.ts` in Stage 3 will own query correlation).
 *
 * ## Why a real child, and why these seams
 *
 * What breaks in engine integration is pipes, framing, and exit handling —
 * none of which a mock object touches (`fake-katago.ts` documents this at
 * length). So this module always spawns a real process. The two seams exist
 * for specific, honest reasons:
 *
 * - `spawn` — tests point the env-override binary (a TypeScript file) at the
 *   fake child, which needs the tsx loader to run; the seam wraps the *real*
 *   spawn, so pipes, framing, and exit behaviour under test are the production
 *   ones. The fake-katago lesson is written down where it was learned: never
 *   reimplement the subject to make it testable.
 * - `now` — the stderr log throttle is clock-driven; an injected clock keeps
 *   the throttle test deterministic instead of timing-flaky.
 *
 * ## The stderr contract
 *
 * Engine stderr lands in a bounded ring buffer (every line — the crash tail is
 * the point) and reaches the log at `debug` throttled (a chatty engine must
 * not flood the file). On an **unexpected** exit the whole tail is dumped at
 * `warn`: a `failed` status should carry the engine's own last words
 * (`design.md` §Operational). On a expected shutdown the tail stays at debug —
 * a clean quit is not a story.
 *
 * ## Never outliving the app
 *
 * Shutdown is terminate → grace → `SIGKILL`, and `process.on('exit')` kills a
 * still-running child synchronously as the last possible act — a pending grace
 * timer cannot save an orphaned child, because timers do not run once the
 * event loop is draining.
 */

/** What `spawn` looks like here; the default binding is `node:child_process`. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

export interface ExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /**
   * True when the exit came from our own `stop()`. An engine that exits
   * uninvited — at any phase — is a crash, even with code 0: the analysis
   * engine is not supposed to exit until its stdin closes.
   */
  readonly expected: boolean
}

export interface EngineProcessOptions {
  readonly binary: string
  readonly args: readonly string[]
  readonly spawn?: SpawnFn
  /**
   * Extra child environment, merged over `process.env`. Only set by the
   * service for the script-override launch (`planEngineLaunch`); the bundled
   * native binary inherits unchanged.
   */
  readonly env?: Readonly<Record<string, string>>
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error' | 'failure'>
  /** Called for each complete stdout line, framed by the production splitter. */
  readonly onLine: (line: string) => void
  /** Called exactly once, after stdout/stderr buffers are flushed. */
  readonly onExit: (info: ExitInfo) => void
  /** Ring buffer capacity for stderr lines. Default 200. */
  readonly stderrCapacity?: number
  /** Minimum interval between stderr debug log lines. Default 1000ms. */
  readonly stderrLogThrottleMs?: number
  /** How long an orderly stdin-close shutdown gets before SIGKILL. Default 1500ms. */
  readonly shutdownGraceMs?: number
  /** Clock for the throttle. Injectable in tests. Default `Date.now`. */
  readonly now?: () => number
}

export interface EngineProcess {
  readonly pid: number | undefined
  /** Writes one request line (the trailing newline is added here). */
  send(line: string): void
  /** Every stderr line retained so far, oldest first. */
  stderrTail(): readonly string[]
  /** Orderly shutdown: close stdin, wait, SIGKILL, await the exit. */
  stop(): Promise<void>
}

const DEFAULT_STDERR_CAPACITY = 200
const DEFAULT_STDERR_THROTTLE_MS = 1_000
const DEFAULT_SHUTDOWN_GRACE_MS = 1_500

export function createEngineProcess(options: EngineProcessOptions): EngineProcess {
  const spawnFn = options.spawn ?? nodeSpawn
  const capacity = options.stderrCapacity ?? DEFAULT_STDERR_CAPACITY
  const throttleMs = options.stderrLogThrottleMs ?? DEFAULT_STDERR_THROTTLE_MS
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
  const now = options.now ?? Date.now
  const logger = options.logger

  const stderr = createLineBuffer(capacity)
  let stdoutRemainder = ''
  let stderrRemainder = ''
  let stopping = false
  let settled = false
  let stopTimer: ReturnType<typeof setTimeout> | null = null

  const child = spawnFn(options.binary, options.args, {
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  })

  function flushRemainders(): void {
    // A dying engine's last line may lack its trailing newline. Deliver what
    // was buffered so the crash tail is whole, then report the exit.
    const out = splitJsonLines(stdoutRemainder)
    for (const line of out.lines) options.onLine(line)
    stdoutRemainder = out.remainder
    if (stdoutRemainder.trim() !== '') {
      options.onLine(stdoutRemainder)
      stdoutRemainder = ''
    }
    if (stderrRemainder.trim() !== '') {
      stderr.push(stderrRemainder)
      stderrRemainder = ''
    }
  }

  function settle(info: ExitInfo): void {
    if (settled) return
    settled = true
    if (stopTimer !== null) clearTimeout(stopTimer)
    // The child is reaped; the last-resort kill has nothing left to guard.
    // Without this, every spawn leaks a permanent listener on the app process
    // (>10 spawns trips MaxListenersExceededWarning; Stage 5 restarts make it
    // unbounded).
    process.removeListener('exit', onProcessExit)
    flushRemainders()
    if (!info.expected) {
      // The crash tail is the diagnosis (`design.md` §Operational): the
      // engine's own last words, at warn, once — not buried in the throttled
      // debug stream. On a clean shutdown the tail stays at debug; a quiet
      // quit is not a story.
      logger.warn('engine stderr tail', { lines: stderr.lines() })
    }
    try {
      options.onExit(info)
    } catch (error) {
      // The service's exit handler must not throw into the close callback;
      // log it here or the failure vanishes into an Electron internals stack.
      logger.failure('exit handler threw', error)
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const { lines, remainder } = splitJsonLines(stdoutRemainder + chunk)
    stdoutRemainder = remainder
    for (const line of lines) options.onLine(line)
  })

  // Writes can race the child's death (probe deadline → stop → late send);
  // an EPIPE here is the expected consequence, not a bug worth an error line.
  child.stdin.on('error', (error: Error) => {
    logger.debug('engine stdin write failed', { cause: error.message })
  })

  // The throttle state: when the last stderr line reached the log, and how
  // many were withheld since. A summary line at debug keeps the suppression
  // itself visible — "dropped on the floor" and "buffered, see tail" must be
  // distinguishable in a log file.
  let lastStderrLog = Number.NEGATIVE_INFINITY
  let suppressed = 0

  function logStderrLine(line: string): void {
    const at = now()
    if (at - lastStderrLog >= throttleMs) {
      if (suppressed > 0) {
        logger.debug('engine stderr (suppressed)', { count: suppressed })
        suppressed = 0
      }
      logger.debug('engine stderr', { line })
      lastStderrLog = at
    } else {
      suppressed += 1
    }
  }

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    const normalised = (stderrRemainder + chunk).replace(/\r\n/g, '\n')
    const parts = normalised.split('\n')
    stderrRemainder = parts.pop() ?? ''
    for (const line of parts) {
      if (line.trim() === '') continue
      stderr.push(line)
      logStderrLine(line)
    }
  })

  child.on('error', (error: Error) => {
    // Spawn failure (ENOENT, EACCES, …). `close` does not follow reliably on
    // all platforms when `error` fires, so this is the exit.
    logger.failure('engine spawn failed', error, { binary: options.binary })
    settle({ code: null, signal: null, expected: false })
  })

  child.on('close', (code, signal) => {
    settle({ code, signal, expected: stopping })
  })

  // Last-resort guarantee: whatever else happens, a live child is killed when
  // the app process itself exits. Synchronous — nothing else is available in
  // an 'exit' handler, and nothing else is needed. Removed by `settle` once
  // the child is reaped, so spawns do not accumulate listeners.
  function onProcessExit(): void {
    if (!settled && child.pid !== undefined) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already dead, or the platform refused — there is nothing left to do.
      }
    }
  }
  process.on('exit', onProcessExit)

  return {
    pid: child.pid,

    send(line) {
      // Analysis mode is line-delimited; one write per request. Backpressure
      // (stdin buffer full) is not handled: the largest request is a few KB
      // and the engine drains continuously — a real concern only for the
      // Stage 3 sweep, which will pace itself.
      if (!settled) child.stdin.write(`${line}\n`)
    },

    stderrTail: () => stderr.lines(),

    stop() {
      if (settled) return Promise.resolve()
      stopping = true
      // The analysis engine exits on stdin EOF (the fake honours this too).
      // SIGKILL after the grace period covers an engine too stuck in a search
      // to notice its input is gone; `settle` clears the timer if the close
      // arrives first.
      child.stdin.end()
      return new Promise<void>((resolve) => {
        child.once('close', () => {
          resolve()
        })
        stopTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Process already reaped between the timer firing and the kill.
          }
        }, graceMs)
      })
    },
  }
}
