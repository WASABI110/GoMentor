import {
  AppError,
  isAppError,
  BATCH_QUERY_PREFIX,
  type AnalysisResult,
  type BatchProgress,
  type BatchScope,
  type BatchStatus,
  type Game,
  type Settings,
} from '@gomentor/shared'
import { scoped, type Logger } from '../logger'
import { emit } from '../ipc/events'
import { toEngineGame } from '../sgf/adapter'
import type { AnalysisRepository, AnalysisRow } from '../db/repositories/analysis'
import type { GameStore } from '../library/store'
import { analysisThreadSplit } from './config'
import {
  BATCH_CHUNK_SIZE,
  buildAnalysisRow,
  planGameRun,
  planQueue,
} from './batch-plan'
import type { EngineService } from './service'

/**
 * The batch scheduler: whole-library (or "my games") analysis at sweep budget,
 * one compact row per move persisted for the Stage 3 profile, driven by the
 * `batch_state` ledger so a restart resumes instead of re-analysing.
 *
 * ## The fourth query tier, and what it must not touch
 *
 * Batch queries ride the agent tier's one-shot channel (`analyzeOnce`) under
 * the `batch:<n>` prefix — the third consumer of that channel, after the
 * readiness probe and the M3 tools. The B3 promise binds a third time: this
 * service calls `start` / `info` / `isFocusActive` / `analyzeOnce` on the
 * engine and nothing else — never `setGame`, never `setCursor`, never the
 * sweep. A user opening a game mid-batch is invisible to their own focus
 * analysis except for engine time-slicing, which is the M2 concurrency model
 * working as designed.
 *
 * ## Yielding to the user (design §2)
 *
 * Before each wave of queries goes out, a focus session holding the engine
 * pauses the run: no new issues, in-flight queries finish naturally, and the
 * loop resumes the moment the focus clears. The signal is the engine's own
 * session state (`isFocusActive`), not a new config knob. The wait also breaks
 * when the engine stops being `ready`, so a crash during the pause surfaces as
 * a failed run (resumable) instead of a silent stall.
 *
 * ## Waves, not a per-completion pump
 *
 * The sweep issues per completion because its consumer is a graph that fills
 * in any order. Batch rows must be a contiguous prefix (that is what makes
 * `planGameRun`'s resume sound), so queries go out in fixed waves of
 * `analysisThreadSplit(threads).positions` — the share of the engine's thread
 * model already allocated to parallel positions, no new process or thread
 * configuration — and rows are written in position order as each wave settles.
 * The drain between waves costs little at sweep budget and removes the need
 * for an order-repair buffer.
 *
 * ## Ledger discipline
 *
 * - Queue time: ledger `done` is skipped (never re-analysed); `failed` and
 *   `pending` are re-marked `pending` and queued.
 * - Mid-game: rows checkpoint in chunks (`commitChunk`); the ledger stays
 *   `pending`, so a crash resumes from the first missing move with the
 *   previous winrate read from the persisted row.
 * - Game end: the final rows and ledger `done` commit in ONE transaction —
 *   done ⟹ every row present.
 * - Cancellation and engine loss leave unfinished games `pending`; only a
 *   genuine per-game failure (a ready engine rejecting one of its queries)
 *   marks `failed`, and even that is retried on the next run.
 * - A game that leaves the library mid-analysis — deleted, or re-imported
 *   under new content — is counted done without further writes: the cascade
 *   already removed its rows, and committing would either die on the
 *   `analysis → games` foreign key or, worse, mark `done` over rows that
 *   describe content the library no longer holds.
 */

const logger = scoped('main:katago:batch')

/**
 * How often a paused run re-checks the focus predicate (ms). A pause is the
 * user reading a position — a quarter-second of slack is unnoticeable next to
 * a focus query's own latency, and it keeps the resume prompt after a game
 * close.
 */
const YIELD_POLL_MS = 250

