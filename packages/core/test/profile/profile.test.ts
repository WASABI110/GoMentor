import { describe, expect, it } from 'vitest'
import {
  buildProfile,
  HALF_LIFE_GAMES,
  EVIDENCE_LIMIT,
  WEAKNESS_LIMIT,
  TREND_EPSILON,
  type ProfileGameInput,
} from '../../src/profile/profile'
import type { CategoryId, CategoryMark } from '../../src/profile/categories'

/**
 * The profile assembly: the EMA's recency semantics (old games weigh less —
 * the implementation note in `profile.ts` records why the normalized form is
 * the one that actually delivers that), the top-three selection, the evidence
 * click-through contract, and the trend vocabulary.
 */

function mark(category: CategoryId, moveNumber: number, loss: number): CategoryMark {
  return { category, moveNumber, loss }
}

function game(
  gameId: string,
  importedAt: string,
  marks: CategoryMark[],
): ProfileGameInput {
  return { gameId, importedAt, marks }
}

const OPENING: CategoryId = 'opening-direction'
const FIGHTING: CategoryId = 'middlegame-fighting'
const ENDGAME: CategoryId = 'endgame-precision'
const BLINDSPOT: CategoryId = 'whole-board-blindspot'

describe('constants', () => {
  it('are the recorded design values', () => {
    expect(HALF_LIFE_GAMES).toBe(10)
    expect(EVIDENCE_LIMIT).toBe(3)
    expect(WEAKNESS_LIMIT).toBe(3)
    expect(TREND_EPSILON).toBeCloseTo(0.005, 12)
  })
})

describe('the EMA', () => {
  it('weighs a recent game more than an old one (the recency contract)', () => {
    const recentBig = buildProfile([
      game('old', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.02)]),
      game('new', '2026-06-01T00:00:00.000Z', [mark(OPENING, 1, 0.06)]),
    ])
    const oldBig = buildProfile([
      game('old', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.06)]),
      game('new', '2026-06-01T00:00:00.000Z', [mark(OPENING, 1, 0.02)]),
    ])
    const recent = recentBig.weaknesses[0]?.score ?? 0
    const older = oldBig.weaknesses[0]?.score ?? 0
    // Same two games, same two losses — the score tracks whichever game is
    // NEWER. A simple mean would score both orders identically.
    expect(recent).toBeGreaterThan(0.04)
    expect(older).toBeLessThan(0.04)
  })

  it('a bump half a lifetime ago moves the score half as much as a fresh one', () => {
    // Ten identical games; the difference between bumping the NEWEST game and
    // bumping the game exactly HALF_LIFE_GAMES back is the half-life itself:
    // the weights are 1 and 0.5^(10/10) = 0.5.
    const base = Array.from({ length: 11 }, (_, i) =>
      game(`g${String(i)}`, `2026-01-${String(1 + i).padStart(2, '0')}T00:00:00.000Z`, [
        mark(OPENING, 1, 0.01),
      ]),
    )
    const fresh = base.map((entry, i) =>
      i === 10 ? game('g10', entry.importedAt, [mark(OPENING, 1, 0.02)]) : entry,
    )
    const aged = base.map((entry, i) =>
      i === 0 ? game('g0', entry.importedAt, [mark(OPENING, 1, 0.02)]) : entry,
    )
    const baseScore = buildProfile(base).weaknesses[0]?.score ?? 0
    const freshScore = buildProfile(fresh).weaknesses[0]?.score ?? 0
    const agedScore = buildProfile(aged).weaknesses[0]?.score ?? 0
    expect(freshScore - baseScore).toBeGreaterThan(0)
    expect((agedScore - baseScore) / (freshScore - baseScore)).toBeCloseTo(0.5, 6)
  })

  it('orders by importedAt regardless of input order', () => {
    const ordered = buildProfile([
      game('a', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.02)]),
      game('b', '2026-06-01T00:00:00.000Z', [mark(OPENING, 1, 0.06)]),
    ])
    const shuffled = buildProfile([
      game('b', '2026-06-01T00:00:00.000Z', [mark(OPENING, 1, 0.06)]),
      game('a', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.02)]),
    ])
    expect(ordered.weaknesses[0]?.score).toBe(shuffled.weaknesses[0]?.score)
  })
})

