import { describe, expect, it } from 'vitest'
import {
  SWEEP_CONCURRENCY,
  SWEEP_MAX_VISITS,
  createSweepLedger,
  markSweepComplete,
  markSweepFailed,
  resumeFrom,
  sweepQueryId,
} from '../../../src/main/katago/sweep'

/**
 * The whole-record sweep's pure ledger (`sweep.ts`).
 *
 * ## Why a ledger deserves its own file
 *
 * The sweep's decisions — which move is worth querying next, what counts as
 * done, what must never be re-issued — are pure functions over a small state
 * object, and they are exactly the decisions a mutation harness must be able
 * to break one at a time. Keeping them in a transport-free module (no engine,
 * no session, no timers) is what makes that possible: the session owns
 * mechanics, this module owns bookkeeping, and the split is asserted here
 * through behaviour, not structure.
 *
 * ## What is load-bearing
 *
 * - `resumeFrom` returns the **lowest** uncompleted move: the graph fills
 *   left to right, and a highest-first sweep would paint the end of a game
 *   nobody has reached;
 * - `failed` excludes a move permanently, `completed` marks it done, and both
 *   sets are honoured by `resumeFrom` — a malformed result must never be
 *   re-issued (the parser will reject it identically on retry), while an
 *   unanswered move has no trace at all and is exactly what a crash-resume
 *   re-issues;
 * - the mark functions ignore out-of-range moves, because the ledger's sets
 *   are also the resume source and a corrupt move number must not pollute it;
 * - `sweepQueryId` is the routing contract: `sweep:<moveNumber>`, reusing ids
 *   per record by design (the session keys its in-flight map within one
 *   sweep epoch).
 */

describe('createSweepLedger', () => {
  it('starts empty: every position 0..moveCount is worth querying', () => {
    const ledger = createSweepLedger(4)
    expect(ledger.moveCount).toBe(4)
    expect(ledger.completed.size).toBe(0)
    expect(ledger.failed.size).toBe(0)
    expect(resumeFrom(ledger)).toBe(0)
  })

  it('covers the position after the last move (0..moveCount inclusive)', () => {
    // A 2-move record has three positions worth a graph point: before move 1,
    // between the moves, and after move 2.
    const ledger = createSweepLedger(2)
    markSweepComplete(ledger, 0)
    markSweepComplete(ledger, 1)
    expect(resumeFrom(ledger)).toBe(2)
  })
})

describe('resumeFrom', () => {
  it('returns the lowest uncompleted move, not the most recent', () => {
    const ledger = createSweepLedger(10)
    markSweepComplete(ledger, 7)
    // Lowest-first is what paints the graph left to right; a regression to
    // highest-first returns 8 here (or anything above 0) and fails.
    expect(resumeFrom(ledger)).toBe(0)
  })

  it('skips failed moves permanently', () => {
    const ledger = createSweepLedger(5)
    markSweepFailed(ledger, 0)
    markSweepFailed(ledger, 1)
    expect(resumeFrom(ledger)).toBe(2)
  })

  it('treats a move in either set as done, whichever was recorded', () => {
    const ledger = createSweepLedger(5)
    markSweepComplete(ledger, 0)
    markSweepFailed(ledger, 1)
    markSweepComplete(ledger, 2)
    expect(resumeFrom(ledger)).toBe(3)
  })

  it('returns null when every position is accounted for', () => {
    const complete = createSweepLedger(3)
    for (let move = 0; move <= 3; move += 1) markSweepComplete(complete, move)
    expect(resumeFrom(complete)).toBeNull()

    const failed = createSweepLedger(3)
    for (let move = 0; move <= 3; move += 1) markSweepFailed(failed, move)
    expect(resumeFrom(failed)).toBeNull()
  })

  it('a move with no trace is the resume point — absence is the re-issue signal', () => {
    // Engine crash mid-sweep: the in-flight moves never landed in either set,
    // and the restarted session must pick them up again. This is the property
    // Stage 5's crash recovery builds on; it is asserted here, at the source.
    const ledger = createSweepLedger(6)
    markSweepComplete(ledger, 0)
    markSweepComplete(ledger, 1)
    // 2..5 were in flight when the engine died.
    markSweepComplete(ledger, 4) // one landed just before the exit event
    expect(resumeFrom(ledger)).toBe(2)
  })
})

describe('markSweepComplete / markSweepFailed', () => {
  it('records the move and returns the ledger for chaining', () => {
    const ledger = createSweepLedger(3)
    expect(markSweepComplete(ledger, 1)).toBe(ledger)
    expect(ledger.completed.has(1)).toBe(true)
    expect(markSweepFailed(ledger, 2)).toBe(ledger)
    expect(ledger.failed.has(2)).toBe(true)
  })

  it('ignores out-of-range moves on both sides of the record', () => {
    const ledger = createSweepLedger(3)
    markSweepComplete(ledger, -1)
    markSweepComplete(ledger, 4)
    markSweepFailed(ledger, -1)
    markSweepFailed(ledger, 4)
    expect(ledger.completed.size).toBe(0)
    expect(ledger.failed.size).toBe(0)
    // And the out-of-range marks must not have disturbed the resume answer.
    expect(resumeFrom(ledger)).toBe(0)
  })
})

describe('sweepQueryId', () => {
  it('is the routing contract: sweep:<moveNumber>', () => {
    expect(sweepQueryId(0)).toBe('sweep:0')
    expect(sweepQueryId(42)).toBe('sweep:42')
  })
})

describe('the fixed sweep constants', () => {
  it('pin the visit cap and the concurrency window', () => {
    // Fixed, not from settings — the numbers are the recorded decision
    // (`sweep.ts`), and pinning them here keeps a silent change to either one
    // from sliding into a release under "tuning".
    expect(SWEEP_MAX_VISITS).toBe(100)
    expect(SWEEP_CONCURRENCY).toBe(8)
  })
})
