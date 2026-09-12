import { toGtp } from '@gomentor/core/board/coords'
import type { AnalysisResult, BatchScope, BoardSize } from '@gomentor/shared'
import type { AnalysisRow } from '../db/repositories/analysis'
import { isMyGame } from '../library/mine'

/**
 * The batch tier's pure decision core: queue selection, per-game resume
 * planning, and the winrate-loss projection. Everything here is a pure
 * function so the mutation harness can break each decision and require the
 * suite to notice; the driver that turns these plans into engine queries lives
 * in `batch.ts`.
 *
 * ## Row indexing (recorded once, because Stage 3 reads these rows)
 *
 * A row's `moveNumber` is the **position index**: the number of moves applied
 * when the engine analysed it, 1..moveCount. The position after 0 moves (the
 * empty board) is analysed but never persisted — its only consumer is move 1's
 * `winrateLoss`, computed in memory. Consequences the classifier relies on:
 *
 * - `winrate` is the root winrate **after** `moveNumber` moves, from the side
 *   to move at that position (`row.player`); the mover of move `moveNumber` is
 *   the *opponent* of `row.player`.
 * - `winrateLoss` attributes move `moveNumber` itself and needs the previous
 *   position's winrate: persisted rows satisfy
 *   `loss(k) = winrate(k−1) − (1 − winrate(k))` for every k ≥ 2, so the
 *   previous winrate is always on disk. Move 1's loss was seeded by the
 *   in-memory empty-board analysis of its own run.
 * - `topCandidateCoord`/`topCandidateWinrate` describe the engine's preference
 *   **at that position** — i.e. what the player facing move k+1 was told, not
 *   what the mover of k was shown. "The candidate the mover missed" for move k
 *   lives on row k−1.
 */

/**
 * How many analysis rows one mid-game checkpoint commits. Bounded so a crash
 * re-analyses at most one chunk, not a whole game: at the benchmark envelope
 * (~0.3–2.5 s/position, `research/eigen-cpu-throughput.md`) a chunk is seconds
 * to a minute of work, and WAL fsyncs amortise across it. The final chunk of a
 * game is whatever remains, so the last commit is typically smaller.
 */
export const BATCH_CHUNK_SIZE = 25

/**
 * Winrate lost by a move, in winrate points (0..1 scale).
 *
 * Both winrates are side-to-move root winrates at adjacent positions. Before
 * the move, the mover's winrate is `previousWinrate`; after it, the mover's
 * winrate is `1 − currentWinrate` (the new side to move is the opponent).
 * Loss = before − after = `previous + current − 1`. Signed by design: when the
 * follow-up reads better than the engine expected, the "loss" is negative, and
 * clamping it would feed Stage 3 thresholds a lie.
 */
export function winrateLoss(previousWinrate: number, currentWinrate: number): number {
  return previousWinrate + currentWinrate - 1
}

/** The engine's best candidate at the analysed position, by its own `order` rank. */
function topCandidate(
  result: AnalysisResult,
  boardSize: BoardSize,
): { coord: string; winrate: number } | null {
  if (result.candidates.length === 0) return null
  // The wire makes no promise about array position — only `order` is the rank
  // (the same rule `summariseAnalysis` in the M3 tools follows).
  const ordered = [...result.candidates].sort((a, b) => a.order - b.order)
  const best = ordered[0]
  if (best === undefined) return null
  return {
    coord: best.coord === null ? 'pass' : toGtp(best.coord, boardSize),
    winrate: best.winrate,
  }
}

/**
 * Projects one analysed position onto its `analysis` row. `previousWinrate`
 * is the winrate of the position one move earlier — held in memory while a
 * run is in flight, or read from the persisted previous row on resume.
 */
export function buildAnalysisRow(
  previousWinrate: number,
  result: AnalysisResult,
  boardSize: BoardSize,
): AnalysisRow {
  const top = topCandidate(result, boardSize)
  return {
    moveNumber: result.moveNumber,
    player: result.player,
    winrate: result.winrate,
    scoreLead: result.scoreLead,
    winrateLoss: winrateLoss(previousWinrate, result.winrate),
    topCandidateCoord: top === null ? null : top.coord,
    topCandidateWinrate: top === null ? null : top.winrate,
  }
}

/**
 * Where a game's run starts and where its first loss seed comes from.
 *
 * `startPosition` is the first engine position to analyse: 0 for a fresh game
 * (the empty board seeds move 1's loss in memory), otherwise one past the
 * last persisted row. `resumeFromMove` names the persisted row whose winrate
 * seeds the first resumed row's loss — null on a fresh start, where the seed
 * is the in-memory position-0 analysis instead.
 *
 * Rows are committed contiguously from move 1 (`commitChunk` in the
 * repository), so the persisted prefix is trustworthy: the first gap is always
 * `lastPersisted + 1`, and `winrate(lastPersisted)` is exactly the seed.
 */
export interface GameRunPlan {
  readonly startPosition: number
  readonly resumeFromMove: number | null
}

export function planGameRun(persistedMoveNumbers: readonly number[]): GameRunPlan {
  let lastPersisted = 0
  for (const moveNumber of persistedMoveNumbers) {
    if (moveNumber > lastPersisted) lastPersisted = moveNumber
  }
  if (lastPersisted === 0) return { startPosition: 0, resumeFromMove: null }
  return { startPosition: lastPersisted + 1, resumeFromMove: lastPersisted }
}

/** One library candidate for queue planning — the summary fields the scope filter reads. */
export interface QueueCandidate {
  readonly id: string
  readonly blackName?: string | undefined
  readonly whiteName?: string | undefined
  readonly override: boolean | undefined
  readonly ledgerStatus: 'pending' | 'done' | 'failed' | null
}

/**
 * The games one run analyses, in library-list order.
 *
 * - Ledger `done` is skipped unconditionally: a finished game is never
 *   re-analysed (C2). `failed` and `pending` are queued — `failed` gets its
 *   next-run retry, `pending` resumes (from its persisted rows mid-game, or
 *   from scratch when nothing was committed).
 * - `mine` filters through the pure `isMyGame` predicate: the manual override
 *   outranks a case-insensitive either-colour name match against
 *   `settings.profile.playerNames`.
 */
export function planQueue(
  games: readonly QueueCandidate[],
  scope: BatchScope,
  playerNames: readonly string[],
): string[] {
  const queue: string[] = []
  for (const game of games) {
    if (game.ledgerStatus === 'done') continue
    if (scope === 'mine' && !isMyGame(game, playerNames, game.override)) continue
    queue.push(game.id)
  }
  return queue
}