describe('weakness selection', () => {
  it('names at most three categories, highest score first', () => {
    const snapshot = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [
        mark(OPENING, 1, 0.2),
        mark(FIGHTING, 30, 0.1),
        mark(ENDGAME, 160, 0.05),
        mark(BLINDSPOT, 40, 0.02),
      ]),
    ])
    expect(snapshot.weaknesses.map((weakness) => weakness.category)).toEqual([
      OPENING,
      FIGHTING,
      ENDGAME,
    ])
  })

  it('a category with no marks is absent, not a zero-score weakness', () => {
    const snapshot = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.2)]),
    ])
    expect(snapshot.weaknesses).toHaveLength(1)
    expect(snapshot.weaknesses[0]?.category).toBe(OPENING)
  })

  it('an empty library has no weaknesses — a state, not an error', () => {
    expect(buildProfile([]).weaknesses).toEqual([])
  })
})

describe('evidence', () => {
  it('carries the biggest losses first, capped at three', () => {
    const snapshot = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [
        mark(OPENING, 3, 0.05),
        mark(OPENING, 7, 0.2),
        mark(OPENING, 12, 0.1),
        mark(OPENING, 20, 0.15),
      ]),
    ])
    const evidence = snapshot.weaknesses[0]?.evidence ?? []
    expect(evidence).toEqual([
      { gameId: 'g1', moveNumber: 7, loss: 0.2 },
      { gameId: 'g1', moveNumber: 20, loss: 0.15 },
      { gameId: 'g1', moveNumber: 12, loss: 0.1 },
    ])
  })

  it('evidence spans games — an old small slip can still be the shown example', () => {
    const snapshot = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [mark(OPENING, 3, 0.3)]),
      game('g2', '2026-02-01T00:00:00.000Z', [mark(OPENING, 5, 0.1)]),
    ])
    expect(snapshot.weaknesses[0]?.evidence).toEqual([
      { gameId: 'g1', moveNumber: 3, loss: 0.3 },
      { gameId: 'g2', moveNumber: 5, loss: 0.1 },
    ])
  })
})

describe('trend', () => {
  it('worsens when the recent half moved the score up', () => {
    const snapshot = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.01)]),
      game('g2', '2026-02-01T00:00:00.000Z', [mark(OPENING, 1, 0.01)]),
      game('g3', '2026-03-01T00:00:00.000Z', [mark(OPENING, 1, 0.2)]),
      game('g4', '2026-04-01T00:00:00.000Z', [mark(OPENING, 1, 0.2)]),
    ])
    expect(snapshot.weaknesses[0]?.trend).toBe('worsening')
  })

  it('improves when the recent half moved the score down', () => {
    const snapshot = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.2)]),
      game('g2', '2026-02-01T00:00:00.000Z', [mark(OPENING, 1, 0.2)]),
      game('g3', '2026-03-01T00:00:00.000Z', [mark(OPENING, 1, 0.01)]),
      game('g4', '2026-04-01T00:00:00.000Z', [mark(OPENING, 1, 0.01)]),
    ])
    expect(snapshot.weaknesses[0]?.trend).toBe('improving')
  })

  it('stays steady inside the epsilon band, and with a single game', () => {
    const steady = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.05)]),
      game('g2', '2026-02-01T00:00:00.000Z', [mark(OPENING, 1, 0.051)]),
      game('g3', '2026-03-01T00:00:00.000Z', [mark(OPENING, 1, 0.05)]),
      game('g4', '2026-04-01T00:00:00.000Z', [mark(OPENING, 1, 0.051)]),
    ])
    expect(steady.weaknesses[0]?.trend).toBe('steady')

    const lone = buildProfile([
      game('g1', '2026-01-01T00:00:00.000Z', [mark(OPENING, 1, 0.2)]),
    ])
    expect(lone.weaknesses[0]?.trend).toBe('steady')
  })
})
