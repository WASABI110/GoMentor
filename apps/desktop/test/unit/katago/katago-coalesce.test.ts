import { describe, expect, it } from 'vitest'
import {
  coalesceFlush,
  coalesceHasPending,
  coalesceOffer,
  createTickCoalescer,
  initialCoalesceState,
} from '../../../src/main/katago/coalesce'

/**
 * The per-query coalescing decision core, pure: the clock arrives as an
 * argument, so every window/urgent boundary is exact and there is no timer to
 * fake. `createTickCoalescer` is covered where the timer matters (scheduling,
 * rescheduling, disposal) with a manual timer seam.
 *
 * ## What is load-bearing here
 *
 * - latest-wins: a tick held inside the window is *replaced* by the next one,
 *   never queued — two offers, one emission, the NEWER value;
 * - urgent bypasses the window but still stamps the clock (the next partial
 *   must wait a full interval, not ride the urgent emission's instant);
 * - flush stamps `lastEmitAtMs` with the flush moment, so a continuous stream
 *   settles at exactly one emission per interval, not one per offer;
 * - the wrapper's timer exists only while a tick is held, and `dispose` drops
 *   both timer and held state.
 */

const INTERVAL = 50
const urgent = (value: number) => value < 0 // negative marks a "complete" tick

describe('coalesceOffer', () => {
  it('emits the first tick immediately and stamps the clock', () => {
    const decision = coalesceOffer(
      initialCoalesceState<number>(),
      1,
      1000,
      INTERVAL,
      urgent,
    )
    expect(decision.emit).toBe(1)
    expect(decision.state.lastEmitAtMs).toBe(1000)
    expect(decision.state.pending).toBeNull()
  })

  it('holds a tick inside the window', () => {
    const first = coalesceOffer(
      initialCoalesceState<number>(),
      1,
      1000,
      INTERVAL,
      urgent,
    )
    const second = coalesceOffer(first.state, 2, 1020, INTERVAL, urgent)
    expect(second.emit).toBeNull()
    expect(second.state.pending).toEqual({ atMs: 1020, value: 2 })
    expect(second.state.lastEmitAtMs).toBe(1000)
  })

  it('is latest-wins: a held tick is replaced, not queued', () => {
    let state = coalesceOffer(
      initialCoalesceState<number>(),
      1,
      1000,
      INTERVAL,
      urgent,
    ).state
    state = coalesceOffer(state, 2, 1010, INTERVAL, urgent).state
    const third = coalesceOffer(state, 3, 1020, INTERVAL, urgent)
    expect(third.emit).toBeNull()
    expect(third.state.pending).toEqual({ atMs: 1020, value: 3 })
    // Flush emits only the newest value — 2 was discarded unread.
    const flushed = coalesceFlush(third.state, 1050)
    expect(flushed.emit).toBe(3)
    expect(flushed.state.pending).toBeNull()
  })

  it('emits once the interval has elapsed since the last emission', () => {
    const first = coalesceOffer(
      initialCoalesceState<number>(),
      1,
      1000,
      INTERVAL,
      urgent,
    )
    // One ms short: held.
    expect(coalesceOffer(first.state, 2, 1049, INTERVAL, urgent).emit).toBeNull()
    // Exactly the interval: emitted.
    const due = coalesceOffer(first.state, 2, 1050, INTERVAL, urgent)
    expect(due.emit).toBe(2)
    expect(due.state.lastEmitAtMs).toBe(1050)
    expect(due.state.pending).toBeNull()
  })

  it('an urgent tick emits immediately and discards the held one', () => {
    let state = coalesceOffer(
      initialCoalesceState<number>(),
      1,
      1000,
      INTERVAL,
      urgent,
    ).state
    state = coalesceOffer(state, 2, 1010, INTERVAL, urgent).state
    const settle = coalesceOffer(state, -1, 1020, INTERVAL, urgent)
    expect(settle.emit).toBe(-1)
    expect(settle.state.pending).toBeNull()
    expect(settle.state.lastEmitAtMs).toBe(1020)
  })

  it('the urgent emission stamps the clock: the next partial waits a full interval', () => {
    const urgentEmit = coalesceOffer(
      initialCoalesceState<number>(),
      -1,
      1000,
      INTERVAL,
      urgent,
    )
    // 20ms after the urgent tick — inside the window, must hold.
    const next = coalesceOffer(urgentEmit.state, 5, 1020, INTERVAL, urgent)
    expect(next.emit).toBeNull()
    expect(next.state.pending?.value).toBe(5)
  })
})

describe('coalesceFlush', () => {
  it('emits nothing when nothing is held', () => {
    const state = coalesceOffer(
      initialCoalesceState<number>(),
      1,
      1000,
      INTERVAL,
      urgent,
    ).state
    const flushed = coalesceFlush(state, 2000)
    expect(flushed.emit).toBeNull()
    expect(flushed.state).toBe(state)
  })

  it('stamps the clock with the flush moment, bounding a continuous stream to one per interval', () => {
    let state = coalesceOffer(
      initialCoalesceState<number>(),
      1,
      1000,
      INTERVAL,
      urgent,
    ).state
    state = coalesceOffer(state, 2, 1010, INTERVAL, urgent).state
    // The flush fires 40ms after the hold — before a full interval from the
    // last emission. Emitting 2 and stamping 1050 means a tick offered at 1060
    // holds; stamping 1010 (the hold moment) would have emitted it.
    const flushed = coalesceFlush(state, 1050)
    expect(flushed.emit).toBe(2)
    expect(flushed.state.lastEmitAtMs).toBe(1050)
    expect(coalesceOffer(flushed.state, 3, 1060, INTERVAL, urgent).emit).toBeNull()
    expect(coalesceOffer(flushed.state, 4, 1100, INTERVAL, urgent).emit).toBe(4)
  })
})

