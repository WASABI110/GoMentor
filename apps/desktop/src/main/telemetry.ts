import { existsSync } from 'node:fs'
import { mkdir, appendFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { scoped } from './logger'

/**
 * Telemetry: **local-only**. Consent-gated crash dumps and an event log that
 * never leave the machine, in any state.
 *
 * ## What M5 changed, and what it did not
 *
 * M1 shipped this file as a no-op stub with stable call sites, on the argument
 * that adding telemetry by sprinkling calls across a codebase is how the
 * "never log gameplay content" rule gets broken. That argument still holds, so
 * the M5 wiring is a change to *this file and its construction site* only —
 * call sites did not move. What did NOT change is the transport: there is
 * none. The M5 scope decision (user, 2026-09-13) chose local-only over any
 * network backend, which is stronger than the M1 promise it replaces:
 *
 * - **No network call, period.** Not before consent (M1's rule), not after it
 *   either. `crashReporter` runs with `uploadToServer: false` — Electron never
 *   uploads a minidump — and the event log is a local JSONL file. The unit
 *   suite traps every network primitive and asserts nothing is touched; a
 *   mutation flipping `uploadToServer` to `true` is caught by test.
 * - **No content, ever.** Not SGF, not chat text, not prompts, not board
 *   positions — permanently off the table (`logging-guidelines.md`). The
 *   `TelemetryEvent` type below is a closed union of *names* with
 *   scalar-only fields: there is no shape in which a game record could be
 *   passed, and the runtime test snapshots every written line's keys against
 *   the union so a widened field cannot smuggle an object in.
 * - **Consent is still the collection gate.** `telemetryConsent` defaults to
 *   false; without it, no crash reporter starts and no file is written. With
 *   it, minidumps land in the local crashes directory and events append to
 *   `telemetry.jsonl` (rotated at 1 MB, one previous generation kept) — the
 *   same directory the "Reveal crashes" menu item opens.
 */

const logger = scoped('main:telemetry')

/**
 * Permitted events. A closed union rather than `(name: string, data: object)`,
 * because the latter would make "no content" a review rule instead of a type
 * error. Adding a member is the moment to ask what its payload carries.
 */
export type TelemetryEvent =
  | { name: 'app_started'; platform: string; arch: string; version: string }
  | { name: 'app_quit'; sessionSeconds: number }
  | { name: 'sgf_imported'; count: number; failed: number }
  | { name: 'engine_started'; backend: string; visitsPerSecond: number }
  | { name: 'llm_run_finished'; finishReason: string; kind: string }
  | { name: 'crash'; code: string }

export interface Telemetry {
  /** Records an event. Without consent this discards it after a debug line. */
  track(event: TelemetryEvent): void
  /** Whether anything is being written. False without consent. */
  readonly enabled: boolean
}

/**
 * The slice of Electron's `crashReporter` this module drives. Injected rather
 * than imported so the module stays pure Node — testable without an electron
 * mock, and the `uploadToServer: false` contract is asserted against the
 * injected spy in unit tests (and pinned by mutation).
 */
export interface CrashReporter {
  start(options: {
    companyName?: string
    uploadToServer: boolean
    ignoreSystemCrashHandler: boolean
  }): void
}

export interface TelemetryDeps {
  /** The settings document's `telemetryConsent`. The collection gate. */
  readonly consented: boolean
  /** Where the event JSONL lives (the crashes directory in production). */
  readonly logPath: string
  /** Electron's crashReporter, or null under plain Node (unit tests). */
  readonly crashReporter: CrashReporter | null
  /** Injectable clock for the JSONL timestamps. */
  readonly now: () => string
}

/** The event log rotates at 1 MB; one previous generation (`*.1`) is kept. */
const MAX_LOG_BYTES = 1024 * 1024

/** The M1 behaviour, kept verbatim: consent never reached, nothing written. */
export function createNoopTelemetry(): Telemetry {
  return {
    // Hardcoded `false`. The noop instance exists precisely because nothing is
    // collected; reporting `true` would be a lie a future reader might take as
    // evidence the wiring exists.
    enabled: false,

    track(event) {
      // The event name only — the scalar fields stay out of the log file so a
      // debug line cannot grow into a content carrier.
      logger.debug('telemetry event discarded (no consent / noop)', {
        event: event.name,
      })
    },
  }
}

/**
 * The consented implementation: local crash dumps via the injected
 * `crashReporter`, and the event JSONL. The `uploadToServer: false` in the
 * options below is load-bearing — it is the whole transport policy — and is
 * pinned by unit test plus mutation.
 */
export function createLocalTelemetry(deps: TelemetryDeps): Telemetry {
  // crashReporter.start can be called here because the construction site
  // (index.ts, inside `whenReady`) has already pointed `crashDumps` at the
  // app's own crashes directory. `uploadToServer: false` means Electron never
  // sends a minidump anywhere; `ignoreSystemCrashHandler` keeps the local dump
  // even though no OS dialog will appear.
  deps.crashReporter?.start({
    companyName: 'GoMentor',
    uploadToServer: false,
    ignoreSystemCrashHandler: true,
  })

  async function append(event: TelemetryEvent): Promise<void> {
    try {
      // Rotate first, then append: the .1 generation is overwritten, so the
      // on-disk cost is bounded at roughly two generations.
      if (existsSync(deps.logPath)) {
        const size = (await stat(deps.logPath)).size
        if (size > MAX_LOG_BYTES) {
          await rename(deps.logPath, `${deps.logPath}.1`)
        }
      }
      await mkdir(dirname(deps.logPath), { recursive: true })
      // The line is the closed-union event plus a timestamp — scalar fields
      // only, by construction of the type. No `message`, no `error`, no
      // context object: those are how content sneaks in.
      const line = `${JSON.stringify({ ...event, ts: deps.now() })}\n`
      await appendFile(deps.logPath, line, 'utf8')
    } catch (error) {
      // Telemetry must never take the app down with it: a full disk or a
      // vanished directory is logged (locally) and otherwise swallowed.
      logger.warn('telemetry write failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    enabled: true,

    track(event) {
      void append(event)
    },
  }
}

/**
 * The construction-site factory: consent decides which behaviour exists.
 * There is deliberately no way to flip consent on an instance — a settings
 * change takes effect on next launch, which keeps `enabled` an honest
 * statement about the whole process lifetime rather than a live switch.
 */
export function createTelemetry(deps: TelemetryDeps): Telemetry {
  return deps.consented ? createLocalTelemetry(deps) : createNoopTelemetry()
}
