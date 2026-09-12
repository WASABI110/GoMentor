import { describe, expect, it } from 'vitest'
import type { BoardSize } from '@gomentor/shared'
import {
  classifyGame,
  OPENING_MOVES,
  ENDGAME_START,
  MAJOR_LOSS,
  CONTACT_DISTANCE,
  BLINDSPOT_DISTANCE,
  ENDGAME_SMALL_LOSS,
  ENDGAME_PRECISION_FLOOR,
  type AnalysisRowInput,
  type ClassifiableGame,
} from '../../src/profile/categories'

/**
 * The four-category classifier. Each threshold is a recorded decision (M4
 * design §3), so the suite pins both sides of every boundary — a mark that
 * fires one point past a threshold is exactly as wrong as one that misses it.
 *
 * Fixtures pass instead of playing where position does not matter: a pass
 * advances the move counter without touching the board, which keeps the
 * band-placement tests (move 25 vs 26, 150 vs 151) free of noise stones.
 */

function row(
  moveNumber: number,
  loss: number,
  candidate: string | null = null,
): AnalysisRowInput {
  return { moveNumber, winrateLoss: loss, topCandidateCoord: candidate }
}

/** `n` consecutive passes — an empty stretch of moves. */
function passes(n: number): { player: 'black' | 'white'; coord: null }[] {
  return Array.from({ length: n }, (_, i) => ({
    player: i % 2 === 0 ? ('black' as const) : ('white' as const),
    coord: null,
  }))
}

function game(
  moves: readonly { player: string; coord: { x: number; y: number } | null }[],
  setup: { black: { x: number; y: number }[]; white: { x: number; y: number }[] } = {
    black: [],
    white: [],
  },
) {
  return {
    meta: { boardSize: 19 as BoardSize },
    setup,
    // The fixtures type players as string so unannotated arrays typecheck; the
    // cast is the single narrowing point, and every string here is a literal.
    moves: moves as ClassifiableGame['moves'],
  }
}

describe('threshold constants', () => {
  // Pinned so a retune is a deliberate diff, and so the schema-facing
  // documentation cannot silently drift from the behaviour.
  it('are the recorded design values', () => {
    expect(OPENING_MOVES).toBe(25)
    expect(ENDGAME_START).toBe(150)
    expect(MAJOR_LOSS).toBe(0.05)
    expect(CONTACT_DISTANCE).toBe(2)
    expect(BLINDSPOT_DISTANCE).toBe(5)
    expect(ENDGAME_SMALL_LOSS).toBe(0.015)
    expect(ENDGAME_PRECISION_FLOOR).toBeCloseTo(0.045, 12)
  })
})

describe('opening-direction', () => {
  it('marks a major loss inside the first 25 moves', () => {
    const marks = classifyGame(game([{ player: 'black', coord: { x: 3, y: 3 } }]), [
      row(1, 0.06),
    ])
    expect(marks).toEqual([
      { moveNumber: 1, category: 'opening-direction', loss: 0.06 },
    ])
  })

  it('fires exactly at the major-loss bar, not below it', () => {
    const at = classifyGame(game([{ player: 'black', coord: { x: 3, y: 3 } }]), [
      row(1, MAJOR_LOSS),
    ])
    expect(at).toHaveLength(1)
    const below = classifyGame(game([{ player: 'black', coord: { x: 3, y: 3 } }]), [
      row(1, MAJOR_LOSS - 0.001),
    ])
    expect(below).toHaveLength(0)
  })

  it('does not fire from move 26 on', () => {
    const moves = [...passes(OPENING_MOVES), { player: 'black', coord: { x: 3, y: 3 } }]
    const marks = classifyGame(game(moves), [row(OPENING_MOVES + 1, 0.2)])
    expect(marks).toEqual([])
  })

  it('fires on the band’s last move (25), not only early in the opening', () => {
    const moves = [
      ...passes(OPENING_MOVES - 1),
      { player: 'black', coord: { x: 3, y: 3 } },
    ]
    const marks = classifyGame(game(moves), [row(OPENING_MOVES, 0.2)])
    expect(marks).toEqual([
      { moveNumber: OPENING_MOVES, category: 'opening-direction', loss: 0.2 },
    ])
  })
})