describe('coalesceHasPending', () => {
  it('is true exactly while a tick is held', () => {
    const initial = initialCoalesceState<number>()
    expect(coalesceHasPending(initial)).toBe(false)
    const held = coalesceOffer(initial, 1, 1000, INTERVAL, urgent)
    // First offer emits immediately — nothing held.
    expect(coalesceHasPending(held.state)).toBe(false)
    const second = coalesceOffer(held.state, 2, 1010, INTERVAL, urgent)
    expect(coalesceHasPending(second.state)).toBe(true)
    const flushed = coalesceFlush(second.state, 1100)
    expect(coalesceHasPending(flushed.state)).toBe(false)
  })
})

describe('createTickCoalescer', () => {
  /**
   * A manual timer: `schedule` captures the callback so the test fires it at a
   * chosen moment, and `cancel` records the cancellation so a leaked timer is
   * observable.
   */
  function timerSeam() {
    let timer: { fn: () => void; ms: number } | null = null
    return {
      setTimer: (fn: () => void, ms: number) => {
        timer = { fn, ms }
        return () => {
          timer = null
        }
      },
      /** Synthetic clock, advanced by the test. */
      now: () => clock,
      fire: () => {
        const pending = timer
        if (pending === null) throw new Error('no timer scheduled')
        expect(pending.ms).toBe(INTERVAL)
        timer = null
        pending.fn()
      },
      hasTimer: () => timer !== null,
    }
  }
  let clock = 0

  it('holds inside the window and the timer flushes the held tick', () => {
    clock = 1000
    const seam = timerSeam()
    const emitted: number[] = []
    const coalescer = createTickCoalescer<number>({
      intervalMs: INTERVAL,
      isUrgent: urgent,
      now: seam.now,
      setTimer: seam.setTimer,
      onEmit: (value) => emitted.push(value),
    })

    expect(coalescer.offer(1)).toBe(1) // first: immediate
    clock = 1010
    expect(coalescer.offer(2)).toBeNull() // held
    expect(seam.hasTimer()).toBe(true)

    clock = 1050
    seam.fire()
    expect(emitted).toEqual([1, 2])
    expect(seam.hasTimer()).toBe(false)
    coalescer.dispose()
  })

  it('an immediate emission cancels the pending timer', () => {
    clock = 1000
    const seam = timerSeam()
    const coalescer = createTickCoalescer<number>({
      intervalMs: INTERVAL,
      isUrgent: urgent,
      now: seam.now,
      setTimer: seam.setTimer,
      onEmit: () => undefined,
    })

    expect(coalescer.offer(1)).toBe(1)
    clock = 1010
    expect(coalescer.offer(2)).toBeNull()
    expect(seam.hasTimer()).toBe(true)

    // The interval elapses on the clock without the timer firing; the next
    // offer is due and emits immediately — the stale timer must be cancelled,
    // not left to flush an empty state later.
    clock = 1100
    expect(coalescer.offer(3)).toBe(3)
    expect(seam.hasTimer()).toBe(false)
    coalescer.dispose()
  })

  it('dispose drops the held tick and cancels the timer', () => {
    clock = 1000
    const seam = timerSeam()
    const emitted: number[] = []
    const coalescer = createTickCoalescer<number>({
      intervalMs: INTERVAL,
      isUrgent: urgent,
      now: seam.now,
      setTimer: seam.setTimer,
      onEmit: (value) => emitted.push(value),
    })

    coalescer.offer(1)
    clock = 1010
    coalescer.offer(2)
    coalescer.dispose()
    expect(seam.hasTimer()).toBe(false)

    clock = 2000
    // Nothing held, nothing emitted — 2 died with the coalescer (per-query
    // disposal on supersede is exactly why dispose exists).
    expect(emitted).toEqual([1])
    coalescer.dispose() // second dispose is a harmless no-op
  })

  it('a second held tick does not schedule a second timer', () => {
    clock = 1000
    const seam = timerSeam()
    const coalescer = createTickCoalescer<number>({
      intervalMs: INTERVAL,
      isUrgent: urgent,
      now: seam.now,
      setTimer: seam.setTimer,
      onEmit: () => undefined,
    })

    coalescer.offer(1)
    clock = 1010
    coalescer.offer(2)
    clock = 1020
    coalescer.offer(3)
    expect(seam.hasTimer()).toBe(true) // still exactly one
    coalescer.dispose()
  })

  it('now defaults to Date.now without crashing', () => {
    const coalescer = createTickCoalescer<number>({
      intervalMs: INTERVAL,
      isUrgent: urgent,
      setTimer: (fn) => {
        // Never fire in this test; return a no-op cancel.
        void fn
        return () => undefined
      },
      onEmit: () => undefined,
    })
    expect(coalescer.offer(1)).toBe(1)
    coalescer.dispose()
  })
})