/** The `batch:<n>` wire id for one issued query — the routing contract's namespace. */
function batchQueryId(counter: number): string {
  return `${BATCH_QUERY_PREFIX}${String(counter)}`
}

interface ActiveRun {
  readonly scope: BatchScope
  readonly controller: AbortController
  total: number
  done: number
  failed: number
  cancelled: boolean
}

export interface BatchService {
  /**
   * Queues every in-scope, not-`done` game and returns the run snapshot.
   * Starts the engine lazily (like a game open); a not-ready engine rejects
   * with its own typed code. Throws `BATCH_ALREADY_RUNNING` when a run —
   * including one still starting — is active.
   */
  start(scope: BatchScope): Promise<BatchStatus>
  /** Stops the active run; unfinished games stay `pending` and resume next run. No-op when idle. */
  cancel(): BatchStatus
  /** The synchronous snapshot, so a freshly mounted panel syncs without subscribing first. */
  status(): BatchStatus
  /**
   * Stops the run and aborts in-flight queries. Called on quit BEFORE the
   * database closes: a run that outlived its DB would turn teardown into a
   * pile of SQLite throws. Idempotent.
   */
  shutdown(): void
}

export interface BatchServiceOptions {
  readonly store: GameStore
  readonly settings: { readonly get: () => Settings }
  readonly engine: EngineService
  readonly repository: AnalysisRepository
  /**
   * Injected in tests so a game can be checkpointed with fewer rows than a
   * production chunk. Defaults to `BATCH_CHUNK_SIZE`.
   */
  readonly chunkSize?: number
  /** ISO timestamp for ledger rows. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string
  /** Progress emission. Defaults to the `batch:progress` event. */
  readonly emitProgress?: (progress: BatchProgress) => void
  readonly logger?: Logger
  /** Yield-poll sleep. Defaults to a plain setTimeout promise. */
  readonly sleep?: (ms: number) => Promise<void>
}

type GameOutcome = 'done' | 'failed' | 'interrupted' | 'gone'

