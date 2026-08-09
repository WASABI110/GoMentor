import { scoped } from './logger'

/**
 * Telemetry: a **no-op stub**. Makes no network call, in any state.
 *
 * ## Why the module exists before the feature
 *
 * Call sites need to be stable (`design.md` §Operational). Adding telemetry in
 * M5 by sprinkling calls across a codebase that never had them is how the
 * "never log gameplay content" rule gets broken — by someone adding a call in a
 * place that happens to have a `Game` in scope. Having the seam here means M5 is
 * a change to one file, and the review question becomes "is this event's payload
 * allowed" rather than "where did all these calls come from".
 *
 * ## What this file must never become
 *
 * - **No network call before consent.** Not a ping, not a version check, not a
 *   crash report. `telemetryConsent` defaults to false and the wiring does not
 *   exist yet — A10's stage verification checks this by inspection *and* by
 *   asserting no request is made, because "a stub that quietly phones home"
 *   would violate `design.md` §Operational while looking like a stub.
 * - **No content, ever.** Not SGF, not chat text, not prompts, not board
 *   positions — permanently off the table, not merely off by default
 *   (`logging-guidelines.md`). This tool handles a user's private study material
 *   and their LLM keys. The `TelemetryEvent` type below is a closed union of
 *   *names* with scalar-only fields for exactly this reason: there is no shape
 *   in which a game record could be passed.
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
  /** Records an event. In M1 this discards it after a debug log line. */
  track(event: TelemetryEvent): void
  /** Whether anything would be sent. Always false in M1. */
  readonly enabled: boolean
}

/**
 * The M1 implementation. Logs at `debug` so a developer can see call sites fire
 * without any of it leaving the machine, and returns.
 */
export function createTelemetry(): Telemetry {
  return {
    // Hardcoded `false`, not read from settings. In M1 there is no transport at
    // all, so reporting `true` because a user consented would be a lie — and
    // one that a future reader might take as evidence the wiring exists.
    enabled: false,

    track(event) {
      // The event name only. Even the scalar fields are omitted: they are
      // permitted in the type because M5 will send them, but there is no reason
      // to put them in a log file today, and a `debug` line that grows to carry
      // a payload is how the content rule erodes.
      logger.debug('telemetry event discarded (no-op in M1)', { event: event.name })
    },
  }
}
