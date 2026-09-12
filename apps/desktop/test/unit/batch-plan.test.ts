import { describe, expect, it } from 'vitest'
import type { AnalysisResult } from '@gomentor/shared'
import {
  BATCH_CHUNK_SIZE,
  buildAnalysisRow,
  planGameRun,
  planQueue,
  winrateLoss,
  type QueueCandidate,
} from '../../src/main/katago/batch-plan'

/**
 * The batch tier's pure decision core. Each function here is a mutation-harness
 * anchor: the suite asserts behaviour through the real module so a mutated
 * decision (skip logic, resume offset, loss sign, candidate ranking) turns a
 * case red.
 */

function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    queryId: 'batch:1',
    gameId: 'g1',
    moveNumber: 1,
    player: 'white',
    winrate: 0.52,
    scoreLead: -1.5,
    visits: 100,
    candidates: [],
    complete: true,
    ...overrides,
  }
}

function candidate(
  order: number,
  coord: { x: number; y: number } | null,
  winrate: number,
): AnalysisResult['candidates'][number] {
  return { coord, winrate, scoreLead: 0, visits: 10, pv: [], order }
}

describe('winrateLoss', () => {
  it('is before + after − 1 in winrate points', () => {
    // Mover had 0.55 before the move; the new side to move reads 0.52, so the
    // mover's own position is 1 − 0.52 = 0.48 after it. Loss = 0.55 − 0.48.
    expect(winrateLoss(0.55, 0.52)).toBeCloseTo(0.07, 10)
  })

  it('is signed — a follow-up the engine rates higher reads as a gain', () => {
    // Deliberately NOT clamped: Stage 3 thresholds fire on positive losses
    // only, and clamping would feed them fabricated zeros.
    expect(winrateLoss(0.5, 0.4)).toBeCloseTo(-0.1, 10)
  })

  it('zero when the position reads exactly as the engine expected', () => {
    expect(winrateLoss(1, 0)).toBe(0)
  })
})

describe('buildAnalysisRow', () => {
  it('projects the result fields and attributes the loss to the move', () => {
    const row = buildAnalysisRow(0.6, result({ moveNumber: 4, winrate: 0.51 }), 19)
    expect(row).toEqual({
      moveNumber: 4,
      player: 'white',
      winrate: 0.51,
      scoreLead: -1.5,
      winrateLoss: 0.6 + 0.51 - 1,
      topCandidateCoord: null,
      topCandidateWinrate: null,
    })
  })

  it('ranks candidates by their own order, not array position', () => {
    // The wire makes no promise about array order — only `order` is the rank.
    const row = buildAnalysisRow(
      0.5,
      result({
        candidates: [
          candidate(1, { x: 3, y: 15 }, 0.5),
          candidate(0, { x: 3, y: 3 }, 0.61),
        ],
      }),
      19,
    )
    expect(row.topCandidateCoord).toBe('D16')
    expect(row.topCandidateWinrate).toBe(0.61)
  })

  it('spells a pass candidate as "pass"', () => {
    const row = buildAnalysisRow(
      0.5,
      result({ candidates: [candidate(0, null, 0.4)] }),
      19,
    )
    expect(row.topCandidateCoord).toBe('pass')
  })

  it('leaves the top-candidate fields null when the engine named none', () => {
    const row = buildAnalysisRow(0.5, result({ candidates: [] }), 19)
    expect(row.topCandidateCoord).toBeNull()
    expect(row.topCandidateWinrate).toBeNull()
  })
})

describe('planGameRun', () => {
  it('plans a fresh game from the empty board with no persisted seed', () => {
    expect(planGameRun([])).toEqual({ startPosition: 0, resumeFromMove: null })
  })

  it('resumes one past the last persisted row, seeded from that row', () => {
    expect(planGameRun([1, 2])).toEqual({ startPosition: 3, resumeFromMove: 2 })
  })

  it('treats the persisted prefix as contiguous — the first gap is last + 1', () => {
    expect(planGameRun([1, 2, 3])).toEqual({ startPosition: 4, resumeFromMove: 3 })
  })

  it('uses the maximum persisted move, not the last array entry', () => {
    expect(planGameRun([2, 1])).toEqual({ startPosition: 3, resumeFromMove: 2 })
  })
})

function candidateGame(
  id: string,
  overrides: Partial<QueueCandidate> = {},
): QueueCandidate {
  return {
    id,
    blackName: undefined,
    whiteName: undefined,
    override: undefined,
    ledgerStatus: null,
    ...overrides,
  }
}

describe('planQueue', () => {
  it('queues everything in library order for the "all" scope', () => {
    const queue = planQueue(
      [candidateGame('a'), candidateGame('b'), candidateGame('c')],
      'all',
      [],
    )
    expect(queue).toEqual(['a', 'b', 'c'])
  })

  it('never re-analyses a done game, in either scope', () => {
    const queue = planQueue(
      [
        candidateGame('done', { ledgerStatus: 'done' }),
        candidateGame('pending', { ledgerStatus: 'pending' }),
        candidateGame('failed', { ledgerStatus: 'failed' }),
        candidateGame('fresh', { ledgerStatus: null }),
      ],
      'all',
      [],
    )
    expect(queue).toEqual(['pending', 'failed', 'fresh'])
  })

  it('retries failed games and resumes pending ones — both are work', () => {
    const queue = planQueue(
      [
        candidateGame('f', { ledgerStatus: 'failed' }),
        candidateGame('p', { ledgerStatus: 'pending' }),
      ],
      'all',
      [],
    )
    expect(queue).toEqual(['f', 'p'])
  })

  it('mine matches a configured name on either colour, case-insensitively', () => {
    const games = [
      candidateGame('black-match', { blackName: 'LEE CHANGHO' }),
      candidateGame('white-match', { whiteName: 'lee changho' }),
      candidateGame('other', { blackName: 'Kato', whiteName: 'Rin' }),
    ]
    expect(planQueue(games, 'mine', ['Lee Changho'])).toEqual([
      'black-match',
      'white-match',
    ])
  })

  it('mine with no configured names and no overrides queues nothing', () => {
    expect(planQueue([candidateGame('a', { blackName: 'Me' })], 'mine', [])).toEqual([])
  })

  it('the manual override outranks name matching in both directions', () => {
    const games = [
      candidateGame('forced-in', { blackName: 'Kato', override: true }),
      candidateGame('forced-out', { blackName: 'Lee Changho', override: false }),
    ]
    expect(planQueue(games, 'mine', ['Lee Changho'])).toEqual(['forced-in'])
  })

  it('the override also applies under the "all" scope filter — done still wins', () => {
    const queue = planQueue(
      [
        candidateGame('still-skipped', { override: true, ledgerStatus: 'done' }),
        candidateGame('kept', { override: false, ledgerStatus: 'pending' }),
      ],
      'all',
      [],
    )
    expect(queue).toEqual(['kept'])
  })
})

describe('BATCH_CHUNK_SIZE', () => {
  it('is the documented mid-game checkpoint bound', () => {
    // The value is a trade (crash-loss vs fsync amortisation), not a constant
    // to drift silently — pinning it makes a retune a deliberate diff.
    expect(BATCH_CHUNK_SIZE).toBe(25)
  })
})
