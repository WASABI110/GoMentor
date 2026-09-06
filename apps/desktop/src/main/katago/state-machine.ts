/**
 * The engine status state machine: which lifecycle states exist and which
 * transitions are legal between them.
 *
 * `EngineStatus` (`packages/shared/src/types/analysis.ts`) is the wire shape;
 * this module is the policy that produces it. Kept pure — states and events
 * in, one state out — so the transition table is unit-testable and
 * mutation-covered. The service owns the side effects (emitting
 * `engine:status`, spawning, probing) and consults this table before each one;
 * a transition the table rejects means "no change", and the service emits
 * nothing.
 *
 * ## The table, and the decisions in it
 *
 * - Startup is **lazy and idempotent**: `start-requested` from `ready` or
 *   `starting` is a no-op (the latter joins the in-flight attempt in the
 *   service). Only `unavailable` and `failed` actually start — `failed` →
 *   `starting` is the user-visible recovery path (`engine:start` retries).
 * - Readiness is **proven, not declared**: only a successful 1-visit probe
 *   (`probe-succeeded`) moves `starting` → `ready`. A declared-ready engine
 *   that was never probed is exactly the M1 class of bug this project keeps
 *   paying for.
 * - `crashed` is distinguished from `probe-timed-out` because the remedy
 *   differs (crash → the engine died; timeout → it never answered), and both
 *   land on `failed`. Stage 5's backoff restart adds `crash-retry` for the
 *   case with budget left.
 * - **`crash-retry` and the wire shape of a restart (a Stage 5 decision,
 *   recorded):** `engineStatusSchema` is M1-frozen — `unavailable |
 *   downloading | starting | ready | failed` — and a transient `restarting`
 *   value was rejected rather than growing the schema for one transient
 *   sub-state. The badge instead honestly shows `starting` when a backoff
 *   respawn begins (`ready → starting`), because that IS what is happening:
 *   an engine is coming up and nothing is answerable yet. From `starting` (a
 *   probe-phase crash retried) the event is a no-op — the badge already says
 *   `starting`, and re-emitting would only flicker. Exhaustion still rides
 *   the existing `crashed` event to `failed(ENGINE_CRASHED)`.
 * - `missing-in-dev` exists because absence is a state, not an error
 *   (`error-handling.md`): a dev checkout without fetched binaries degrades to
 *   `unavailable`, it does not fail.
 */

export type EnginePhase = 'unavailable' | 'starting' | 'ready' | 'failed'

export type EngineEvent =
  | { readonly kind: 'start-requested' }
  | { readonly kind: 'start-failed' }
  | { readonly kind: 'probe-succeeded' }
  | { readonly kind: 'probe-timed-out' }
  | { readonly kind: 'crashed' }
  | { readonly kind: 'crash-retry' }
  | { readonly kind: 'missing-in-dev' }
  | { readonly kind: 'shutdown' }

/**
 * Returns the next phase, or the current one when the event is not legal
 * there. Every case is explicit — no catch-all — so a new event kind is a
 * compile error until the table decides what it means.
 */
export function reduceEnginePhase(
  current: EnginePhase,
  event: EngineEvent,
): EnginePhase {
  switch (event.kind) {
    case 'start-requested':
      // Idempotent: `ready` re-requesting is a no-op, and a second `start`
      // while one is in flight joins it rather than respawning.
      return current === 'unavailable' || current === 'failed' ? 'starting' : current
    case 'start-failed':
      // Startup itself failed (config not writable, locate said the assets
      // are defective). Distinct from `crashed`/`probe-timed-out` because the
      // service attaches a different `errorCode` to each.
      return current === 'starting' ? 'failed' : current
    case 'probe-succeeded':
      return current === 'starting' ? 'ready' : current
    case 'probe-timed-out':
      return current === 'starting' ? 'failed' : current
    case 'crashed':
      // Legal from any live phase: an engine that dies after `ready` has still
      // died, and the badge must say so rather than fossilise on `ready`.
      return current === 'starting' || current === 'ready' ? 'failed' : current
    case 'crash-retry':
      // Budget left after an unexpected exit: respawn under backoff. Only
      // `ready` moves — to `starting`, the wire shape of a restart (see the
      // module header). From `starting` it is a no-op: the badge already says
      // the engine is coming up, and emitting again would flicker.
      return current === 'ready' ? 'starting' : current
    case 'missing-in-dev':
      return current === 'starting' ? 'unavailable' : current
    case 'shutdown':
      return 'unavailable'
  }
}
