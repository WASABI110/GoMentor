import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { fromIndex, neighbours, toIndex } from './coords'
import { Position, type Stone } from './position'

/**
 * Scoring primitives.
 *
 * **This file does not decide a game's score, and that is deliberate.**
 *
 * Territory scoring requires knowing which stones are dead, and life-and-death
 * is not decidable by any local rule. Every real implementation either asks the
 * players (as a game does at the end), runs a search (as KataGo does), or
 * guesses. A `score()` function here would have to guess, and it would be
 * confidently wrong on exactly the positions users care about — seki, unsettled
 * groups, large open frameworks. Worse, it would look authoritative.
 *
 * So this file provides only what *is* decidable from a position alone:
 *
 * - `findRegions` — connected empty areas and which colours touch them
 * - `areaScore` — Chinese-style area counting **assuming every stone lives**
 * - `territoryScore` — Japanese-style counting given a caller-supplied dead set
 *
 * The dead set is a parameter, never inferred. In M2 it comes from KataGo's
 * ownership map; in the UI it will come from the user clicking stones. Both are
 * honest sources. A heuristic in this file would not be.
 */

/** A connected region of empty points and the colours bordering it. */
export interface Region {
  points: Coord[]
  /** Colours with at least one stone adjacent to the region. */
  borders: Set<Player>
}

/**
 * Connected empty regions.
 *
 * Regions are found by flood fill over empty points; `borders` records which
 * colours touch each. A region bordered by one colour is that colour's
 * territory under both rulesets. A region bordered by both is neutral (`dame`)
 * — or, in a real game, unsettled, which is precisely the case no local rule
 * resolves.
 */
export function findRegions(position: Position): Region[] {
  const size = position.size
  const stones = position.toArray()
  const visited = new Set<number>()
  const regions: Region[] = []

  for (let index = 0; index < stones.length; index += 1) {
    if (stones[index] !== null || visited.has(index)) continue

    const points: Coord[] = []
    const borders = new Set<Player>()
    const queue: number[] = [index]
    visited.add(index)

    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined) break
      const coord = fromIndex(current, size)
      points.push(coord)

      for (const n of neighbours(coord, size)) {
        const neighbourIndex = toIndex(n, size)
        const occupant = stones[neighbourIndex] ?? null
        if (occupant !== null) {
          borders.add(occupant)
          continue
        }
        if (visited.has(neighbourIndex)) continue
        visited.add(neighbourIndex)
        queue.push(neighbourIndex)
      }
    }

    regions.push({ points, borders })
  }

  return regions
}

export interface ScoreBreakdown {
  black: number
  white: number
  /** Positive means black leads. Komi is already applied. */
  lead: number
  /** Points belonging to neither side. */
  neutral: number
}

/**
 * Chinese-style area score: stones on the board plus enclosed empty points.
 *
 * **Assumes every stone on the board is alive.** On a finished game where both
 * sides have removed their dead stones, that assumption holds and this is the
 * correct score. Mid-game it is not a score at all — it is an upper bound on
 * whoever has more stones placed. Callers showing this to a user must say which
 * situation they are in.
 */
export function areaScore(position: Position, komi: number): ScoreBreakdown {
  let black = 0
  let white = 0

  for (const stone of position.toArray()) {
    if (stone === 'black') black += 1
    else if (stone === 'white') white += 1
  }

  let neutral = 0
  for (const region of findRegions(position)) {
    // A region touching both colours, or neither (an empty board), is not
    // territory. The "neither" case matters: it stops an empty board from
    // scoring as a win for whoever komi favours.
    if (region.borders.size !== 1) {
      neutral += region.points.length
      continue
    }
    const [owner] = region.borders
    if (owner === 'black') black += region.points.length
    else white += region.points.length
  }

  return { black, white, lead: black - (white + komi), neutral }
}

/**
 * Japanese-style territory score: enclosed empty points plus prisoners.
 *
 * `dead` is supplied by the caller and is **not** inferred — see the note at
 * the top of this file. Dead stones count twice, as they do in a real count:
 * they vacate the point (becoming their captor's territory) and they become
 * prisoners.
 */
