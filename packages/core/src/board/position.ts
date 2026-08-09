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

/**
 * Why `stopped` exists instead of `replay` throwing.
 *
 * A record whose move 137 is illegal is still a record with 136 good moves in
 * it. Throwing would make the whole game unopenable over one bad move, which is
 * the opposite of what a study tool should do with a real-world file — and the
 * corpus is full of files written by clients that disagree about the rules.
 * Silently skipping the move is worse still: the board would then be wrong from
 * that point on with nothing to say so, and a wrong board looks exactly as
 * authoritative as a right one.
 *
 * So replay stops, reports where, and hands back the last position it can vouch
 * for. The caller decides what to tell the user; `reason` carries the rule that
 * was broken so the UI can say which.
 */
export interface ReplayStop {
  /** 1-based number of the move that could not be played. */
  moveNumber: number
  reason: RuleError['reason']
}

export interface ReplayResult {
  position: Position
  /** How many moves were actually applied — less than requested iff `stopped`. */
  applied: number
  /**
   * The last stone placed, for the last-move marker. `null` after a pass or when
   * no move was applied, which the marker must treat as "draw nothing" rather
   * than as (0,0).
   */
  lastMove: { coord: Coord; player: Player } | null
  /** Stones the last applied move captured, for the capture animation. */
  captured: Coord[]
  /** Absent when every requested move was legal. */
  stopped?: ReplayStop
}

/**
 * A record's mainline, as delivered over IPC. Structurally typed rather than
 * importing `Game` from `@gomentor/shared` so `packages/core` keeps depending on
 * the *domain*, not on a transport payload — a `Game` gains transport-only fields
 * (`contentHash`, `importedAt`, `filePath`) that replay has no business seeing,
 * and a `Game` satisfies this shape, so callers pass one directly.
 */
export interface ReplayInput {
  meta: { boardSize: BoardSize }
  setup: { black: readonly Coord[]; white: readonly Coord[] }
  moves: readonly { player: Player; coord: Coord | null }[]
}

/**
 * The position after `moveNumber` moves of a record.
 *
 * `moveNumber` is a **count**, matching `Move.number`: 0 is the board before any
 * move — which is not necessarily empty, since setup stones are position rather
 * than play — and `moves.length` is the final position.
 *
 * ## Setup stones come from `setup`, never from `moves`
 *
 * A handicap game's stones are placed, not played. They arrive in
 * `Game.setup` (`gameSchema` records why they cannot be derived from `handicap`)
 * and go down through `Position.setup`, which does no capture resolution — nine
 * stones on the star points capture nothing, and running them through `place`
 * would also make the first one belong to move 1.
 *
 * ## Replayed from the start every time, not incrementally
 *
 * A cursor moving one step forward could in principle apply one move to the
 * previous position. This does not, and the reason is aliasing: stepping
 * backwards has no inverse — captures cannot be un-resolved — so a backward step
 * needs a replay anyway, and keeping one code path means forward and backward
 * cannot disagree. Cost was measured rather than assumed before accepting it; see
 * `test/board/replay.test.ts`, which asserts a bound on a full-length game so the
 * claim fails if it stops holding.
 */
export function replay(game: ReplayInput, moveNumber: number): ReplayResult {
  // Clamped rather than rejected: `moveNumber` is a UI cursor, and an
  // out-of-range cursor is a state to correct, not a reason to render nothing.
  // `Math.trunc` because a fractional cursor would otherwise slice unpredictably.
  const target = Math.max(0, Math.min(Math.trunc(moveNumber), game.moves.length))

  let position = Position.empty(game.meta.boardSize).setup([
    ...game.setup.black.map((coord) => ({ coord, player: 'black' as const })),
    ...game.setup.white.map((coord) => ({ coord, player: 'white' as const })),
  ])

  let lastMove: ReplayResult['lastMove'] = null
  let captured: Coord[] = []

  for (let i = 0; i < target; i += 1) {
    const move = game.moves[i]
    // `moves` is `readonly [...]`, so an index below `target` is in range. The
    // check is here because `noUncheckedIndexedAccess` types it as possibly
    // undefined, and narrowing it is honest where `!` would only silence it.
    if (move === undefined) break

    if (move.coord === null) {
      // A pass. It clears the last-move marker — there is no stone to mark — and
      // resets ko, which `place` also does on the next real move.
      lastMove = null
      captured = []
      continue
    }

    try {
      const result = position.place(move.coord, move.player)
      position = result.position
      lastMove = { coord: move.coord, player: move.player }
      captured = result.captured
    } catch (error) {
      if (error instanceof RuleError) {
        return {
          position,
          applied: i,
          lastMove,
          captured,
          // 1-based, matching `Move.number`, so a message can name the move the
          // user sees in the move list rather than an array index.
          stopped: { moveNumber: i + 1, reason: error.reason },
        }
      }
      throw error
    }
  }

  return { position, applied: target, lastMove, captured }
}