export function createBatchService(options: BatchServiceOptions): BatchService {
  const repository = options.repository
  const chunkSize = options.chunkSize ?? BATCH_CHUNK_SIZE
  const now = options.now ?? (() => new Date().toISOString())
  const log = options.logger ?? logger
  const emitProgress =
    options.emitProgress ??
    ((progress: BatchProgress): void => {
      emit('batch:progress', progress)
    })
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }))

  /**
   * The one active run, or null. Set synchronously before any await so a
   * second `start` cannot slip in while the engine is still spawning.
   */
  let active: ActiveRun | null = null
  let queryCounter = 0
  let stopped = false

  function snapshot(): BatchStatus {
    if (active === null) return { status: 'idle', total: 0, done: 0, failed: 0 }
    return {
      status: 'running',
      scope: active.scope,
      total: active.total,
      done: active.done,
      failed: active.failed,
    }
  }

  /** The typed error for an engine that stopped answering mid-run. */
  function engineLostError(): AppError {
    const info = options.engine.info()
    return new AppError(
      info.errorCode ?? 'ENGINE_UNAVAILABLE',
      'the engine was lost during the batch run — unfinished games stay queued and resume on the next run',
      { context: { engineStatus: info.status } },
    )
  }

  /**
   * Analyses one game to completion (or its failure point), persisting rows
   * and ledger transitions. Throws only when the engine itself was lost — the
   * run-level abort that must not be recorded as this game's failure.
   */
  async function analyseGame(
    game: Game,
    window: number,
    run: ActiveRun,
  ): Promise<GameOutcome> {
    const engineGame = toEngineGame(game)
    const moveCount = game.moves.length
    let plan = planGameRun(repository.persistedMoves(game.id))
    if (plan.startPosition > moveCount) {
      // Fully persisted but the ledger still says pending — the
      // same-transaction invariant normally makes this unreachable; close the
      // gap without spending engine time.
      repository.markDone(game.id, [], now())
      return 'done'
    }
    let previousWinrate =
      plan.resumeFromMove === null
        ? undefined
        : repository.winrateAt(game.id, plan.resumeFromMove)
    if (plan.resumeFromMove !== null && previousWinrate === undefined) {
      // The seed row vanished under us (a tampered or damaged database). Loss
      // chaining needs the previous winrate; guessing it would write rows
      // Stage 3's thresholds read as evidence. Re-run the game from move 1.
      log.warn(
        'batch run: resume seed missing — re-analysing the game from the start',
        {
          gameId: game.id,
        },
      )
      plan = planGameRun([])
    }

    let pendingRows: AnalysisRow[] = []
    let position = plan.startPosition
    while (position <= moveCount) {
      if (run.cancelled || stopped) return 'interrupted'
      if (options.engine.isFocusActive() && options.engine.info().status === 'ready') {
        log.debug(
          'batch run paused: a game is open — interactive analysis has the engine',
        )
        await sleep(YIELD_POLL_MS)
        continue
      }

      const waveEnd = Math.min(position + window - 1, moveCount)
      const wave: Promise<AnalysisResult>[] = []
      for (let p = position; p <= waveEnd; p += 1) {
        queryCounter += 1
        wave.push(
          options.engine.analyzeOnce(engineGame, p, run.controller.signal, {
            queryId: batchQueryId(queryCounter),
            tier: 'batch',
          }),
        )
      }
      const settled = await Promise.allSettled(wave)
      // The record may have left the library (deleted) or been replaced
      // (re-imported under new content, so its rows were cascade-cleared)
      // while the wave was in flight. Committing now would either die on the
      // analysis→games foreign key or persist rows describing content the
      // library no longer holds and then mark the game done — stale evidence
      // a later run would never re-analyse. Count it gone; fresh content, if
      // any, has no ledger row and is queued on the next run.
      const current = options.store.get(game.id)
      if (current?.game.contentHash !== game.contentHash) {
        return 'gone'
      }
      for (let index = 0; index < settled.length; index += 1) {
        const item = settled[index]
        if (item === undefined) continue // unreachable; keeps the indexing honest
        const at = position + index
        if (item.status === 'rejected') {
          // Our own cancel/shutdown aborted the wave: the game is unfinished
          // business, not a failure.
          if (run.controller.signal.aborted) return 'interrupted'
          // The engine stopped answering as a whole: that is the run's
          // problem, not this game's — leave it pending and abort the run.
          if (options.engine.info().status !== 'ready') throw engineLostError()
          log.warn(
            'batch run: a position failed on a ready engine — game marked failed',
            {
              gameId: game.id,
              moveNumber: at,
            },
          )
          repository.markFailed(game.id, now())
          return 'failed'
        }
        const result = item.value
        if (at === 0) {
          // The empty board is analysed but never persisted: its only
          // consumer is move 1's loss, seeded here in memory.
          previousWinrate = result.winrate
        } else {
          if (previousWinrate === undefined) {
            // Invariant: position 0 always runs first in a fresh game, and a
            // resume seeds from the persisted row — so by move 1 the seed
            // exists. Reaching this means that proof broke; a typed throw
            // beats writing rows with a fabricated loss.
            throw new AppError(
              'IPC_HANDLER_FAILED',
              'batch run reached a move without a winrate seed',
            )
          }
          pendingRows.push(
            buildAnalysisRow(previousWinrate, result, game.meta.boardSize),
          )
          previousWinrate = result.winrate
        }
      }
      position = waveEnd + 1
      if (pendingRows.length >= chunkSize) {
        repository.commitChunk(game.id, pendingRows)
        pendingRows = []
      }
    }
    if (run.cancelled || stopped) return 'interrupted'
    // Final chunk and the ledger flip in one transaction: done ⟹ all rows.
    repository.markDone(game.id, pendingRows, now())
    return 'done'
  }

  async function drive(
    run: ActiveRun,
    queue: readonly string[],
    window: number,
  ): Promise<void> {
    let terminal: BatchProgress
    try {
      for (const gameId of queue) {
        if (run.cancelled || stopped) break
        const stored = options.store.get(gameId)
        if (stored === undefined) {
          // Deleted mid-run (the delete cascades the ledger row away too).
          // Counting it done keeps the run's arithmetic coherent: there is
          // nothing left of it to analyse.
          log.debug('batch run: game left the library mid-run — counting it done', {
            gameId,
          })
          run.done += 1
          emitProgress({
            status: 'running',
            total: run.total,
            done: run.done,
            failed: run.failed,
          })
          continue
        }
        const outcome = await analyseGame(stored.game, window, run)
        if (outcome === 'interrupted') break
        // 'gone' mirrors the queue-time skip above: the record left the
        // library mid-analysis, so there is nothing left of it to finish.
        if (outcome === 'done' || outcome === 'gone') run.done += 1
        else run.failed += 1
        emitProgress({
          status: 'running',
          total: run.total,
          done: run.done,
          failed: run.failed,
        })
      }
      terminal = run.cancelled
        ? { status: 'cancelled', total: run.total, done: run.done, failed: run.failed }
        : { status: 'done', total: run.total, done: run.done, failed: run.failed }
    } catch (error) {
      log.failure('batch run aborted', error)
      terminal = {
        status: 'failed',
        total: run.total,
        done: run.done,
        failed: run.failed,
        error: isAppError(error)
          ? error.toEnvelope()
          : { code: 'IPC_HANDLER_FAILED', message: 'The operation failed' },
      }
    }
    emitProgress(terminal)
  }

  return {
    async start(scope) {
      if (stopped) {
        throw new AppError('ENGINE_UNAVAILABLE', 'the batch service is shut down')
      }
      const run: ActiveRun = {
        scope,
        controller: new AbortController(),
        total: 0,
        done: 0,
        failed: 0,
        cancelled: false,
      }
      if (active !== null) {
        throw new AppError(
          'BATCH_ALREADY_RUNNING',
          'a batch analysis run is already in progress',
        )
      }
      active = run
      try {
        const info = await options.engine.start()
        if (info.status !== 'ready') {
          throw new AppError(
            info.errorCode ?? 'ENGINE_UNAVAILABLE',
            'the engine is not ready, so batch analysis cannot start',
            { context: { engineStatus: info.status } },
          )
        }
        const document = options.settings.get()
        const ledger = repository.ledger()
        const queue = planQueue(
          options.store.list().map((summary) => ({
            id: summary.id,
            blackName: summary.blackName,
            whiteName: summary.whiteName,
            override: options.store.getIsMineOverride(summary.id),
            ledgerStatus: ledger.get(summary.id) ?? null,
          })),
          scope,
          document.profile.playerNames,
        )
        for (const gameId of queue) repository.markPending(gameId, now())
        run.total = queue.length
        // The thread model already bounds parallel positions; the batch window
        // is that share — no new process or thread configuration (design §2).
        const window = analysisThreadSplit(document.engine.threads).positions
        emitProgress({ status: 'running', total: run.total, done: 0, failed: 0 })
        void drive(run, queue, window)
          .catch((error: unknown) => {
            // drive maps its own failures onto the terminal event; reaching
            // here means the mapper itself threw — log and release the run so
            // status() does not lie forever.
            log.failure('batch run crashed outside its failure mapping', error)
          })
          .finally(() => {
            if (active === run) active = null
          })
        return snapshot()
      } catch (error) {
        if (active === run) active = null
        throw error
      }
    },

    cancel() {
      if (active !== null) {
        active.cancelled = true
        active.controller.abort()
      }
      return snapshot()
    },

    status: () => snapshot(),

    shutdown() {
      stopped = true
      if (active !== null) {
        active.cancelled = true
        active.controller.abort()
      }
    },
  }
}
