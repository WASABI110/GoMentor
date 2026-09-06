import { SWEEP_QUERY_PREFIX } from '@gomentor/shared'

/**
 * The whole-game background sweep's pure ledger (`design.md` §Two-tier
 * analysis). The driver that turns ledger decisions into issued queries lives
 * in `session.ts` (which owns all query construction, focus and sweep alike);
 * this module is the testable, mutation-covered decision core.
 *
 * ## What the sweep is
 *
 * Focus analyses the position under the cursor with ownership and streaming
 * partials. The sweep walks every position of the record once, cheaply, so the
 * winrate graph can draw itself while the user reviews. Sweep queries
 * therefore carry **no ownership** (the graph never paints it — asking the
 * engine to compute an ownership tensor for every move would roughly double
 * sweep cost for zero UI value) and only the **final `complete` tick feeds the
 * graph**: streaming partials for sweep are noise, because a position's graph
 * point is replaced, not animated, and emitting ~20 partials/s/move would
 * flood IPC with data no one reads. Partial sweep ticks are dropped in the
 * session.
 *
 * ## Ledger ownership (a Stage 4 decision, recorded)
 *
 * The ledger lives in the **service**, not the session, and is passed in at
 * `startSweep`. The session owns query mechanics (send, in-flight routing,
 * the issue cursor); the ledger owns completion bookkeeping. Splitting them is
 * what makes the Stage 5 recovery requirement fall out for free: the session
 * is rebuilt per engine process (a crash disposes it), but the ledger survives
 * in the service, so a restarted engine resumes the sweep at
 * `resumeFrom(ledger)` — the first move that never completed. A new `setGame`
 * replaces the ledger entirely, which is the recorded "sweep does not survive
 * setGame" rule: a new record restarts its sweep from move 0.
 *
 * The state is deliberately mutable-and-shared (rather than the immutable
 * state-in/state-out of `coalesce.ts`) because two owners need the same
 * instance: the session records completions as ticks arrive; the service holds
 * the same object for the post-crash resume. The *decisions* on that state
 * (`resumeFrom`'s ordering and skip sets, the mark functions' set choice) are
 * the mutation-covered part.
 *
 * ## Resumability, and what "never arrives" means
 *
 * A sweep query whose result never arrives — engine crash mid-sweep — leaves
 * no trace in the ledger, so the post-restart resume re-issues it: absence of
 * completion is the resumability mechanism, which is why there is no
 * in-flight bookkeeping here at all. A move whose result arrives **malformed**
 * is different: it is recorded `failed` and never re-issued, because a response
 * the production parser rejects will be rejected identically on retry, and
 * re-issuing it forever would stall the sweep one move short every run.
 *
 * ## Sweep query identity (a recorded contract note)
 *
 * Sweep query ids are `sweep:<moveNumber>` (`SWEEP_QUERY_PREFIX` + the move),
 * reusing ids across records — the session's in-flight map keys on them within
 * one sweep epoch. A late final reply from a *terminated* sweep query (game
 * switch) can therefore theoretically meet a fresh entry for the same move.
 * The window is bounded by the engine's documented terminate ordering (the
 * mandated final reply is written before subsequent requests are processed,
 * and the new sweep must first pump through `SWEEP_CONCURRENCY` positions),
 * and the worst mis-route is one graph point from the old line of the same
 * move number.
 *
 * Stage 5 revisited this with backoff restart shipped, and the documented
 * bound suffices — no epoch suffixing:
 *
 * - A restart is a **new process**, and a new process can emit nothing stale:
 *   the dying process's late bytes end at the old session (disposed with the
 *   crash), and the resumed session's in-flight maps start empty. The only
 *   replies the new process sends are answers to queries the new session
 *   issued under its own fresh bookkeeping.
 * - The resume point is `resumeFrom(ledger)`, so a re-issued `sweep:<n>` is
 *   by definition a move with no completed result. A mis-route would require
 *   two live entries for the same id in one session, which the single in-flight
 *   map forbids — an id has exactly one owner at a time.
 * - The one-stale-point render the original note bounded remains the only
 *   theoretical exposure, and it stays bounded exactly as before: it needs a
 *   terminated query's final reply to race a same-move re-issue within one
 *   process, which the terminate ordering and the concurrency pump window
 *   already confine to a documented worst case.
 */

/**
 * Visit cap for sweep queries — fixed, not from settings (M2 adds no settings
 * surface; `design.md` §Compatibility records that decision). 100 sits at the
 * knee of the CPU envelope in `research/eigen-cpu-throughput.md` (~1–2.5
 * s/position for the bundled b10 net at 40–100 v/s on the reference CPU):
 * deep enough for a stable winrate, cheap enough that a 300-move record
 * sweeps in minutes while sharing the engine with focus.
 */
export const SWEEP_MAX_VISITS = 100

/**
 * How many sweep queries may be in flight at once. The engine time-slices
 * concurrent queries (`design.md` §Two-tier analysis), so a small window keeps
 * the pipeline full without flooding the in-flight map; completions pump the
 * next issue, and `resumeFrom` restarts the window after an engine restart.
 */
export const SWEEP_CONCURRENCY = 8

export interface SweepLedger {
  /** Positions run 0..moveCount inclusive; the sweep covers every one. */
  readonly moveCount: number
  /** Moves whose complete, well-formed result has arrived. */
  readonly completed: Set<number>
  /** Moves whose result was malformed — excluded permanently. */
  readonly failed: Set<number>
}

export function createSweepLedger(moveCount: number): SweepLedger {
  return { moveCount, completed: new Set(), failed: new Set() }
}

/**
 * The next move worth querying: the **lowest** move in `0..moveCount` that is
 * neither complete nor failed, or null when the sweep is done. Lowest-first
 * is what makes the graph fill left to right — the user reads a winrate curve
 * progressively from the opening, and a highest-first sweep would paint the
 * end of a game nobody has reached yet.
 */
export function resumeFrom(ledger: SweepLedger): number | null {
  for (let move = 0; move <= ledger.moveCount; move += 1) {
    if (!ledger.completed.has(move) && !ledger.failed.has(move)) return move
  }
  return null
}

/** Records a complete result. Out-of-range moves are ignored (defensive). */
export function markSweepComplete(ledger: SweepLedger, move: number): SweepLedger {
  if (move >= 0 && move <= ledger.moveCount) ledger.completed.add(move)
  return ledger
}

/**
 * Records a malformed result: excluded from `resumeFrom` permanently. The
 * failed set is disjoint from completed in every construction here; a move in
 * both would be skipped either way, so no ordering between them is load-bearing.
 */
export function markSweepFailed(ledger: SweepLedger, move: number): SweepLedger {
  if (move >= 0 && move <= ledger.moveCount) ledger.failed.add(move)
  return ledger
}

/** The wire id for a sweep move: `sweep:<moveNumber>`, the routing contract. */
export function sweepQueryId(moveNumber: number): string {
  return `${SWEEP_QUERY_PREFIX}${String(moveNumber)}`
}
