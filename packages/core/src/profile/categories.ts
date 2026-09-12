import { Position } from '../board/position'
import { fromGtp } from '../board/coords'
import type { BoardSize, Coord, Player } from '@gomentor/shared'

/**
 * The four-category classifier (M4 design §3): one game's analysis rows plus
 * board-replay geometry in, per-move category marks out. Pure, synchronous,
 * milliseconds for a full-length record.
 *
 * ## The "LLM cannot participate" boundary is the signature
 *
 * `classifyGame` takes rows and a replayable record — nothing else. There is
 * no string prompt, no model output, no settings in the input type, so no
 * caller can smuggle model judgement into the classification. The teacher
 * (M3) later *quotes* the profile's numbers; it never classifies. That
 * division is enforced here, at the type level, where it cannot drift.
 *
 * ## Row indexing (the batch tier's recorded contract)
 *
 * A row's `moveNumber` is the position index — the number of moves applied
 * when the engine analysed it. `winrateLoss` on row k attributes the cost of
 * **move k** itself. `topCandidateCoord` on row k is the engine's preference
 * **at position k** — i.e. the advice the mover of move k+1 saw — so "the
 * candidate the mover of k missed" lives on row k−1. Row 1 has no previous
 * row (row 0, the empty board, is never persisted), so move 1 can never be a
 * blindspot mark — there is no persisted candidate to have missed.
 *
 * ## The geometry is replayed, not assumed
 *
 * Contact distance and blindspot distance need the board. This module walks
 * the mainline with the core's own `Position` — the same replay the board UI
 * runs, so an illegal move stops the walk (marks so far are kept) rather than
 * inventing a position. Distance is **Chebyshev** (the board-square metric:
 * a point two files and one line away is distance 2), the reading "线"
 * implies for a square grid.
 *
 * ## The categories (MVP set — principle-led, append-only)
 *
 * 1. `opening-direction` — a major loss (≥ 5 winrate points) in the first 25
 *    moves: the game was steered wrong before the middlegame began.
 * 2. `middlegame-fighting` — any loss in a contact fight (the played point
 *    within Chebyshev 2 of an opposing stone) between move 25 and 150.
 * 3. `endgame-precision` — repeated small endgame slips: after move 150,
 *    losses of ≥ 1.5 points but below the major bar, marked only when the
 *    game's small-loss total reaches 3 × 1.5 — one slip is noise, three is a
 *    precision problem.
 * 4. `whole-board-blindspot` — a major loss where the engine's preferred
 *    point (the one the mover saw) sits ≥ 5 lines from where they played:
 *    the classic "never looked at the other side of the board".
 *
 * A move can carry several marks (a major contact loss in the opening fires
 * both opening-direction and middlegame... it cannot — the middlegame band
 * starts after 25 — but a major contact loss can be both fighting and
 * blindspot); the profile layer aggregates whatever arrives.
 */

export type CategoryId =
  | 'opening-direction'
  | 'middlegame-fighting'
  | 'endgame-precision'
  | 'whole-board-blindspot'

/** Every category id there is — the shared schema's enum and the i18n keys track this list. */
export const CATEGORY_IDS: readonly CategoryId[] = [
  'opening-direction',
  'middlegame-fighting',
  'endgame-precision',
  'whole-board-blindspot',
]

// --- Thresholds (design §3: centralized; benchmark records the calibration) ---

/** The opening band: moves 1..OPENING_MOVES. */
export const OPENING_MOVES = 25
/** The endgame band: moves after ENDGAME_START. 26..ENDGAME_START is the middlegame. */
export const ENDGAME_START = 150
/** A major loss, in winrate points (0..1 scale) — 5 winrate points. */
export const MAJOR_LOSS = 0.05
/** Contact: the played point within this Chebyshev distance of an opposing stone. */
export const CONTACT_DISTANCE = 2
/** Blindspot: the missed candidate at least this Chebyshev distance from the played point. */
export const BLINDSPOT_DISTANCE = 5
/** One "small" endgame slip, in winrate points — 1.5 points, below the major bar. */
export const ENDGAME_SMALL_LOSS = 0.015
/** The game-level bar for endgame-precision: this many points of small slips. */
export const ENDGAME_PRECISION_FLOOR = 3 * ENDGAME_SMALL_LOSS

/**
 * The analysis rows the classifier reads. Structurally the batch tier's
 * `AnalysisRow` — declared here so the core keeps depending on the domain
 * shape, not on the main-process repository's type.
 */
export interface AnalysisRowInput {
  readonly moveNumber: number
  readonly winrateLoss: number
  /**
   * GTP spelling of the engine's top candidate at this position, `'pass'`
   * for a pass, `null` when the engine named none — the batch tier's
   * `buildAnalysisRow` contract.
   */
  readonly topCandidateCoord: string | null
}

/** One per-move category mark — the atom the profile aggregates. */
export interface CategoryMark {
  readonly moveNumber: number
  readonly category: CategoryId
  /** The loss that earned the mark, in winrate points. */
  readonly loss: number
}