describe('middlegame-fighting', () => {
  // One white stone at (9,9) — "K10" — seeds the contact geometry; the tested
  // black move lands at a controlled Chebyshev distance from it.
  const setup = { black: [], white: [{ x: 9, y: 9 }] }

  it('marks a loss in a contact fight within the middlegame band', () => {
    // Move 26, Chebyshev distance 2 from the white stone.
    const moves = [...passes(25), { player: 'black', coord: { x: 11, y: 9 } }]
    const marks = classifyGame(game(moves, setup), [row(26, 0.01)])
    expect(marks).toEqual([
      { moveNumber: 26, category: 'middlegame-fighting', loss: 0.01 },
    ])
  })

  it('does not mark a quiet position (distance 3)', () => {
    const moves = [...passes(25), { player: 'black', coord: { x: 12, y: 9 } }]
    expect(classifyGame(game(moves, setup), [row(26, 0.01)])).toEqual([])
  })

  it('measures the board before the move, not after', () => {
    // (10,9) is adjacent to the white stone. The distance the category asks
    // about is the fight the move ENTERED — the stone is not its own opponent.
    const moves = [...passes(25), { player: 'black', coord: { x: 10, y: 9 } }]
    const marks = classifyGame(game(moves, setup), [row(26, 0.01)])
    expect(marks).toHaveLength(1)
  })

  it('does not mark a zero-loss move, even in contact', () => {
    const moves = [...passes(25), { player: 'black', coord: { x: 10, y: 9 } }]
    expect(classifyGame(game(moves, setup), [row(26, 0)])).toEqual([])
  })

  it('does not mark an endgame contact move (the band ends at 150)', () => {
    const moves = [
      ...passes(ENDGAME_START),
      { player: 'black', coord: { x: 10, y: 9 } },
    ]
    expect(classifyGame(game(moves, setup), [row(ENDGAME_START + 1, 0.01)])).toEqual([])
  })

  it('fires on the band’s last move (150)', () => {
    const moves = [
      ...passes(ENDGAME_START - 1),
      { player: 'black', coord: { x: 10, y: 9 } },
    ]
    const marks = classifyGame(game(moves, setup), [row(ENDGAME_START, 0.01)])
    expect(marks).toEqual([
      { moveNumber: ENDGAME_START, category: 'middlegame-fighting', loss: 0.01 },
    ])
  })

  it('reads the distance as Chebyshev, not Manhattan', () => {
    // (11,10) is Chebyshev 2 from the white stone (dx 2, dy 1) — in contact —
    // but Manhattan 3. A Manhattan reading would leave it unmarked.
    const moves = [...passes(25), { player: 'black', coord: { x: 11, y: 10 } }]
    const marks = classifyGame(game(moves, setup), [row(26, 0.01)])
    expect(marks).toEqual([
      { moveNumber: 26, category: 'middlegame-fighting', loss: 0.01 },
    ])
  })
})

