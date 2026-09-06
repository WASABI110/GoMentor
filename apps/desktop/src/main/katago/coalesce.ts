/**
 * Per-query latest-wins tick coalescer: the ≤20/s ceiling on `engine:analysis`
 * before anything reaches `webContents.send`.
 *
 * ## Why this exists
 *
 * KataGo streams partial results every `reportDuringSearchEvery` seconds and
 * can emit far faster than a UI paints; the M1 design rule (`design.md`
 * §Streaming) caps the event stream at ~20/s per query. Without coalescing,
 * every search report crosses IPC, the renderer store updates, and React
 * re-renders — work discarded unread a frame later. The Electron IPC flooding
 * cliff this guards against is documented, not hypothetical.
 *
 * ## Latest-wins, and why dropping is correct here
 *
 * Within one interval window only the most recent tick matters: each tick is a
 * *snapshot* of the same search (same queryId, same position), strictly newer
 * and no less complete than the one before it. Holding tick 3 while ticks 4
 * and 5 arrive and then emitting 5 loses nothing — 3 and 4 described the same
 * position worse. A `complete` tick is different: it is the search's settled
 * verdict and the UI wants it promptly, so it bypasses the window (urgent).
 *
 * ## Why the decision core is pure
 *
 * The state machine (`coalesceOffer`/`coalesceFlush`) takes the clock as an
 * argument and returns what to emit — no timers, no I/O — so the coalescing
 * *decisions* are unit-testable with synthetic timestamps and mutation-
 * covered (`scripts/mutate-katago.mts`). `createTickCoalescer` is the thin
 * impure wrapper that owns the `setTimeout`; its only job is to schedule the
 * flush when a tick is held.
 */

export interface CoalesceState<T> {
  /** When the last tick was emitted, or null before the first. */
  readonly lastEmitAtMs: number | null
  /**
   * The newest held tick, or null. Only ever one entry — holding a second
   * tick *replaces* the first (latest-wins); it never queues.
   */
  readonly pending: { readonly atMs: number; readonly value: T } | null
}

export function initialCoalesceState<T>(): CoalesceState<T> {
  return { lastEmitAtMs: null, pending: null }
}

export interface CoalesceDecision<T> {
  readonly state: CoalesceState<T>
  /** The tick to emit right now, or null (held, or nothing pending). */
  readonly emit: T | null
}

/**
 * Offers a tick to the coalescer.
 *
 * - Urgent ticks (`isUrgent(value)` — the search's `complete` result) emit
 *   immediately, bypassing the interval, and discard any held partial: the
 *   settled verdict supersedes every snapshot before it.
 * - Otherwise, a tick emits immediately when the interval has elapsed since
 *   the last emission (or nothing has been emitted yet); within the window it
 *   is held, replacing any previously held tick.
 */
export function coalesceOffer<T>(
  state: CoalesceState<T>,
  value: T,
  atMs: number,
  intervalMs: number,
  isUrgent: (value: T) => boolean,
): CoalesceDecision<T> {
  if (isUrgent(value)) {
    return { state: { lastEmitAtMs: atMs, pending: null }, emit: value }
  }
  const due = state.lastEmitAtMs === null || atMs - state.lastEmitAtMs >= intervalMs
  if (due) {
    return { state: { lastEmitAtMs: atMs, pending: null }, emit: value }
  }
  return {
    state: { lastEmitAtMs: state.lastEmitAtMs, pending: { atMs, value } },
    emit: null,
  }
}

/**
 * The interval timer fired: emit the held tick, if any. Emission stamps the
 * clock with *now* (the flush moment), keeping the steady-state rate at one
 * emission per interval under a continuous stream.
 */
export function coalesceFlush<T>(
  state: CoalesceState<T>,
  atMs: number,
): CoalesceDecision<T> {
  if (state.pending === null) {
    return { state, emit: null }
  }
  return {
    state: { lastEmitAtMs: atMs, pending: null },
    emit: state.pending.value,
  }
}

/** Whether a held tick is waiting for the interval timer. */
export function coalesceHasPending<T>(state: CoalesceState<T>): boolean {
  return state.pending !== null
}

/**
 * Impure wrapper: owns the `setTimeout` that fires `coalesceFlush`. The timer
 * is scheduled only while a tick is held, so an idle query holds no timer;
 * each new held tick reschedules (the deadline is always "one interval from
 * the last emission", and a held tick implies an emission happened within the
 * last interval, so re-arming from *now* bounds the wait).
 */
export interface TickCoalescer<T> {
  /**
   * Offers a tick. Returns the tick to emit immediately, or null when the
   * tick was held for the timer.
   */
  offer(value: T): T | null
  /** Cancels any pending timer and drops held state. */
  dispose(): void
}

export function createTickCoalescer<T>(options: {
  readonly intervalMs: number
  readonly isUrgent: (value: T) => boolean
  readonly now?: () => number
  readonly setTimer: (fn: () => void, ms: number) => () => void
  readonly onEmit: (value: T) => void
}): TickCoalescer<T> {
  const now = options.now ?? Date.now
  let state = initialCoalesceState<T>()
  let cancelTimer: (() => void) | null = null

  function ensureTimer(): void {
    if (cancelTimer !== null) return
    cancelTimer = options.setTimer(() => {
      cancelTimer = null
      const decision = coalesceFlush(state, now())
      state = decision.state
      if (decision.emit !== null) options.onEmit(decision.emit)
    }, options.intervalMs)
  }

  return {
    offer(value) {
      const decision = coalesceOffer(
        state,
        value,
        now(),
        options.intervalMs,
        options.isUrgent,
      )
      state = decision.state
      if (decision.emit !== null) {
        // An emission leaves nothing held; a pending timer from an earlier
        // hold is stale but harmless — the flush will find `pending === null`
        // and emit nothing. Cancelling it here anyway keeps the invariant
        // "timer exists iff a tick is held" exact and auditable.
        if (cancelTimer !== null) {
          cancelTimer()
          cancelTimer = null
        }
        options.onEmit(decision.emit)
        return decision.emit
      }
      ensureTimer()
      return null
    },

    dispose() {
      if (cancelTimer !== null) {
        cancelTimer()
        cancelTimer = null
      }
      state = initialCoalesceState<T>()
    },
  }
}
