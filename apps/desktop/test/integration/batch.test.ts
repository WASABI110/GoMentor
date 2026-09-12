import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  settingsSchema,
  type BatchProgress,
  type Game,
  type Settings,
} from '@gomentor/shared'
import type { SgfCollection } from '@gomentor/core/sgf/ast'
import { parseSgf } from '@gomentor/core/sgf/parser'
import type { SpawnFn } from '../../src/main/katago/process'
import type { LocateOutcome } from '../../src/main/katago/locate'
import type { EngineService } from '../../src/main/katago/service'
import type { BatchService } from '../../src/main/katago/batch'
import type { AnalysisRepository } from '../../src/main/db/repositories/analysis'
import type { GameStore } from '../../src/main/library/store'
import type { SqliteDatabase } from '../../src/main/db/connection'
import type { Logger } from '../../src/main/logger'
import { createTestDb } from './test-db'

/**
 * Batch scheduler integration: the real `createBatchService` driving the real
 * engine service against the real spawned fake (`fake-katago-child.ts`), with
 * a real database file for the store and the analysis ledger.
 *
 * ## What is real and what is recorded
 *
 * - The engine is the real service: launch, readiness probe, wire framing,
 *   terminate-on-abort all run for real against the fake child.
 * - `analyzeOnce` calls are recorded by a transparent decorator that delegates
 *   to the real service unchanged — the call list is how "which positions did
 *   the run ask for" is observed. Decorating, not reimplementing: the wire
 *   behaviour under test is the real one's.
 * - Progress events ride the real `ipc/events` fan-out into a fake window,
 *   exactly as production sends them to a renderer.
 * - The DB is a real temp file, closed and reopened where the test says so.
 *
 * ## The fake's seeding is the determinism anchor
 *
 * Analysis responses are canned and seeded by request content
 * (`fake-katago-child.ts`), so a re-analysed position answers the same bytes
 * every run — and a position analysed under a different query id answers
 * differently. That makes "the done game's rows are byte-identical after the
 * next run" a real not-re-analysed assertion, not a tautology.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/virtual/app',
    getPath: () => '/virtual/userData',
  },
  // `batch:progress` rides the real `ipc/events` fan-out, which reads
  // `BrowserWindow.getAllWindows()`. One fake window captures what main would
  // push, so a spec asserts the event a real renderer would receive.
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send(channel: string, payload: unknown) {
            sentEvents.push({ channel, payload })
          },
        },
      },
    ],
  },
}))

/** Everything main pushed through `webContents.send`, in order. */
const sentEvents: { channel: string; payload: unknown }[] = []

const CHILD = join(import.meta.dirname, 'fake-katago-child.ts')
const NETWORK = '/virtual/net.txt.gz'

const SETTINGS: Settings = settingsSchema.parse({})

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  failure: () => undefined,
}

/** SGF coordinate letters are plain `a`-anchored column-then-row, no I-skip. */
function sgfCoord(coord: { x: number; y: number }): string {
  return String.fromCharCode(97 + coord.x) + String.fromCharCode(97 + coord.y)
}

/**
 * One library game: SGF text describing the real moves, parsed by the real
 * parser (the store round-trips the AST through bytes on put/get, so the
 * fixture must survive serialisation), and a `Game` matching it. The store
 * never cross-checks the two; keeping them honestly matched is free.
 */
function fixture(
  id: string,
  blackName: string,
  whiteName: string,
  coords: { x: number; y: number }[],
  importedAt = '2026-09-10T00:00:00.000Z',
): { game: Game; collection: SgfCollection } {
  const sgf =
    `(;GM[1]FF[4]CA[UTF-8]SZ[19]PB[${blackName}]PW[${whiteName}]KM[6.5]` +
    coords
      .map((coord, index) => `;${index % 2 === 0 ? 'B' : 'W'}[${sgfCoord(coord)}]`)
      .join('') +
    ')'
  const game: Game = {
    id,
    meta: {
      boardSize: 19,
      komi: 6.5,
      handicap: 0,
      blackName,
      whiteName,
      date: '2026-09-10',
      ruleset: 'japanese',
    },
    setup: { black: [], white: [] },
    moves: coords.map((coord, index) => ({
      number: index + 1,
      player: index % 2 === 0 ? 'black' : 'white',
      coord,
    })),
    branches: [],
    source: 'import',
    contentHash: id,
    importedAt,
  }
  return { game, collection: parseSgf(sgf) }
}

