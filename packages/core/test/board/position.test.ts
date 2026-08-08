import { describe, expect, it } from 'vitest'
import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { Position, RuleError } from '../../src/board/position'

/**
 * Board rules over hand-built positions.
 *
 * Example-based rather than property-based here: capture resolution, suicide,
 * ko, and multi-group capture are specific known-hard cases, and the value is
 * in constructing exactly the shape that breaks a naive implementation.
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

function diagramOf(position: Position): string[] {
  const rows: string[] = []
  for (let y = 0; y < position.size; y++) {
    let row = ''
    for (let x = 0; x < position.size; x++) {
      const stone = position.at({ x, y })
      row += stone === 'black' ? 'X' : stone === 'white' ? 'O' : '.'
    }
    rows.push(row)
  }
  return rows
}

describe('groups and liberties', () => {
  it('finds a single stone with four liberties', () => {
    const pos = fromDiagram([
      '.........',
      '.........',
      '.........',
      '.........',
      '....X....',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const group = pos.groupAt({ x: 4, y: 4 })
    expect(group?.stones).toHaveLength(1)
    expect(group?.liberties).toHaveLength(4)
  })

  it('connects orthogonally but not diagonally', () => {
    const pos = fromDiagram([
      '.........',
      '.XX......',
      '...X.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    // (1,1)-(2,1) are connected; (3,2) touches (2,1) only diagonally.
    expect(pos.groupAt({ x: 1, y: 1 })?.stones).toHaveLength(2)
    expect(pos.groupAt({ x: 3, y: 2 })?.stones).toHaveLength(1)
  })

  it('counts a shared liberty once, not once per adjacent stone', () => {
    const pos = fromDiagram([
      'XX.......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    // Corner pair: liberties are (2,0), (0,1), (1,1) — three, not four.
    const group = pos.groupAt({ x: 0, y: 0 })
    expect(group?.liberties).toHaveLength(3)
  })

  it('returns null on an empty point', () => {
    expect(Position.empty(9).groupAt({ x: 0, y: 0 })).toBeNull()
  })
})

describe('capture', () => {
  it('captures a single stone with one liberty left', () => {
    const pos = fromDiagram([
      '.O.......',
      'OXO......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    // Black (1,1) is surrounded on three sides; its last liberty is (1,2).
    const before = pos.groupAt({ x: 1, y: 1 })
    expect(before?.liberties).toEqual([{ x: 1, y: 2 }])

    const result = pos.place({ x: 1, y: 2 }, 'white')

    expect(result.captured).toEqual([{ x: 1, y: 1 }])
    expect(result.position.at({ x: 1, y: 1 })).toBeNull()
    expect(result.position.captures.white).toBe(1)
  })

  it('captures a multi-stone group as a unit', () => {
    const pos = fromDiagram([
      '.OO......',
      'OXXO.....',
      '.OO......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    // Fully enclosed already: the pair reads as a single zero-liberty group,
    // which is what makes it capturable as a unit rather than stone by stone.
    const group = pos.groupAt({ x: 1, y: 1 })
    expect(group?.stones).toHaveLength(2)
    expect(group?.liberties).toHaveLength(0)
  })

  it('captures two separate groups with one move', () => {
    const pos = fromDiagram([
      'X.XO.....',
      'OOO......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    // Both black stones must be down to the single shared liberty (1,0), and
    // nothing else may share it — otherwise the count is not 2.
    expect(pos.groupAt({ x: 0, y: 0 })?.liberties).toEqual([{ x: 1, y: 0 }])
    expect(pos.groupAt({ x: 2, y: 0 })?.liberties).toEqual([{ x: 1, y: 0 }])

    const result = pos.place({ x: 1, y: 0 }, 'white')

    expect(result.captured).toHaveLength(2)
    expect(result.position.at({ x: 0, y: 0 })).toBeNull()
    expect(result.position.at({ x: 2, y: 0 })).toBeNull()
    expect(result.position.captures.white).toBe(2)
  })

  it('captures two groups flanking the played stone on opposite sides', () => {
    /**
     * Both white stones share a single liberty at the played point, on
     * opposite sides of it. A capture loop that stopped after the first group,
     * or that let one removal affect the next group's liberty count, would
     * take only one stone here.
     *
     *      0 1 2 3 4
     *   0  . X . X .
     *   1  X O . O X     black plays (2,1)
     *   2  . X . X .
     */
    const pos = fromDiagram([
      '.X.X.....',
      'XO.OX....',
      '.X.X.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])

    expect(pos.groupAt({ x: 1, y: 1 })?.liberties).toEqual([{ x: 2, y: 1 }])
    expect(pos.groupAt({ x: 3, y: 1 })?.liberties).toEqual([{ x: 2, y: 1 }])

    const result = pos.place({ x: 2, y: 1 }, 'black')

    expect(result.captured).toHaveLength(2)
    expect(result.position.at({ x: 1, y: 1 })).toBeNull()
    expect(result.position.at({ x: 3, y: 1 })).toBeNull()
    expect(result.position.captures.black).toBe(2)
  })

  it('does not capture a group that still has a liberty', () => {
    const pos = fromDiagram([
      '.O.......',
      'OX.......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    // Fills (1,2) instead of (2,1); black keeps (2,1).
    const result = pos.place({ x: 1, y: 2 }, 'white')

    expect(result.captured).toEqual([])
    expect(result.position.at({ x: 1, y: 1 })).toBe('black')
  })
})