/**
 * The replayable record the geometry needs. Structurally `Game` (and the
 * core's own `ReplayInput` plus a player per move) — declared locally for
 * the same reason the row input is.
 */
export interface ClassifiableGame {
  readonly meta: { boardSize: BoardSize }
  readonly setup: { black: readonly Coord[]; white: readonly Coord[] }
  readonly moves: readonly { player: Player; coord: Coord | null }[]
}

/** Chebyshev distance on the board grid. */
function chebyshev(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

/** The board the move lands in. `null` means "none of that colour on the board". */
function nearestOpposing(position: Position, coord: Coord, opponent: Player): number {
  let best = Infinity
  for (let y = 0; y < position.size; y += 1) {
    for (let x = 0; x < position.size; x += 1) {
      const stone = position.at({ x, y })
      if (stone !== opponent) continue
      const distance = chebyshev(coord, { x, y })
      if (distance < best) best = distance
    }
  }
  return best
}

/**
 * Resolves a row's `topCandidateCoord` to a board point. `'pass'`, `null`,
 * and unparsable strings all yield `null` — a pass advises nothing placeable,
 * and a garbled coordinate (`fromGtp` throws `CoordError`) must not crash a
 * profile that exists to summarise messy real data.
 */
function candidateCoord(
  value: string | null | undefined,
  size: BoardSize,
): Coord | null {
  if (value === null || value === undefined) return null
  try {
    return fromGtp(value, size)
  } catch {
    return null
  }
}

export function classifyGame(
  game: ClassifiableGame,
  rows: readonly AnalysisRowInput[],
): CategoryMark[] {
  const rowsByMove = new Map<number, AnalysisRowInput>()
  for (const row of rows) rowsByMove.set(row.moveNumber, row)

  // The endgame gate is game-level (design: ≥ 3 × 1.5 points of small slips),
  // so the qualifying moves are collected first and marked only if the total
  // crosses the floor.
  const endgameCandidates: { moveNumber: number; loss: number }[] = []
  let endgameSmallTotal = 0
  for (const row of rows) {
    if (
      row.moveNumber > ENDGAME_START &&
      row.winrateLoss >= ENDGAME_SMALL_LOSS &&
      row.winrateLoss < MAJOR_LOSS
    ) {
      endgameCandidates.push({ moveNumber: row.moveNumber, loss: row.winrateLoss })
      endgameSmallTotal += row.winrateLoss
    }
  }
  const endgameMarkable =
    endgameSmallTotal >= ENDGAME_PRECISION_FLOOR
      ? new Set(endgameCandidates.map((candidate) => candidate.moveNumber))
      : new Set<number>()

  const marks: CategoryMark[] = []
  const mark = (moveNumber: number, category: CategoryId, loss: number): void => {
    marks.push({ moveNumber, category, loss })
  }

  let position = Position.empty(game.meta.boardSize).setup([
    ...game.setup.black.map((coord) => ({ coord, player: 'black' as const })),
    ...game.setup.white.map((coord) => ({ coord, player: 'white' as const })),
  ])

  for (let k = 1; k <= game.moves.length; k += 1) {
    const move = game.moves[k - 1]
    if (move === undefined) break
    const row = rowsByMove.get(k)
    if (move.coord !== null && row !== undefined) {
      const loss = row.winrateLoss
      const opponent: Player = move.player === 'black' ? 'white' : 'black'

      // opening-direction: the major losses that steered the opening.
      if (k <= OPENING_MOVES && loss >= MAJOR_LOSS) {
        mark(k, 'opening-direction', loss)
      }

      // middlegame-fighting: a loss in a contact fight. The distance reads the
      // board BEFORE the move — the fight the move entered, not the one it created.
      if (
        k > OPENING_MOVES &&
        k <= ENDGAME_START &&
        loss > 0 &&
        nearestOpposing(position, move.coord, opponent) <= CONTACT_DISTANCE
      ) {
        mark(k, 'middlegame-fighting', loss)
      }

      // whole-board-blindspot: a major loss away from the advice the mover saw
      // (row k−1's candidate — see the indexing note above).
      const missed = candidateCoord(
        rowsByMove.get(k - 1)?.topCandidateCoord,
        game.meta.boardSize,
      )
      if (loss >= MAJOR_LOSS && missed !== null) {
        if (chebyshev(missed, move.coord) >= BLINDSPOT_DISTANCE) {
          mark(k, 'whole-board-blindspot', loss)
        }
      }

      // endgame-precision: the collected small slips, when the game total
      // crosses the floor.
      if (endgameMarkable.has(k)) {
        mark(k, 'endgame-precision', loss)
      }
    }

    if (move.coord === null) continue // a pass advances the move count only
    try {
      position = position.place(move.coord, move.player).position
    } catch {
      // The replay stopped (illegal move in the record). Positions after the
      // stop are not vouchable — the same rule the board replay runs — so the
      // walk ends here with the marks earned so far.
      break
    }
  }

  return marks
}