interface AnalyzeCall {
  readonly gameId: string
  readonly moveNumber: number
  readonly queryId: string | undefined
  readonly tier: 'agent' | 'batch' | undefined
}

interface World {
  readonly store: GameStore
  readonly repository: AnalysisRepository
  readonly engine: EngineService
  readonly batch: BatchService
  readonly calls: AnalyzeCall[]
  close: () => Promise<void>
}

let tempDir: string
/** Best-effort leak guard: the most recent service/batch the file created. */
let lastService: EngineService | undefined
let lastBatch: BatchService | undefined

/** Per-spawn fault flags, appended after the service's own argv. */
let SPAWN_ARGS: string[] = []

const spawnSeam: SpawnFn = (command, args) => spawn(command, [...args, ...SPAWN_ARGS])

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gomentor-batch-'))
  sentEvents.length = 0
  lastService = undefined
  lastBatch = undefined
})

afterEach(async () => {
  lastBatch?.shutdown()
  await lastService?.shutdown()
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/**
 * Builds the real engine service (launch decision included, like
 * `engine-service.test.ts`), wraps it in the recording decorator, and creates
 * the batch scheduler over the given database connection.
 */
async function makeWorld(
  db: SqliteDatabase,
  options: {
    readonly args?: string[]
    readonly chunkSize?: number
    readonly settings?: Settings
    readonly locate?: () => LocateOutcome
    readonly probeDeadlineMs?: number
  } = {},
): Promise<World> {
  const { createEngineService } = await import('../../src/main/katago/service')
  const { createGameStore } = await import('../../src/main/library/store')
  const { createAnalysisRepository } =
    await import('../../src/main/db/repositories/analysis')
  const { createBatchService } = await import('../../src/main/katago/batch')

  SPAWN_ARGS = options.args ?? ['--mode=analysis', '--delay-ms=5']
  const settings = options.settings ?? SETTINGS
  const inner = createEngineService({
    settings: { get: () => settings },
    locate:
      options.locate ?? (() => ({ kind: 'found', binary: CHILD, network: NETWORK })),
    spawn: spawnSeam,
    writeConfig: (contents) => {
      const path = join(tempDir, 'katago-analysis.cfg')
      writeFileSync(path, contents, 'utf8')
      return path
    },
    emitStatus: () => undefined,
    logger: silentLogger,
    ...(options.probeDeadlineMs === undefined
      ? {}
      : { probeDeadlineMs: options.probeDeadlineMs }),
  })
  lastService = inner

  const calls: AnalyzeCall[] = []
  const engine: EngineService = {
    ...inner,
    analyzeOnce: (game, moveNumber, signal, analyzeOptions) => {
      calls.push({
        gameId: game.gameId,
        moveNumber,
        queryId: analyzeOptions?.queryId,
        tier: analyzeOptions?.tier,
      })
      return inner.analyzeOnce(game, moveNumber, signal, analyzeOptions)
    },
  }

  const store = createGameStore(db)
  const repository = createAnalysisRepository(db)
  const service = createBatchService({
    store,
    settings: { get: () => settings },
    engine,
    repository,
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
    logger: silentLogger,
  })
  lastBatch = service
  let closed = false
  return {
    store,
    repository,
    engine,
    batch: service,
    calls,
    close: async () => {
      if (closed) return
      closed = true
      service.shutdown()
      await inner.shutdown()
    },
  }
}

/** Seeds a game into the store. `importedAt` controls list (and so queue) order. */
function putGame(
  store: GameStore,
  id: string,
  coords: { x: number; y: number }[],
  blackName = 'Black',
  whiteName = 'White',
  importedAt = '2026-09-10T00:00:00.000Z',
): void {
  store.put(fixture(id, blackName, whiteName, coords, importedAt))
}

/** A newer stamp than the putGame default: puts a game at the FRONT of list(). */
const LATER_STAMP = '2026-09-10T01:00:00.000Z'

/** The batch:progress payloads pushed so far, in order. */
function progressEvents(): BatchProgress[] {
  return sentEvents
    .filter((entry) => entry.channel === 'batch:progress')
    .map((entry) => entry.payload as BatchProgress)
}

/** The most recent progress event — the current run's terminal once settled. */
function lastEvent(): BatchProgress | undefined {
  return progressEvents().at(-1)
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Full analysis rows straight from the table (the repository intentionally
 * has no whole-row read yet — Stage 3 adds the reader the profile needs).
 */
function readRows(db: SqliteDatabase, gameId: string): Record<string, unknown>[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      'SELECT * FROM analysis WHERE game_id = ? ORDER BY move_number',
    )
    .all(gameId)
}

describe('batch scheduler', () => {
  it('analyses every queued game at the batch tier and persists one row per move', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db)
      putGame(world.store, 'g1', [
        { x: 3, y: 3 },
        { x: 15, y: 3 },
      ])
      putGame(world.store, 'g2', [{ x: 3, y: 3 }])

      const snapshot = await world.batch.start('all')
      expect(snapshot).toEqual({
        status: 'running',
        scope: 'all',
        total: 2,
        done: 0,
        failed: 0,
      })
      await waitFor(() => lastEvent()?.status === 'done')

      // Progress: one running emission at start and one per game, then the
      // terminal. Bounded by the game count — no coalescing needed.
      const events = progressEvents()
      expect(events.at(0)).toEqual({ status: 'running', total: 2, done: 0, failed: 0 })
      expect(lastEvent()).toEqual({ status: 'done', total: 2, done: 2, failed: 0 })
      expect(events.filter((event) => event.status === 'running')).toHaveLength(3)

      // Every position of every game, under the batch namespace and tier.
      // Positions are 0..moveCount (the empty board seeds move 1's loss).
      const byGame = new Map<string, number[]>()
      for (const call of world.calls) {
        expect(call.queryId).toMatch(/^batch:\d+$/)
        expect(call.tier).toBe('batch')
        const list = byGame.get(call.gameId) ?? []
        list.push(call.moveNumber)
        byGame.set(call.gameId, list)
      }
      expect(byGame.get('g1')?.sort((a, b) => a - b)).toEqual([0, 1, 2])
      expect(byGame.get('g2')?.sort((a, b) => a - b)).toEqual([0, 1])

      // Rows: one per move, side-to-move parity, and the loss recurrence —
      // loss(k) = winrate(k−1) + winrate(k) − 1 — holding across persisted
      // rows (row 1's seed, the empty-board analysis, lives only in memory).
      for (const [gameId, moveCount] of [
        ['g1', 2],
        ['g2', 1],
      ] as const) {
        const rows = readRows(testDb.db, gameId)
        expect(rows).toHaveLength(moveCount)
        expect(world.repository.ledger().get(gameId)).toBe('done')
        for (const [index, row] of rows.entries()) {
          const moveNumber = index + 1
          expect(row['move_number']).toBe(moveNumber)
          expect(row['player']).toBe(moveNumber % 2 === 0 ? 'black' : 'white')
          if (index > 0) {
            // The index > 0 guard above makes the previous row certain; the
            // assertion narrows what noUncheckedIndexedAccess cannot see.
            const previous = rows[index - 1]!
            expect(row['winrate_loss'] as number).toBeCloseTo(
              (previous['winrate'] as number) + (row['winrate'] as number) - 1,
              12,
            )
          }
        }
      }
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('never re-analyses a done game on the next run', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db)
      putGame(world.store, 'g1', [{ x: 3, y: 3 }])
      putGame(world.store, 'g2', [{ x: 15, y: 15 }])

      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'done')
      const g1Rows = readRows(testDb.db, 'g1')
      expect(g1Rows).toHaveLength(1)
      world.calls.length = 0

      // Second run: g1 is done in the ledger — the queue must not include it.
      await world.batch.start('all')
      await waitFor(
        () => progressEvents().length >= 5 && lastEvent()?.status === 'done',
      )
      expect(world.calls.every((call) => call.gameId === 'g2')).toBe(true)
      // The done game's rows are untouched (the fake seeds answers by request
      // content, so a re-analysis would have rewritten these bytes).
      expect(readRows(testDb.db, 'g1')).toEqual(g1Rows)
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('a game deleted mid-run is counted done and the run moves on', async () => {
    const testDb = createTestDb()
    try {
      // delay-ms=300 keeps x in flight long enough to delete y before the drive
      // reaches it. x is stamped newest so the queue is [x, z, y] (z and y share
      // the default stamp; same-stamp inserts list later puts first).
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--delay-ms=300'],
      })
      putGame(world.store, 'x', [{ x: 3, y: 3 }], 'Black', 'White', LATER_STAMP)
      putGame(world.store, 'y', [{ x: 15, y: 15 }])
      putGame(world.store, 'z', [{ x: 3, y: 15 }])

      await world.batch.start('all')
      await waitFor(() => world.calls.length >= 1)
      world.store.delete('y')
      await waitFor(() => lastEvent()?.status === 'done')

      // y contributed no engine calls and no failure — it left the library, so
      // there is nothing left of it to analyse: counted done.
      expect(lastEvent()).toEqual({ status: 'done', total: 3, done: 3, failed: 0 })
      const byGame = new Map<string, number[]>()
      for (const call of world.calls) {
        const list = byGame.get(call.gameId) ?? []
        list.push(call.moveNumber)
        byGame.set(call.gameId, list)
      }
      expect(byGame.get('x')?.sort((a, b) => a - b)).toEqual([0, 1])
      expect(byGame.has('y')).toBe(false)
      expect(byGame.get('z')?.sort((a, b) => a - b)).toEqual([0, 1])
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('a game deleted while its wave is in flight is counted done and the run continues', async () => {
    const testDb = createTestDb()
    try {
      // delay-ms=300 keeps x's wave (positions 0 and 1) in flight long enough
      // to delete x before the wave settles. x is stamped newest so it runs
      // first; y proves the run continues after the disappearance.
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--delay-ms=300'],
      })
      putGame(world.store, 'x', [{ x: 3, y: 3 }], 'Black', 'White', LATER_STAMP)
      putGame(world.store, 'y', [{ x: 15, y: 15 }])

      await world.batch.start('all')
      // Both of x's calls are recorded synchronously at issue; the delete
      // lands while the answers are still pending.
      await waitFor(() => world.calls.length >= 1)
      world.store.delete('x')
      await waitFor(() => lastEvent()?.status === 'done')

      // No failure, no error envelope: x's wave was spent, then the run saw
      // the record was gone and moved on. Without the mid-flight check the
      // commit after the wave dies on the analysis→games foreign key and the
      // whole run reports failed instead.
      expect(lastEvent()).toEqual({ status: 'done', total: 2, done: 2, failed: 0 })
      const byGame = new Map<string, number[]>()
      for (const call of world.calls) {
        const list = byGame.get(call.gameId) ?? []
        list.push(call.moveNumber)
        byGame.set(call.gameId, list)
      }
      expect(byGame.get('x')?.sort((a, b) => a - b)).toEqual([0, 1])
      expect(byGame.get('y')?.sort((a, b) => a - b)).toEqual([0, 1])
      // The delete's cascade removed everything of x; the gone path committed
      // nothing on its behalf.
      expect(readRows(testDb.db, 'x')).toEqual([])
      expect(world.repository.ledger().get('x')).toBeUndefined()
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('a game re-imported under new content mid-analysis is not marked done over stale rows', async () => {
    const testDb = createTestDb()
    try {
      // Same shape as the delete test, but the record is replaced rather than
      // removed: the put's cascade clears x's rows and ledger row, and the
      // in-flight run must not answer the wave and then commit rows that
      // describe the old content with a `done` ledger — stale evidence a
      // later run would never revisit.
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--delay-ms=300'],
      })
      putGame(world.store, 'x', [{ x: 3, y: 3 }], 'Black', 'White', LATER_STAMP)

      await world.batch.start('all')
      await waitFor(() => world.calls.length >= 1)
      const revised = fixture('x', 'Black', 'White', [
        { x: 3, y: 3 },
        { x: 15, y: 3 },
        { x: 3, y: 15 },
      ])
      revised.game.contentHash = 'x-revised'
      world.store.put(revised)
      await waitFor(() => lastEvent()?.status === 'done')

      // The old record is gone: counted done, and the ledger row the cascade
      // removed was not resurrected by the run's bookkeeping.
      expect(lastEvent()).toEqual({ status: 'done', total: 1, done: 1, failed: 0 })
      expect(world.repository.ledger().get('x')).toBeUndefined()
      expect(readRows(testDb.db, 'x')).toEqual([])

      // The new content has no ledger row, so the next run queues it fresh —
      // positions 0..3 of the revised record. A stale `done` would have
      // skipped this and left the old single row behind.
      world.calls.length = 0
      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'done')
      expect(world.calls.map((call) => call.moveNumber).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3,
      ])
      expect(readRows(testDb.db, 'x')).toHaveLength(3)
      expect(world.repository.ledger().get('x')).toBe('done')
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('cancel stops the run promptly and leaves the game pending', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--delay-ms=300'],
      })
      const coords = Array.from({ length: 12 }, (_, index) => ({
        x: (index * 2) % 19,
        y: (index * 3) % 19,
      }))
      putGame(world.store, 'g1', coords)

      await world.batch.start('all')
      // Wait for the first wave to be in flight, then cancel.
      await waitFor(() => world.calls.length >= 2)
      world.batch.cancel()
      await waitFor(() => lastEvent()?.status === 'cancelled')

      // No new issues after the cancel: only the in-flight wave was spent.
      expect(world.calls).toHaveLength(2)
      expect(lastEvent()).toEqual({ status: 'cancelled', total: 1, done: 0, failed: 0 })
      // The unfinished game stays pending and resumes on the next run.
      expect(world.repository.ledger().get('g1')).toBe('pending')
      expect(world.repository.persistedMoves('g1')).toEqual([])
      expect(world.batch.status()).toEqual({
        status: 'idle',
        total: 0,
        done: 0,
        failed: 0,
      })
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('yields to an open game and resumes the moment the focus clears', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db)
      putGame(world.store, 'g1', [{ x: 3, y: 3 }])

      // The user opens a game: interactive analysis owns the engine now.
      const held = fixture('held', 'Black', 'White', [{ x: 3, y: 3 }])
      world.engine.setGame(
        {
          gameId: held.game.id,
          boardSize: held.game.meta.boardSize,
          komi: held.game.meta.komi,
          rules: held.game.meta.ruleset ?? '',
          setup: held.game.setup,
          moves: held.game.moves.map((move) => ({
            player: move.player,
            coord: move.coord,
          })),
        },
        0,
      )
      expect(world.engine.isFocusActive()).toBe(true)

      await world.batch.start('all')
      // Longer than several yield polls: the run must not have issued a single
      // engine query while the focus session holds the engine. The start
      // event announced the run; nothing may follow it while yielded.
      await new Promise((resolve) => setTimeout(resolve, 900))
      expect(world.calls).toHaveLength(0)
      expect(lastEvent()).toEqual({ status: 'running', total: 1, done: 0, failed: 0 })

      // The user closes the game: the run resumes without a nudge.
      world.engine.setGame(null, 0)
      await waitFor(() => lastEvent()?.status === 'done')
      expect(world.calls.map((call) => call.moveNumber).sort((a, b) => a - b)).toEqual([
        0, 1,
      ])
      expect(readRows(testDb.db, 'g1')).toHaveLength(1)
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('crash mid-run aborts with a typed envelope; reopen resumes without touching done games', async () => {
    const testDb = createTestDb()
    try {
      // Game a: one move (finishes before the crash). Game b: five moves,
      // interrupted mid-run. Response budget: probe(1), a0(2), a1(3),
      // b0(4)…b3(7) — the fake exits after the seventh response, so b's third
      // wave never answers. The window is 2 positions; a checkpoint flushes
      // EVERYTHING pending once it reaches the chunk threshold, so after
      // wave 2 (positions 2–3) rows 1–3 are committed in one go; the in-flight
      // wave dies with the process.
      //
      // a is stamped NEWER than b so the queue order is [a, b]: the batch
      // queue follows library-list order (imported_at DESC, rowid DESC), and
      // same-stamp inserts list later puts FIRST — with default stamps the
      // queue would be [b, a] and the budget arithmetic below inverts.
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--crash-after=7'],
        chunkSize: 2,
      })
      putGame(world.store, 'a', [{ x: 3, y: 3 }], 'Black', 'White', LATER_STAMP)
      putGame(world.store, 'b', [
        { x: 3, y: 3 },
        { x: 15, y: 3 },
        { x: 3, y: 15 },
        { x: 15, y: 15 },
        { x: 9, y: 9 },
      ])

      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'failed')
      const failure = lastEvent()
      expect(failure?.status).toBe('failed')
      expect(failure?.error?.code.startsWith('ENGINE_')).toBe(true)
      expect(world.repository.ledger().get('a')).toBe('done')
      expect(world.repository.ledger().get('b')).toBe('pending')
      // b's settled rows survived as committed; the in-flight wave did not.
      const bRowsBefore = readRows(testDb.db, 'b')
      expect(bRowsBefore.map((row) => row['move_number'])).toEqual([1, 2, 3])
      const aRows = readRows(testDb.db, 'a')
      await world.close()

      // Simulate the restart: close the database for real, reopen the file.
      testDb.close()
      const reopened = (await import('../../src/main/db/connection')).openDatabase(
        testDb.file,
      )
      try {
        const world2 = await makeWorld(reopened, { chunkSize: 2 })
        await world2.batch.start('all')
        await waitFor(() => lastEvent()?.status === 'done')

        // The queue was only b: a is done in the ledger, and resuming b starts
        // one past its last persisted row (positions 4–5 only, not 0..5).
        const bCalls = world2.calls.filter((call) => call.gameId === 'b')
        expect(bCalls.map((call) => call.moveNumber)).toEqual([4, 5])
        expect(world2.calls.some((call) => call.gameId === 'a')).toBe(false)

        // b is complete now, and row 5's loss was seeded from the persisted
        // row 4's winrate — "taken from the persisted row", not re-derived.
        expect(world2.repository.ledger().get('b')).toBe('done')
        const bRows = readRows(reopened, 'b')
        expect(bRows.map((row) => row['move_number'])).toEqual([1, 2, 3, 4, 5])
        const row5 = bRows[4]
        const row4 = bRows[3]
        expect(row5?.['winrate_loss'] as number).toBeCloseTo(
          (row4?.['winrate'] as number) + (row5?.['winrate'] as number) - 1,
          12,
        )
        // a's rows are byte-identical — it was never re-analysed.
        expect(readRows(reopened, 'a')).toEqual(aRows)
        await world2.close()
      } finally {
        reopened.close()
      }
    } finally {
      testDb.cleanup()
    }
  })

  it('a crash landing on a full checkpoint keeps exactly the threshold-flushed prefix', async () => {
    const testDb = createTestDb()
    try {
      // threads 6 → a three-position window: wave 1 (positions 0–2) produces
      // exactly chunkSize (2) rows, so the flush check fires AT the threshold.
      // The response budget probe(1), b0(2), b1(3), b2(4) lets wave 1 settle
      // fully and kills the fake before wave 2 answers: the rows on disk are
      // exactly what the threshold flush committed, and a `>` mutant that
      // flushes one row late would leave the prefix empty.
      const settings = settingsSchema.parse({ engine: { threads: 6 } })
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--crash-after=4'],
        chunkSize: 2,
        settings,
      })
      putGame(world.store, 'b', [
        { x: 3, y: 3 },
        { x: 15, y: 3 },
        { x: 3, y: 15 },
        { x: 15, y: 15 },
        { x: 9, y: 9 },
      ])

      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'failed')
      expect(world.repository.ledger().get('b')).toBe('pending')
      expect(readRows(testDb.db, 'b').map((row) => row['move_number'])).toEqual([1, 2])
      await world.close()

      // The restart resumes one past the flushed prefix — not from scratch.
      testDb.close()
      const reopened = (await import('../../src/main/db/connection')).openDatabase(
        testDb.file,
      )
      try {
        const world2 = await makeWorld(reopened, { chunkSize: 2, settings })
        await world2.batch.start('all')
        await waitFor(() => lastEvent()?.status === 'done')
        expect(world2.calls.map((call) => call.moveNumber)).toEqual([3, 4, 5])
        expect(world2.repository.ledger().get('b')).toBe('done')
        expect(readRows(reopened, 'b').map((row) => row['move_number'])).toEqual([
          1, 2, 3, 4, 5,
        ])
        await world2.close()
      } finally {
        reopened.close()
      }
    } finally {
      testDb.cleanup()
    }
  })

  it('a within-game resume seeds the first loss from the persisted row', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db)
      putGame(world.store, 'g1', [
        { x: 3, y: 3 },
        { x: 15, y: 3 },
        { x: 3, y: 15 },
      ])
      // A previous run persisted rows 1–2 and then died (ledger still pending).
      world.repository.commitChunk('g1', [
        {
          moveNumber: 1,
          player: 'white',
          winrate: 0.44,
          scoreLead: -1,
          winrateLoss: 0.01,
          topCandidateCoord: 'Q16',
          topCandidateWinrate: 0.45,
        },
        {
          moveNumber: 2,
          player: 'black',
          winrate: 0.56,
          scoreLead: 1,
          winrateLoss: 0,
          topCandidateCoord: 'D4',
          topCandidateWinrate: 0.57,
        },
      ])

      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'done')

      // Only position 3 was analysed — rows 1–2 were already on disk.
      expect(world.calls.map((call) => call.moveNumber)).toEqual([3])
      const rows = readRows(testDb.db, 'g1')
      expect(rows.map((row) => row['move_number'])).toEqual([1, 2, 3])
      const row3 = rows[2]
      expect(row3?.['winrate_loss'] as number).toBeCloseTo(
        0.56 + (row3?.['winrate'] as number) - 1,
        12,
      )
      // The seeded rows were not rewritten.
      expect(rows[0]?.['winrate']).toBe(0.44)
      expect(rows[1]?.['winrate']).toBe(0.56)
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('rejects a second start while a run is active', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--delay-ms=300'],
      })
      const coords = Array.from({ length: 8 }, (_, index) => ({
        x: (index * 2) % 19,
        y: (index * 3) % 19,
      }))
      putGame(world.store, 'g1', coords)

      const first = await world.batch.start('all')
      expect(first.status).toBe('running')
      await expect(world.batch.start('all')).rejects.toMatchObject({
        code: 'BATCH_ALREADY_RUNNING',
      })

      world.batch.cancel()
      await waitFor(() => lastEvent()?.status === 'cancelled')
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('completes immediately with total 0 on an empty queue', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db)
      const snapshot = await world.batch.start('all')
      expect(snapshot).toEqual({
        status: 'running',
        scope: 'all',
        total: 0,
        done: 0,
        failed: 0,
      })
      await waitFor(() => lastEvent()?.status === 'done')
      expect(lastEvent()).toEqual({ status: 'done', total: 0, done: 0, failed: 0 })
      expect(world.calls).toHaveLength(0)
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('mine scope filters by names case-insensitively, with the override on top', async () => {
    const testDb = createTestDb()
    try {
      const settings = settingsSchema.parse({
        profile: { playerNames: ['Lee Changho'] },
      })
      const world = await makeWorld(testDb.db, { settings })
      putGame(world.store, 'name-black', [{ x: 3, y: 3 }], 'Lee Changho', 'Kato')
      putGame(world.store, 'name-white', [{ x: 15, y: 15 }], 'Kato', 'lee changho')
      putGame(world.store, 'other', [{ x: 3, y: 15 }], 'Kato', 'Rin')
      putGame(world.store, 'override-out', [{ x: 15, y: 3 }], 'Lee Changho', 'Rin')
      putGame(world.store, 'override-in', [{ x: 9, y: 9 }], 'Kato', 'Rin')
      // A matching name the user marked "not mine" is excluded anyway; a
      // non-matching game marked "mine" is in.
      world.store.setIsMineOverride('override-out', false)
      world.store.setIsMineOverride('override-in', true)

      const snapshot = await world.batch.start('mine')
      expect(snapshot.total).toBe(3)
      await waitFor(() => lastEvent()?.status === 'done')
      expect(lastEvent()).toEqual({ status: 'done', total: 3, done: 3, failed: 0 })
      const gameIds = new Set(world.calls.map((call) => call.gameId))
      expect(gameIds).toEqual(new Set(['name-black', 'name-white', 'override-in']))
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('a not-ready engine rejects with its own typed code', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db, {
        locate: () => ({ kind: 'binary-missing', searched: '/virtual', mode: 'dev' }),
      })
      putGame(world.store, 'g1', [{ x: 3, y: 3 }])
      // Dev mode maps a missing binary to `unavailable` with no errorCode, so
      // the batch start surfaces the ENGINE_UNAVAILABLE family — not a
      // batch-specific invention.
      await expect(world.batch.start('all')).rejects.toMatchObject({
        code: 'ENGINE_UNAVAILABLE',
      })
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('changed content invalidates persisted rows through the store cascade', async () => {
    const testDb = createTestDb()
    try {
      const world = await makeWorld(testDb.db)
      putGame(world.store, 'g1', [{ x: 3, y: 3 }])
      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'done')
      expect(readRows(testDb.db, 'g1')).toHaveLength(1)

      // A re-import under changed content (same id, new hash and moves) must
      // drop the stale analysis — the store's delete-then-insert cascades.
      const revised = fixture('g1', 'Black', 'White', [
        { x: 3, y: 3 },
        { x: 15, y: 3 },
        { x: 3, y: 15 },
      ])
      revised.game.contentHash = 'g1-revised'
      world.store.put(revised)
      expect(world.repository.persistedMoves('g1')).toEqual([])
      expect(world.repository.ledger().get('g1')).toBeUndefined()

      // The next run re-analyses the new record from scratch.
      world.calls.length = 0
      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'done')
      expect(world.calls.map((call) => call.moveNumber).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3,
      ])
      expect(readRows(testDb.db, 'g1')).toHaveLength(3)
      expect(world.repository.ledger().get('g1')).toBe('done')
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })

  it('marks a game failed on a live-engine query error and retries it next run', async () => {
    const testDb = createTestDb()
    try {
      // `--garbage-on=batch` makes the fake answer batch queries with a
      // non-JSON line. The service's agent router ignores lines that do not
      // peek as JSON (engine chatter must not fail a query), so the queries
      // die on the deadline instead — still on a live, ready engine, which is
      // the per-game failure this tests. A short deadline keeps it quick.
      const world = await makeWorld(testDb.db, {
        args: ['--mode=analysis', '--garbage-on=batch'],
        probeDeadlineMs: 500,
      })
      putGame(world.store, 'g1', [{ x: 3, y: 3 }])

      await world.batch.start('all')
      await waitFor(() => lastEvent()?.status === 'done')
      // The run itself completes; the game is the failure count and failed in
      // the ledger, retried (re-queued) on the next run.
      expect(lastEvent()).toEqual({ status: 'done', total: 1, done: 0, failed: 1 })
      expect(world.repository.ledger().get('g1')).toBe('failed')

      // A retry on a healthy engine succeeds: failed games are work again.
      const world2 = await makeWorld(testDb.db)
      await world2.batch.start('all')
      await waitFor(
        () => progressEvents().length >= 2 && lastEvent()?.status === 'done',
      )
      expect(lastEvent()).toEqual({ status: 'done', total: 1, done: 1, failed: 0 })
      expect(world2.repository.ledger().get('g1')).toBe('done')
      expect(readRows(testDb.db, 'g1')).toHaveLength(1)
      await world2.close()
      await world.close()
    } finally {
      testDb.cleanup()
    }
  })
})