describe('suicide', () => {
  it('rejects filling your own last liberty', () => {
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
    // (1,1) is surrounded by white; a lone black stone there has no liberty.
    expect(() => pos.place({ x: 1, y: 1 }, 'black')).toThrow(RuleError)

    try {
      pos.place({ x: 1, y: 1 }, 'black')
    } catch (error) {
      expect((error as RuleError).reason).toBe('suicide')
    }
  })

  it('allows a move that fills your last liberty but captures', () => {
    // This is the case that ordering gets wrong. Black at (0,0) would have no
    // liberty, except that placing there captures the white group first.
    const pos = fromDiagram([
      '.OX......',
      'OOX......',
      'XXX......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const white = pos.groupAt({ x: 1, y: 0 })
    expect(white?.stones).toHaveLength(3)
    expect(white?.liberties).toEqual([{ x: 0, y: 0 }])

    const result = pos.place({ x: 0, y: 0 }, 'black')

    expect(result.captured).toHaveLength(3)
    expect(result.position.at({ x: 0, y: 0 })).toBe('black')
  })

  it('allows extending into a shared liberty', () => {
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
    expect(pos.isLegal({ x: 1, y: 0 }, 'black')).toBe(true)
  })
})

describe('ko', () => {
  /** The canonical ko shape: white (3,1) has exactly one liberty at (2,1). */
  /**
   * Textbook ko. Black plays (2,1), capturing the lone white stone at (3,1);
   * the capturing stone itself has exactly one liberty, so white could
   * immediately recapture — which is what the ko rule forbids.
   *
   *      0 1 2 3 4
   *   0  . . O X .
   *   1  . O . O X     (2,1) is the point black plays
   *   2  . . O X .
   *
   * White (3,1) is enclosed by black on (3,0), (4,1), (3,2), leaving only
   * (2,1). The new black stone is enclosed by white on (2,0), (1,1), (2,2),
   * leaving only the point it just captured.
   */
  const koShape = [
    '..OX.....',
    '.O.OX....',
    '..OX.....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
  ]

  it('bans immediate recapture at the captured point', () => {
    const ko = fromDiagram(koShape)

    // Assert the shape is what the comment claims before testing the rule —
    // a wrong diagram would otherwise fail confusingly, blaming the rule.
    const victim = ko.groupAt({ x: 3, y: 1 })
    expect(victim?.player, 'the victim must be white').toBe('white')
    expect(victim?.stones, 'the victim must be a lone stone').toHaveLength(1)
    expect(victim?.liberties, 'the victim must have exactly one liberty').toEqual([
      { x: 2, y: 1 },
    ])

    const afterBlack = ko.place({ x: 2, y: 1 }, 'black')
    expect(afterBlack.captured).toEqual([{ x: 3, y: 1 }])

    // The conditions for basic ko: one stone taken, and the capturing stone is
    // itself alone with a single liberty.
    const own = afterBlack.position.groupAt({ x: 2, y: 1 })
    expect(own?.stones).toHaveLength(1)
    expect(own?.liberties).toHaveLength(1)
    expect(afterBlack.position.koPoint).toEqual({ x: 3, y: 1 })

    expect(() => afterBlack.position.place({ x: 3, y: 1 }, 'white')).toThrow(RuleError)
    try {
      afterBlack.position.place({ x: 3, y: 1 }, 'white')
    } catch (error) {
      expect((error as RuleError).reason).toBe('ko')
    }
  })

  it('clears the ko ban after any other move', () => {
    const afterBlack = fromDiagram(koShape).place({ x: 2, y: 1 }, 'black')
    expect(afterBlack.position.koPoint).not.toBeNull()

    // White plays elsewhere (a ko threat), which lifts the ban.
    const elsewhere = afterBlack.position.place({ x: 7, y: 7 }, 'white')
    expect(elsewhere.position.koPoint).toBeNull()
    expect(elsewhere.position.isLegal({ x: 3, y: 1 }, 'white')).toBe(true)
  })

  it('does not set a ko point for a multi-stone capture', () => {
    const pos = fromDiagram([
      'X.XO.....',
      'OOO......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const result = pos.place({ x: 1, y: 0 }, 'white')
    expect(result.captured).toHaveLength(2)
    // Two stones taken cannot be a simple one-point recapture.
    expect(result.position.koPoint).toBeNull()
  })
})

describe('occupied points', () => {
  it('rejects playing on an existing stone of either colour', () => {
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
    expect(() => pos.place({ x: 0, y: 0 }, 'white')).toThrow(RuleError)
    expect(() => pos.place({ x: 0, y: 0 }, 'black')).toThrow(RuleError)
    try {
      pos.place({ x: 0, y: 0 }, 'white')
    } catch (error) {
      expect((error as RuleError).reason).toBe('occupied')
    }
  })
})

describe('immutability', () => {
  it('does not mutate the position it was called on', () => {
    const before = fromDiagram([
      '.O.......',
      'OX.......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ])
    const snapshot = diagramOf(before)

    before.place({ x: 2, y: 1 }, 'white')

    // A mutating implementation aliases positions across the move tree, which
    // shows up as "stepping back through a game corrupts it".
    expect(diagramOf(before)).toEqual(snapshot)
    expect(before.at({ x: 1, y: 1 })).toBe('black')
    expect(before.captures.white).toBe(0)
  })

  it('keeps independent positions independent across a sequence', () => {
    const p0 = Position.empty(9)
    const p1 = p0.place({ x: 0, y: 0 }, 'black').position
    const p2 = p1.place({ x: 1, y: 1 }, 'white').position

    expect(p0.stoneCount()).toBe(0)
    expect(p1.stoneCount()).toBe(1)
    expect(p2.stoneCount()).toBe(2)
  })
})

describe('setup stones', () => {
  it('places handicap stones without capture resolution', () => {
    const pos = Position.empty(9).setup([
      { coord: { x: 2, y: 2 }, player: 'black' },
      { coord: { x: 6, y: 6 }, player: 'black' },
    ])
    expect(pos.stoneCount()).toBe(2)
    expect(pos.at({ x: 2, y: 2 })).toBe('black')
  })
})
