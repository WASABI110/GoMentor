import { describe, expect, it } from 'vitest'
import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { Position } from '../../src/board/position'
import {
  areaScore,
  findRegions,
  legalMoves,
  territoryScore,
} from '../../src/board/rules'

/**
 * Scoring primitives.
 *
 * The most important assertions here are the ones about what these functions
 * *refuse* to decide. `areaScore` assuming every stone is alive, and
 * `territoryScore` taking the dead set as a parameter, are the design — a test
 * that asserted a "correct" score for an unsettled position would be encoding a
 * guess as a requirement.
 */

/** Builds a position from an ASCII diagram. `.` empty, `X` black, `O` white. */
function fromDiagram(rows: string[]): Position {
  const size = rows.length as BoardSize
  const placements: { coord: Coord; player: Player }[] = []
  rows.forEach((row, y) => {
    Array.from(row).forEach((char, x) => {
      if (char === 'X') placements.push({ coord: { x, y }, player: 'black' })
      else if (char === 'O') placements.push({ coord: { x, y }, player: 'white' })
    })
  })
  return Position.empty(size).setup(placements)
}

const EMPTY_9 = [
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
]

describe('regions', () => {
  it('finds one region on an empty board, bordered by nobody', () => {
    const regions = findRegions(Position.empty(9))
    expect(regions).toHaveLength(1)
    expect(regions[0]?.points).toHaveLength(81)
    expect(regions[0]?.borders.size).toBe(0)
  })

  it('splits the board into regions along a wall', () => {
    // A full column of black splits the remaining empty points in two.
    const rows = EMPTY_9.map(() => '...X.....')
    const regions = findRegions(fromDiagram(rows))
    expect(regions).toHaveLength(2)
    expect(regions.map((r) => r.points.length).sort((a, b) => a - b)).toEqual([
      3 * 9,
      5 * 9,
    ])
    for (const region of regions) {
      expect(region.borders).toEqual(new Set(['black']))
    }
  })

  it('records both colours on a region they both touch', () => {
    const pos = fromDiagram([
      'X.O......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const regions = findRegions(pos)
    expect(regions).toHaveLength(1)
    expect(regions[0]?.borders).toEqual(new Set(['black', 'white']))
  })

  it('finds an enclosed single-point eye', () => {
    // Away from the edge on purpose. The same shape in the corner encloses the
    // corner point too — two single-point regions, and `find` picks whichever
    // the scan reaches first.
    const pos = fromDiagram([
      '....X....',
      '...X.X...',
      '....X....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const regions = findRegions(pos)
    const eyes = regions.filter((r) => r.points.length === 1)
    expect(eyes).toHaveLength(1)
    expect(eyes[0]?.points[0]).toEqual({ x: 4, y: 1 })
    expect(eyes[0]?.borders).toEqual(new Set(['black']))
  })

  it('does not merge regions across a diagonal gap', () => {
    // Diagonal connection is not connection: these two empty points are one
    // region because empties connect orthogonally through (0,1)... assert the
    // shape rather than assume it.
    const pos = fromDiagram([
      '.X.......',
      'X........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const regions = findRegions(pos)
    // (0,0) is cut off from the rest by (1,0) and (0,1).
    const corner = regions.find((r) => r.points.length === 1)
    expect(corner?.points[0]).toEqual({ x: 0, y: 0 })
    expect(regions).toHaveLength(2)
  })
})

describe('area score', () => {
  it('gives an empty board to nobody but applies komi', () => {
    // The trap: an empty board has one region bordered by neither colour. If it
    // counted as territory for someone, every new game would start decided.
    const score = areaScore(Position.empty(19), 6.5)
    expect(score.black).toBe(0)
    expect(score.white).toBe(0)
    expect(score.neutral).toBe(361)
    expect(score.lead).toBe(-6.5)
  })

  it('counts stones plus enclosed empty points', () => {
    // A lone white stone is load-bearing: without it the 72 remaining empty
    // points border only black, and the whole board reads as black's — which is
    // how the first version of this test came to expect 8 and get 81.
    const pos = fromDiagram([
      '..X......',
      '..X......',
      'XX.......',
      '.........',
      '.........',
      '.........',
      '.........',
      '........O',
      '.........',
    ])
    const score = areaScore(pos, 0)
    // Black: 4 stones + the 4 enclosed points (0,0),(1,0),(0,1),(1,1).
    expect(score.black).toBe(8)
    // White: its one stone. The big region borders both colours, so neutral.
    expect(score.white).toBe(1)
    expect(score.neutral).toBe(72)
  })

  it('counts a region touching both colours as neutral', () => {
    const pos = fromDiagram([
      'XXXXOOOOO',
      'XXXXOOOOO',
      'XXXX.OOOO',
      'XXXXOOOOO',
      'XXXXOOOOO',
      'XXXXOOOOO',
      'XXXXOOOOO',
      'XXXXOOOOO',
      'XXXXOOOOO',
    ])
    const score = areaScore(pos, 0)
    expect(score.neutral).toBe(1)
    expect(score.black).toBe(36)
    expect(score.white).toBe(44)
  })

  it('is an upper bound mid-game, not a score', () => {
    // Documents the limitation rather than asserting a "right" answer: two
    // lone stones facing each other produce a whole-board neutral region, so
    // neither side is credited with the framework they appear to have.
    const pos = fromDiagram([
      '.........',
      '..X......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '......O..',
      '.........',
    ])
    const score = areaScore(pos, 0)
    expect(score.black).toBe(1)
    expect(score.white).toBe(1)
    expect(score.neutral).toBe(79)
  })
})

describe('territory score', () => {
  it('counts enclosed points and existing prisoners', () => {
    // Same shape as the areaScore test, white stone included for the same
    // reason: it keeps the open area neutral instead of black's.
    const pos = fromDiagram([
      '..X......',
      '..X......',
      'XX.......',
      '.........',
      '.........',
      '.........',
      '.........',
      '........O',
      '.........',
    ])
    const score = territoryScore(pos, 0)
    // Territory only — stones on the board do not count under Japanese rules,
    // so black gets the 4 enclosed points and nothing for its 4 stones.
    expect(score.black).toBe(4)
    expect(score.white).toBe(0)
  })

  it('counts a dead stone twice: as territory and as a prisoner', () => {
    /**
     * The rule that implementations get wrong. A white stone inside black's
     * enclosed area, once agreed dead, both vacates its point (making it black
     * territory) and becomes a black prisoner — a two-point swing per stone.
     *
     *   . X . . .
     *   X O X . .     white (1,1) is dead inside black's shape
     *   . X . . .
     */
    const pos = fromDiagram([
      '.X.......',
      'XOX......',
      '.X.......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])

    const alive = territoryScore(pos, 0)
    const dead = territoryScore(pos, 0, [{ x: 1, y: 1 }])

    // Alive: the point is occupied, so it is not territory and not a prisoner.
    // Dead: +1 territory and +1 prisoner for black.
    expect(dead.black - alive.black).toBe(2)
  })

  it('ignores a dead coordinate that holds no stone', () => {
    // A caller error, but counting a phantom prisoner would be worse than
    // ignoring it.
    const pos = fromDiagram(EMPTY_9)
    const score = territoryScore(pos, 0, [{ x: 4, y: 4 }])
    expect(score.black).toBe(0)
    expect(score.white).toBe(0)
  })

  it('carries prisoners taken during play', () => {
    // The lone black stone at the far corner is load-bearing: without it the
    // board after the capture is all white, every empty point borders only
    // white, and the score is dominated by 77 points of "territory" that tell
    // you nothing about whether the capture was counted.
    const pos = fromDiagram([
      '.O.......',
      'OXO......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '........X',
    ])
    const captured = pos.place({ x: 1, y: 2 }, 'white')
    expect(captured.captured).toHaveLength(1)
    expect(captured.position.captures.white).toBe(1)

    const score = territoryScore(captured.position, 0)
    // Exact, not `toBeGreaterThanOrEqual(1)`: a loose lower bound stayed
    // satisfied even when a mutation zeroed `position.captures`, because white
    // scores elsewhere too. The 3 breaks down as 1 prisoner + 2 points of real
    // territory: (0,0), sealed by the stones at (1,0) and (0,1), and (1,1),
    // vacated by the capture and surrounded by white on all four sides.
    expect(score.white).toBe(3)
    expect(score.black).toBe(0)

    // Isolates the prisoner from the territory. Comparing against the
    // pre-capture position would not do it — removing the black stone changes
    // which regions are sealed, so that difference is 2, not 1. Instead: the
    // same stones with no capture on record scores exactly one less.
    const noPrisoners = Position.empty(9).setup(
      captured.position
        .toArray()
        .flatMap((stone, index) =>
          stone === null
            ? []
            : [{ coord: { x: index % 9, y: Math.floor(index / 9) }, player: stone }],
        ),
    )
    expect(noPrisoners.captures.white).toBe(0)
    expect(score.white - territoryScore(noPrisoners, 0).white).toBe(1)
  })

  it('does not infer dead stones on its own', () => {
    /**
     * The central design assertion. A lone white stone deep inside black's
     * area is dead to any human reader, and a heuristic would say so. This
     * function must not: with no dead set supplied, the stone stands.
     */
    const pos = fromDiagram([
      'XXXXXXXXX',
      'X.......X',
      'X...O...X',
      'X.......X',
      'XXXXXXXXX',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const score = territoryScore(pos, 0)
    // The white stone splits nothing and is not counted as dead, so black's
    // enclosed area excludes it and white is credited with no prisoners.
    expect(score.white).toBe(0)
    // And the region bordered by both colours is neutral rather than black's.
    expect(score.neutral).toBeGreaterThan(0)
  })
})

describe('legal moves', () => {
  it('offers every point on an empty board', () => {
    expect(legalMoves(Position.empty(9), 'black')).toHaveLength(81)
  })

  it('excludes occupied points', () => {
    const pos = fromDiagram([
      'X........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    expect(legalMoves(pos, 'white')).toHaveLength(80)
  })

  it('excludes suicide points', () => {
    const pos = fromDiagram([
      '.O.......',
      'O.O......',
      '.O.......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const black = legalMoves(pos, 'black')
    expect(black).not.toContainEqual({ x: 1, y: 1 })
    // White may fill its own eye — legal, if pointless.
    expect(legalMoves(pos, 'white')).toContainEqual({ x: 1, y: 1 })
  })

  it('excludes the ko point for the player it bans', () => {
    const ko = fromDiagram([
      '..OX.....',
      '.O.OX....',
      '..OX.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const afterBlack = ko.place({ x: 2, y: 1 }, 'black').position
    expect(afterBlack.koPoint).toEqual({ x: 3, y: 1 })
    expect(legalMoves(afterBlack, 'white')).not.toContainEqual({ x: 3, y: 1 })
  })
})

describe('no dead-end positions', () => {
  it('leaves every empty point legal for at least one side', () => {
    /**
     * The invariant behind `rules.ts` having no `isBoardExhausted`: an empty
     * point illegal for black requires every adjacent black group to have it as
     * their only liberty AND no adjacent white group to, and vice versa — which
     * together force the point to have no neighbours of either colour, making it
     * legal. See the note in rules.ts for the full argument.
     *
     * Asserted over near-full boards, where the claim is least obvious.
     */
    let seed = 20260807
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    let examined = 0
    for (let trial = 0; trial < 400; trial += 1) {
      const rows: string[] = []
      for (let y = 0; y < 9; y += 1) {
        let row = ''
        for (let x = 0; x < 9; x += 1) {
          const roll = rand()
          row += roll < 0.06 ? '.' : roll < 0.53 ? 'X' : 'O'
        }
        rows.push(row)
      }
      const pos = fromDiagram(rows)
      const black = legalMoves(pos, 'black')
      const white = legalMoves(pos, 'white')
      const legal = new Set(
        [...black, ...white].map((c) => `${String(c.x)},${String(c.y)}`),
      )
      for (let y = 0; y < 9; y += 1) {
        for (let x = 0; x < 9; x += 1) {
          if (!pos.isEmpty({ x, y })) continue
          examined += 1
          expect(legal.has(`${String(x)},${String(y)}`)).toBe(true)
        }
      }
    }
    // Guards the guard: a generator that produced no empty points would pass
    // the loop above vacuously.
    expect(examined).toBeGreaterThan(1000)
  })
})
