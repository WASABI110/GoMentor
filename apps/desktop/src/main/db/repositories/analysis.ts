import type { Player } from '@gomentor/shared'
import type { SqliteDatabase } from '../connection'

/**
 * Persistence for batch-analysis output: the `analysis` rows and the
 * `batch_state` ledger that makes a run resumable.
 *
 * ## Why rows and ledger transitions are transactional
 *
 * The resume invariant the whole tier relies on: **ledger `done` ⟹ every row
 * of the game is present**. `markDone` therefore writes its final chunk and
 * the status flip in one `db.transaction` — a crash between them would roll
 * back together, leaving the game `pending` for a clean re-run. The mid-game
 * `commitChunk` checkpoints (ledger untouched, still `pending`) bound
 * crash-loss to one chunk instead of a whole game.
 *
 * ## Why resume reads are prefix-shaped
 *
 * Chunks are committed contiguously from move 1, so the persisted rows of a
 * pending game are always a prefix `1..k`. `persistedMoves` returns what is
 * actually there and `winrateAt` reads the seed the next chunk's first
 * `winrate_loss` needs — the previous position's winrate, "taken from the
 * persisted row" as the design puts it, never re-derived from the engine.
 */

export type LedgerStatus = 'pending' | 'done' | 'failed'

/**
 * One compact `analysis` row (M4 design §1). `winrate`/`scoreLead` describe
 * the position **after** `moveNumber` moves; `player` is the side to move at
 * that position, so `winrate` is from that side's perspective (the shared
 * contract's rule). `winrateLoss` attributes the cost of move `moveNumber`
 * itself: `winrate(previous position) − (1 − winrate(this position))` — the
 * mover's winrate before minus after their move. It is signed: a move the
 * engine misevaluated can read as a gain, and Stage 3's thresholds only fire
 * on positive losses.
 */
export interface AnalysisRow {
  readonly moveNumber: number
  readonly player: Player
  readonly winrate: number
  readonly scoreLead: number
  readonly winrateLoss: number
  /** GTP spelling of the engine's best candidate at this position (`pass` for a pass). Null when the engine named none. */
  readonly topCandidateCoord: string | null
  readonly topCandidateWinrate: number | null
}

export interface AnalysisRepository {
  /** Every ledger row, for queue planning at `batch:start`. */
  ledger(): Map<string, LedgerStatus>
  /** Move numbers with a persisted row (a contiguous prefix in practice). */
  persistedMoves(gameId: string): number[]
  /** The persisted winrate at `moveNumber` — the resume seed for the next row. */
  winrateAt(gameId: string, moveNumber: number): number | undefined
  /** Mid-game checkpoint: rows only; the ledger stays `pending`. */
  commitChunk(gameId: string, rows: readonly AnalysisRow[]): void
  /** Final rows + ledger `done` in ONE transaction (done ⟹ all rows present). */
  markDone(gameId: string, rows: readonly AnalysisRow[], at: string): void
  markFailed(gameId: string, at: string): void
  /** Queue (re)entry: fresh games, and `failed` games on their next run. */
  markPending(gameId: string, at: string): void
}

export function createAnalysisRepository(db: SqliteDatabase): AnalysisRepository {
  // Prepared once, the store.ts precedent: every method below is a hot path
  // while a batch run is in flight.
  const selectLedger = db.prepare<[], { game_id: string; status: string }>(
    'SELECT game_id, status FROM batch_state',
  )
  const selectMoves = db.prepare<[string], { move_number: number }>(
    'SELECT move_number FROM analysis WHERE game_id = ?',
  )
  const selectWinrate = db.prepare<[string, number], { winrate: number }>(
    'SELECT winrate FROM analysis WHERE game_id = ? AND move_number = ?',
  )
  const insertRow = db.prepare<{
    game_id: string
    move_number: number
    player: string
    winrate: number
    score_lead: number
    winrate_loss: number
    top_candidate_coord: string | null
    top_candidate_winrate: number | null
  }>(
    `INSERT INTO analysis (
       game_id, move_number, player, winrate, score_lead,
       winrate_loss, top_candidate_coord, top_candidate_winrate
     ) VALUES (
       @game_id, @move_number, @player, @winrate, @score_lead,
       @winrate_loss, @top_candidate_coord, @top_candidate_winrate
     )`,
  )
  const upsertLedger = db.prepare<{ game_id: string; status: string; at: string }>(
    `INSERT INTO batch_state (game_id, status, updated_at)
     VALUES (@game_id, @status, @at)
     ON CONFLICT(game_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  )

  function insertRows(gameId: string, rows: readonly AnalysisRow[]): void {
    for (const row of rows) {
      insertRow.run({
        game_id: gameId,
        move_number: row.moveNumber,
        player: row.player,
        winrate: row.winrate,
        score_lead: row.scoreLead,
        winrate_loss: row.winrateLoss,
        top_candidate_coord: row.topCandidateCoord,
        top_candidate_winrate: row.topCandidateWinrate,
      })
    }
  }

  const insertChunk = db.transaction((gameId: string, rows: readonly AnalysisRow[]) => {
    insertRows(gameId, rows)
  })

  const insertAndMarkDone = db.transaction(
    (gameId: string, rows: readonly AnalysisRow[], at: string) => {
      insertRows(gameId, rows)
      upsertLedger.run({ game_id: gameId, status: 'done', at })
    },
  )

  function toStatus(value: string): LedgerStatus {
    // The CHECK constraint guarantees one of the three; the narrowing keeps
    // the type honest if the constraint ever widens.
    return value === 'done' || value === 'failed' ? value : 'pending'
  }

  return {
    ledger() {
      const map = new Map<string, LedgerStatus>()
      for (const row of selectLedger.all()) map.set(row.game_id, toStatus(row.status))
      return map
    },
    persistedMoves(gameId) {
      return selectMoves.all(gameId).map((row) => row.move_number)
    },
    winrateAt(gameId, moveNumber) {
      return selectWinrate.get(gameId, moveNumber)?.winrate
    },
    commitChunk(gameId, rows) {
      if (rows.length === 0) return
      insertChunk(gameId, rows)
    },
    markDone(gameId, rows, at) {
      insertAndMarkDone(gameId, rows, at)
    },
    markFailed(gameId, at) {
      upsertLedger.run({ game_id: gameId, status: 'failed', at })
    },
    markPending(gameId, at) {
      upsertLedger.run({ game_id: gameId, status: 'pending', at })
    },
  }
}