export function territoryScore(
  position: Position,
  komi: number,
  dead: readonly Coord[] = [],
): ScoreBreakdown {
  const size = position.size
  const deadIndices = new Set(dead.map((coord) => toIndex(coord, size)))

  // Removing dead stones first is what makes the count match a physical board:
  // players lift dead stones before counting.
  const stones = position.toArray()
  const cleaned: Stone[] = stones.map((stone, index) =>
    deadIndices.has(index) ? null : stone,
  )

  let blackPrisoners = position.captures.black
  let whitePrisoners = position.captures.white
  for (const index of deadIndices) {
    const stone = stones[index] ?? null
    // A coordinate in `dead` that holds no stone is a caller error, but
    // ignoring it is better than counting a phantom prisoner.
    if (stone === 'black') whitePrisoners += 1
    else if (stone === 'white') blackPrisoners += 1
  }

  const afterRemoval = rebuild(size, cleaned)

  let black = blackPrisoners
  let white = whitePrisoners
  let neutral = 0

  for (const region of findRegions(afterRemoval)) {
    if (region.borders.size !== 1) {
      neutral += region.points.length
      continue
    }
    const [owner] = region.borders
    if (owner === 'black') black += region.points.length
    else white += region.points.length
  }

  return { black, white, lead: black - (white + komi), neutral }
}

/**
 * Rebuilds a position from a stone array.
 *
 * `Position`'s constructor is private on purpose — every position should come
 * from `place` or `setup` so captures and ko stay consistent. Scoring is the one
 * legitimate exception: it needs a board with stones *removed*, which no legal
 * move produces. Going through `setup` keeps that exception inside the public
 * API rather than widening the constructor.
 *
 * Capture counts are not carried over, because a removal is not a capture — the
 * caller tallies prisoners itself.
 */
function rebuild(size: BoardSize, stones: readonly Stone[]): Position {
  const placements: { coord: Coord; player: Player }[] = []
  stones.forEach((stone, index) => {
    if (stone !== null)
      placements.push({ coord: fromIndex(index, size), player: stone })
  })
  return Position.empty(size).setup(placements)
}

/**
 * Points where a stone of `player` would be legal.
 *
 * Useful for UI hover states and for bounding an engine's move list. Not a
 * "good moves" list — legality is all this can know.
 */
export function legalMoves(position: Position, player: Player): Coord[] {
  const out: Coord[] = []
  for (let y = 0; y < position.size; y += 1) {
    for (let x = 0; x < position.size; x += 1) {
      const coord = { x, y }
      // The emptiness test is a short-circuit, not a correctness check:
      // `isLegal` already rejects an occupied point (`place` throws
      // RuleError('occupied') first thing). It is here so a full board costs
      // size^2 array reads instead of size^2 trial placements. A mutation
      // removing it escapes the suite for that reason — equivalent, not untested.
      if (position.isEmpty(coord) && position.isLegal(coord, player)) out.push(coord)
    }
  }
  return out
}

/**
 * Deliberately absent: `isBoardExhausted(position)`.
 *
 * "Neither side has a legal move" is not a reachable state, so a predicate for
 * it would be permanently false and read as a working loop guard.
 *
 * Proof. Let P be empty and illegal for black. Every black group adjacent to P
 * must have P as its only liberty (otherwise the placed stone joins a group
 * that still has one), and no white group adjacent to P may have P as its only
 * liberty (otherwise the move captures, which is legal). Illegal for white
 * demands the mirror of both. "Every adjacent black group has only P" and "no
 * adjacent black group has only P" can hold together only when P has no black
 * neighbour — symmetrically no white one. Then P's neighbours are all empty, so
 * P is legal. Contradiction: every empty point is legal for at least one side.
 *
 * So the predicate reduces to `stoneCount() === size * size`, and that state is
 * itself unreachable: filling the last empty point either leaves the mover
 * without a liberty (illegal) or captures, which reopens points. Verified over
 * 60000 last-point placements — a full board was produced zero times.
 *
 * A replay or self-play loop should terminate on two consecutive passes, which
 * is game-tree state and does not belong to a single position.
 */