describe('endgame-precision', () => {
  function endgameMoves(count: number) {
    return [
      ...passes(ENDGAME_START),
      ...Array.from({ length: count }, (_, i) => ({
        player: i % 2 === 0 ? 'black' : 'white',
        coord: { x: (i * 3) % 19, y: (i * 5) % 19 },
      })),
    ]
  }

  it('marks three small slips whose total crosses the floor', () => {
    const marks = classifyGame(game(endgameMoves(3)), [
      row(151, 0.02),
      row(152, 0.02),
      row(153, 0.02),
    ])
    expect(marks.map((mark) => mark.moveNumber)).toEqual([151, 152, 153])
    expect(marks.every((mark) => mark.category === 'endgame-precision')).toBe(true)
  })

  it('marks the slips at exactly the floor (3 × 1.5 points)', () => {
    const marks = classifyGame(game(endgameMoves(3)), [
      row(151, ENDGAME_SMALL_LOSS),
      row(152, ENDGAME_SMALL_LOSS),
      row(153, ENDGAME_SMALL_LOSS),
    ])
    expect(marks).toHaveLength(3)
  })

  it('stays silent below the floor — one or two slips are noise', () => {
    const two = classifyGame(game(endgameMoves(2)), [row(151, 0.02), row(152, 0.02)])
    expect(two).toEqual([])
  })

  it('starts after move 150 — a small loss on move 150 is not endgame', () => {
    const moves = [
      ...passes(ENDGAME_START - 1),
      { player: 'black', coord: { x: 3, y: 3 } },
      { player: 'white', coord: { x: 9, y: 9 } },
      { player: 'black', coord: { x: 10, y: 10 } },
    ]
    // Moves 151–152 cross the small-slip floor on their own (0.05 ≥ 3 × 1.5),
    // and move 150 sits ON the band edge with a small loss that correctly does
    // not count toward the floor or get marked; a mutant that includes move 150
    // marks all three.
    const marks = classifyGame(game(moves), [
      row(ENDGAME_START, 0.02),
      row(ENDGAME_START + 1, 0.03),
      row(ENDGAME_START + 2, 0.02),
    ])
    expect(marks.map((mark) => mark.moveNumber)).toEqual([
      ENDGAME_START + 1,
      ENDGAME_START + 2,
    ])
  })

  it('does not count a major endgame loss toward the small-slip floor', () => {
    // A 6-point blunder is a different failure mode than three 2-point slips;
    // it belongs to blindspot when the geometry says so, not to precision.
    const marks = classifyGame(game(endgameMoves(2)), [row(151, 0.06), row(152, 0.02)])
    expect(marks).toEqual([])
  })
})

describe('whole-board-blindspot', () => {
  // The missed candidate lives on row k−1 (the batch tier's indexing contract):
  // K10 = (9,9) is what the mover of move k saw. Distance is Chebyshev.
  function blindspotMoves(played: { x: number; y: number }) {
    return [
      ...passes(25),
      { player: 'black', coord: { x: 3, y: 3 } }, // move 26: the advice row
      { player: 'white', coord: played }, // move 27: the tested move
    ]
  }
  const rows = (playedLoss: number) => [row(26, 0, 'K10'), row(27, playedLoss)]

  it('marks a major loss far from the advice the mover saw', () => {
    // D4 = (3,15): Chebyshev distance from (9,9) is max(6,6) = 6 ≥ 5.
    const marks = classifyGame(game(blindspotMoves({ x: 3, y: 15 })), rows(0.06))
    expect(marks).toEqual([
      { moveNumber: 27, category: 'whole-board-blindspot', loss: 0.06 },
    ])
  })

  it('fires exactly at the blindspot distance, not below it', () => {
    // P10 = (14,9): Chebyshev distance 5 from K10 (9,9).
    const at = classifyGame(game(blindspotMoves({ x: 14, y: 9 })), rows(0.06))
    expect(at).toHaveLength(1)
    // O10 = (13,9): distance 4.
    const below = classifyGame(game(blindspotMoves({ x: 13, y: 9 })), rows(0.06))
    expect(below).toEqual([])
  })

  it('fires at exactly the major-loss bar', () => {
    const marks = classifyGame(game(blindspotMoves({ x: 3, y: 15 })), rows(MAJOR_LOSS))
    expect(marks).toHaveLength(1)
  })

  it('measures Chebyshev, not Manhattan, on the blindspot axis', () => {
    // (13,10) from K10: Chebyshev 4 (no mark), Manhattan 6 (a Manhattan
    // mutant would mark it).
    const below = classifyGame(game(blindspotMoves({ x: 13, y: 10 })), rows(0.06))
    expect(below).toEqual([])
  })

  it('does not mark a sub-major loss, however far the miss', () => {
    const marks = classifyGame(
      game(blindspotMoves({ x: 3, y: 15 })),
      rows(MAJOR_LOSS - 0.001),
    )
    expect(marks).toEqual([])
  })

  it('does not mark when the advice was a pass or absent', () => {
    const passing = [row(26, 0, 'pass'), row(27, 0.06)]
    expect(classifyGame(game(blindspotMoves({ x: 3, y: 15 })), passing)).toEqual([])
    const absent = [row(27, 0.06)]
    expect(classifyGame(game(blindspotMoves({ x: 3, y: 15 })), absent)).toEqual([])
  })

  it('treats move 1 as unmarkable — there is no persisted candidate before it', () => {
    const marks = classifyGame(game([{ player: 'black', coord: { x: 3, y: 3 } }]), [
      row(1, 0.3),
    ])
    expect(marks).toEqual([{ moveNumber: 1, category: 'opening-direction', loss: 0.3 }])
  })
})

