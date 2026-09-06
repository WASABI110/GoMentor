/**
 * The crash-restart circuit: how long to wait between respawn attempts, and
 * when repeated attempts prove the engine is beyond retrying (`E4`).
 *
 * Kept pure — attempt timestamps and a clock in, one decision out — so the
 * policy is unit-testable and mutation-covered (`scripts/mutate-katago.mts`).
 * The service owns the timers and the spawns; this module owns only the
 * arithmetic the decision hangs on.
 *
 * ## The policy, and the decisions in it
 *
 * - A **spawn attempt** is one `doStart` (the initial user-fired start and
 *   every backoff respawn count identically — the engine does not care why it
 *   was spawned). The service records `now()` at each spawn and passes the
 *   list here after an unexpected exit.
 * - **Circuit breaker**: `MAX_ATTEMPTS_PER_WINDOW` attempts inside
 *   `RETRY_WINDOW_MS` → `exhausted` → the service lands on
 *   `failed(ENGINE_CRASHED)`. "Restarting forever against a broken driver burns
 *   the user's machine" (`error-handling.md`); the window is what makes
 *   "forever" finite. On exhaustion the service clears the recorded attempts,
 *   so the user's manual `engine:start` retries with a fresh window — the
 *   breaker tripped once, it does not latch the app dead.
 * - **Backoff tiers** 1s / 2s / 4s, chosen by how many attempts already sit in
 *   the window. Honest note, recorded because a hidden dead slot is the kind of
 *   thing a future reader burns an afternoon on: with the breaker at 3 the
 *   third tier (4s) is unreachable — the third crash exhausts before a delay
 *   is chosen. The table stays three deep so a future relaxation of the
 *   breaker does not silently fall back to 1s; the unit test pins the first
 *   two tiers, and the unreachable tier is documented here rather than trimmed
 *   to hide it.
 */

/** Backoff delay per retry tier, indexed by attempts already in the window. */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const

/** Attempts inside this window count toward the circuit breaker. */
export const RETRY_WINDOW_MS = 60_000

/** This many attempts inside the window → the circuit opens. */
export const MAX_ATTEMPTS_PER_WINDOW = 3

export type RetryDecision =
  { readonly kind: 'retry'; readonly delayMs: number } | { readonly kind: 'exhausted' }

/**
 * Decides the next move after an unexpected exit. `attemptTimes` holds the
 * spawn times of every attempt still relevant; entries older than the window
 * are ignored (they are not removed — the caller owns the array — but they do
 * not count).
 */
export function planRetry(
  attemptTimes: readonly number[],
  nowMs: number,
): RetryDecision {
  const inWindow = attemptTimes.filter((at) => nowMs - at < RETRY_WINDOW_MS).length
  if (inWindow >= MAX_ATTEMPTS_PER_WINDOW) {
    return { kind: 'exhausted' }
  }
  const tier = Math.min(inWindow, RETRY_BACKOFF_MS.length) - 1
  return { kind: 'retry', delayMs: RETRY_BACKOFF_MS[tier] ?? RETRY_BACKOFF_MS[0] }
}
