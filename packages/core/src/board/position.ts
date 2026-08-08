import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { coordsEqual, neighbours, toIndex } from './coords'

/**
 * Immutable board positions.
 *
 * `place()` returns a new position rather than mutating. The move tree holds
 * many positions that share history, and mutation would alias them into each
 * other — a bug that surfaces as "stepping back through a game corrupts it".
 */

export type Stone = Player | null

export class RuleError extends Error {
  readonly reason: 'occupied' | 'suicide' | 'ko' | 'out_of_bounds'

  constructor(reason: RuleError['reason'], message: string) {
    super(message)
    this.name = 'RuleError'
    this.reason = reason
  }
}

export interface Group {
  player: Player
  stones: Coord[]
  liberties: Coord[]
}

export interface PlaceResult {
  position: Position
  /** Stones removed by this move. Empty for a non-capturing move. */
  captured: Coord[]
}

export class Position {
  readonly size: BoardSize
  /** Row-major, length size². */
  private readonly stones: readonly Stone[]
  /**
   * The single point banned by the ko rule, or null.
   *
   * This implements *basic* ko (simple, one-point recapture), which is what
   * SGF files and KataGo both assume by default. Superko (positional or
   * situational) needs full position history and is deliberately not here —
   * adding it silently would change which games parse as legal.
   */
  readonly koPoint: Coord | null
  /** Prisoners taken so far, for scoring. */
  readonly captures: { black: number; white: number }

  private constructor(
    size: BoardSize,
    stones: readonly Stone[],
    koPoint: Coord | null,
    captures: { black: number; white: number },
  ) {
    this.size = size
    this.stones = stones
    this.koPoint = koPoint
    this.captures = captures
  }

  static empty(size: BoardSize): Position {
    return new Position(size, new Array<Stone>(size * size).fill(null), null, {
      black: 0,
      white: 0,
    })
  }

  at(coord: Coord): Stone {
    return this.stones[toIndex(coord, this.size)] ?? null
  }

  isEmpty(coord: Coord): boolean {
    return this.at(coord) === null
  }

  /** The connected group at `coord`, with its liberties. Null on an empty point. */
  groupAt(coord: Coord): Group | null {
    const player = this.at(coord)
    if (player === null) return null

    const stones: Coord[] = []
    const liberties: Coord[] = []
    const seen = new Set<number>()
    const libertySeen = new Set<number>()
    const queue: Coord[] = [coord]
    seen.add(toIndex(coord, this.size))

    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined) break
      stones.push(current)

      for (const n of neighbours(current, this.size)) {
        const index = toIndex(n, this.size)
        const occupant = this.stones[index] ?? null

        if (occupant === null) {
          if (!libertySeen.has(index)) {
            libertySeen.add(index)
            liberties.push(n)
          }
        } else if (occupant === player && !seen.has(index)) {
          seen.add(index)
          queue.push(n)
        }
      }
    }

    return { player, stones, liberties }
  }

  /**
   * Places a stone, resolving captures.
   *
   * Order matters and is not arbitrary: the stone goes down first, then
   * opponent groups are checked for capture, and only then is the mover's own
   * group checked for suicide. Reversing the last two would reject a move that
   * is legal precisely *because* it captures.
   */
  place(coord: Coord, player: Player): PlaceResult {
    if (!this.isEmpty(coord)) {
      throw new RuleError(
        'occupied',
        `point (${String(coord.x)},${String(coord.y)}) is occupied`,
      )
    }
    if (coordsEqual(this.koPoint, coord)) {
      throw new RuleError(
        'ko',
        `point (${String(coord.x)},${String(coord.y)}) is banned by ko`,
      )
    }

    const next = this.stones.slice()
    next[toIndex(coord, this.size)] = player

    const opponent: Player = player === 'black' ? 'white' : 'black'

    // Defensive copy. Not load-bearing today: every `groupAt` call below
    // returns before any capture is written, so a shared array would behave
    // identically — verified by reintroducing the sharing and watching the
    // whole suite still pass. Kept because the loop's correctness would
    // otherwise depend on that ordering staying accidental, and a future
    // change that scans after a write would corrupt results silently.
    const withStone = new Position(this.size, next.slice(), null, this.captures)

    // Capture opponent groups that this stone deprived of their last liberty.
    const captured: Coord[] = []
    for (const n of neighbours(coord, this.size)) {
      if (withStone.at(n) !== opponent) continue
      const group = withStone.groupAt(n)
      if (group?.liberties.length === 0) {
        for (const stone of group.stones) {
          const index = toIndex(stone, this.size)
          if (next[index] !== null) {
            next[index] = null
            captured.push(stone)
          }
        }
      }
    }

    const afterCaptures = new Position(this.size, next.slice(), null, this.captures)

    // Suicide is only illegal if the move captured nothing. A move that fills
    // your own last liberty while capturing is legal.
    const own = afterCaptures.groupAt(coord)
    if (own?.liberties.length === 0) {
      throw new RuleError(
        'suicide',
        `placing at (${String(coord.x)},${String(coord.y)}) would be suicide`,
      )
    }

    // Basic ko: exactly one stone captured, and the capturing group is a lone
    // stone with one liberty. Anything else cannot be a simple recapture.
    let koPoint: Coord | null = null
    if (
      captured.length === 1 &&
      own?.stones.length === 1 &&
      own.liberties.length === 1
    ) {
      koPoint = captured[0] ?? null
    }

    const captures = {
      black: this.captures.black + (player === 'black' ? captured.length : 0),
      white: this.captures.white + (player === 'white' ? captured.length : 0),
    }

    return {
      position: new Position(this.size, next, koPoint, captures),
      captured,
    }
  }

  /** Adds stones without capture resolution, for SGF `AB`/`AW` setup. */
  setup(placements: { coord: Coord; player: Player }[]): Position {
    const next = this.stones.slice()
    for (const { coord, player } of placements) {
      next[toIndex(coord, this.size)] = player
    }
    return new Position(this.size, next, null, this.captures)
  }

  /** True if `place` would succeed. Cheaper to read than a try/catch at call sites. */
  isLegal(coord: Coord, player: Player): boolean {
    try {
      this.place(coord, player)
      return true
    } catch (error) {
      if (error instanceof RuleError) return false
      throw error
    }
  }

  /** Flat snapshot for rendering or hashing. */
  toArray(): readonly Stone[] {
    return this.stones
  }

  /** Count of non-empty points. */
  stoneCount(): number {
    return this.stones.reduce((n, s) => (s === null ? n : n + 1), 0)
  }
}
