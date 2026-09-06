import { describe, expect, it } from 'vitest'
import {
  MAX_ATTEMPTS_PER_WINDOW,
  RETRY_BACKOFF_MS,
  RETRY_WINDOW_MS,
  planRetry,
} from '../../../src/main/katago/backoff'

/**
 * The crash-restart circuit's arithmetic. Every assertion is written against
 * the policy's semantics (`design.md` §Engine lifecycle: bounded backoff,
 * `>=3 attempts inside 60s -> failed`), so a mutation of the window boundary,
 * the breaker threshold, or the backoff table flips a result here.
 */

const T0 = 1_000_000

describe('planRetry', () => {
  it('first failure retries after 1s', () => {
    expect(planRetry([T0], T0 + 5_000)).toEqual({ kind: 'retry', delayMs: 1_000 })
  })

  it('second failure retries after 2s', () => {
    expect(planRetry([T0, T0 + 1_000], T0 + 6_000)).toEqual({
      kind: 'retry',
      delayMs: 2_000,
    })
  })

  it('third failure inside the window exhausts the circuit', () => {
    expect(planRetry([T0, T0 + 1_000, T0 + 3_000], T0 + 6_000)).toEqual({
      kind: 'exhausted',
    })
  })

  it('an attempt exactly at the window edge no longer counts', () => {
    // t0 sits exactly RETRY_WINDOW_MS before now: outside. Only the two later
    // attempts count, so the circuit has not tripped and the delay is the
    // second tier. A boundary slip (`<` → `<=`) flips this to exhausted.
    const decision = planRetry([T0 - RETRY_WINDOW_MS, T0, T0 + 1_000], T0)
    expect(decision).toEqual({ kind: 'retry', delayMs: 2_000 })
  })

  it('attempts spaced past the window reset the breaker', () => {
    // Two crashes a minute apart are two unrelated bad starts, not a pattern:
    // each sees one attempt in its window and gets the first tier.
    expect(planRetry([T0 - 61_000, T0], T0)).toEqual({ kind: 'retry', delayMs: 1_000 })
  })

  it('the table has three tiers and the breaker matches the documented policy', () => {
    // The policy constants are the contract with the service and the docs:
    // a silent edit to any of them must flip a number a reader can check.
    expect(RETRY_BACKOFF_MS).toEqual([1_000, 2_000, 4_000])
    expect(RETRY_WINDOW_MS).toBe(60_000)
    expect(MAX_ATTEMPTS_PER_WINDOW).toBe(3)
  })

  it('an empty history still yields a retry (defensive: a kill without a recorded attempt)', () => {
    expect(planRetry([], T0)).toEqual({ kind: 'retry', delayMs: 1_000 })
  })
})
