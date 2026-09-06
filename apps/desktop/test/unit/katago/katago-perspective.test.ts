import { describe, expect, it } from 'vitest'
import type { AnalysisResult } from '@gomentor/shared'
import { normalizeAnalysisResult } from '../../../src/main/katago/perspective'

/**
 * The KataGo→contract perspective adapter, pinned by the verified facts in
 * `perspective.ts`'s header: under the pinned `reportAnalysisWinratesAs =
 * SIDETOMOVE`, KataGo reports winrate/scoreLead/ownership all from the side to
 * move's perspective, and the contract takes winrate as-is while wanting
 * scoreLead and ownership positive-favours-black.
 *
 * These tests are the executable half of that contract. They are stated against
 * the *convention*, not against sample values a mutation could co-vary with the
 * code: white-to-move must negate, black-to-move must not, and winrate must
 * never move. A real-engine transcript asserting the same end-to-end is
 * deferred to CI (the binary is unreachable from this network — recorded in
 * `perspective.ts`); nothing here fabricates one.
 */

function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    queryId: 'focus:1',
    gameId: 'g1',
    moveNumber: 10,
    player: 'white',
    winrate: 0.7,
    scoreLead: 2.5,
    visits: 100,
    candidates: [
      {
        coord: { x: 3, y: 3 },
        winrate: 0.7,
        scoreLead: 2.5,
        visits: 80,
        pv: [{ x: 3, y: 3 }],
        order: 0,
      },
      {
        coord: null,
        winrate: 0.4,
        scoreLead: -1.5,
        visits: 20,
        pv: [],
        order: 1,
      },
    ],
    ownership: [0.8, -0.2, 0],
    complete: false,
    ...overrides,
  }
}

describe('normalizeAnalysisResult', () => {
  it('black to move: identity — the engine perspective is already the contract’s', () => {
    const input = result({ player: 'black' })
    expect(normalizeAnalysisResult(input, 'black')).toBe(input)
  })

  it('white to move: negates scoreLead on the root and every candidate', () => {
    const normalized = normalizeAnalysisResult(result(), 'white')
    expect(normalized.scoreLead).toBe(-2.5)
    expect(normalized.candidates.map((candidate) => candidate.scoreLead)).toEqual([
      -2.5, 1.5,
    ])
  })

  it('white to move: negates ownership point by point', () => {
    const normalized = normalizeAnalysisResult(result(), 'white')
    expect(normalized.ownership).toEqual([-0.8, 0.2, -0])
  })

  it('winrate is identity in both directions — flipping it is double-counting', () => {
    const white = normalizeAnalysisResult(result({ winrate: 0.7 }), 'white')
    expect(white.winrate).toBe(0.7)
    expect(white.candidates.map((candidate) => candidate.winrate)).toEqual([0.7, 0.4])

    const black = normalizeAnalysisResult(
      result({ winrate: 0.3, player: 'black' }),
      'black',
    )
    expect(black.winrate).toBe(0.3)
  })

  it('leaves everything else untouched (visits, coords, pv, complete, ids)', () => {
    const input = result()
    const normalized = normalizeAnalysisResult(input, 'white')
    expect(normalized.queryId).toBe(input.queryId)
    expect(normalized.gameId).toBe(input.gameId)
    expect(normalized.moveNumber).toBe(input.moveNumber)
    expect(normalized.player).toBe(input.player)
    expect(normalized.visits).toBe(input.visits)
    expect(normalized.complete).toBe(input.complete)
    expect(normalized.candidates.map((candidate) => candidate.coord)).toEqual([
      { x: 3, y: 3 },
      null,
    ])
    expect(normalized.candidates.map((candidate) => candidate.visits)).toEqual([80, 20])
  })

  it('double negation returns the original values (flip is an involution)', () => {
    const once = normalizeAnalysisResult(result(), 'white')
    const twice = normalizeAnalysisResult(once, 'white')
    // Flipping for white twice must restore the input — this is the property
    // that catches an adapter that flips unconditionally (which would negate
    // again here and report +2.5 as -2.5).
    expect(twice.scoreLead).toBe(2.5)
    expect(twice.ownership).toEqual([0.8, -0.2, 0])
  })

  it('ownership absent stays absent — never fabricated as an empty array', () => {
    const input = result()
    const { ownership: _dropped, ...withoutOwnership } = input
    const normalized = normalizeAnalysisResult(withoutOwnership, 'white')
    expect('ownership' in normalized).toBe(false)
  })

  it('does not mutate its input', () => {
    const input = result()
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown
    normalizeAnalysisResult(input, 'white')
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
  })
})