describe('the replay walk', () => {
  it('stops the walk at an illegal move; the illegal move itself is still judged', () => {
    // Row k's geometry reads the board BEFORE move k — vouchable as soon as
    // moves 1..k−1 are legal, so the illegal move itself is classified. The
    // walk ends when trying to place it: no LATER move's pre-board exists.
    const moves = [
      { player: 'black', coord: { x: 9, y: 9 } },
      { player: 'white', coord: { x: 9, y: 9 } }, // occupied — the walk ends here
      { player: 'black', coord: { x: 10, y: 10 } },
    ]
    const marks = classifyGame(game(moves), [row(1, 0.06), row(2, 0.2), row(3, 0.2)])
    expect(marks).toEqual([
      { moveNumber: 1, category: 'opening-direction', loss: 0.06 },
      { moveNumber: 2, category: 'opening-direction', loss: 0.2 },
    ])
  })

  it('never marks a pass — a pass has no point to classify', () => {
    const marks = classifyGame(game([{ player: 'black', coord: null }]), [row(1, 0.06)])
    expect(marks).toEqual([])
  })

  it('ignores rows beyond the record (a stale or damaged pairing)', () => {
    const marks = classifyGame(game([{ player: 'black', coord: { x: 3, y: 3 } }]), [
      row(1, 0.01),
      row(2, 0.3),
    ])
    expect(marks).toEqual([])
  })

  it('treats a garbled candidate coordinate as no candidate, not a crash', () => {
    const moves = [
      ...passes(25),
      { player: 'black', coord: { x: 3, y: 3 } },
      { player: 'white', coord: { x: 3, y: 15 } },
    ]
    const marks = classifyGame(game(moves), [row(26, 0, 'Z99'), row(27, 0.06)])
    expect(marks).toEqual([])
  })

  it('handles a full-length record in milliseconds', () => {
    // Row-major placement: 300 distinct points, no captures, no suicides —
    // every stone's right (or below, at the row end) neighbour is still empty,
    // so the walk runs the full record legally.
    const moves = Array.from({ length: 300 }, (_, i) => ({
      player: i % 2 === 0 ? 'black' : 'white',
      coord: { x: i % 19, y: Math.floor(i / 19) },
    }))
    const rows = Array.from({ length: 300 }, (_, i) =>
      row(i + 1, 0.001 + (i % 7) * 0.01),
    )
    const start = performance.now()
    const marks = classifyGame(game(moves), rows)
    const elapsed = performance.now() - start
    expect(marks.length).toBeGreaterThan(0)
    // The design's claim (pure core, ms-level) — a generous bound that fails
    // only if the classifier stops being a single pass over the game.
    expect(elapsed).toBeLessThan(500)
  })
})

describe('category composition', () => {
  it('a move can carry several marks', () => {
    // A major loss in contact during the middlegame: fighting AND blindspot.
    const setup = { black: [], white: [{ x: 9, y: 9 }] }
    const moves = [
      ...passes(25),
      { player: 'black', coord: { x: 3, y: 3 } }, // move 26 (advice row)
      { player: 'white', coord: { x: 2, y: 2 } }, // move 27: the tested move
    ]
    // Move 27 (white) is in contact with black's (3,3) — distance 1 → fighting.
    // The advice it ignored, K10 (9,9), is Chebyshev 6 away → blindspot.
    const marks = classifyGame(game(moves, setup), [row(26, 0, 'K10'), row(27, 0.06)])
    const categories = marks
      .filter((mark) => mark.moveNumber === 27)
      .map((mark) => mark.category)
    expect(categories).toContain('middlegame-fighting')
    expect(categories).toContain('whole-board-blindspot')
  })
})
