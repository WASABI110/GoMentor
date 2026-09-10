import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AppError,
  type AnalysisResult,
  type Game,
  type GameSummary,
} from '@gomentor/shared'
import { createGameStore, type GameStore } from '../../../src/main/library/store'
import { openDatabase } from '../../../src/main/db/connection'
import type { EngineService } from '../../../src/main/katago/service'
import { AGENT_QUERY_VISITS } from '../../../src/main/katago/session'
import type { SgfCollection } from '@gomentor/core/sgf/ast'
import { parseSgf } from '@gomentor/core/sgf/parser'
import {
  PV_LIMIT,
  RECENT_MOVE_LIMIT,
  SEARCH_RESULT_LIMIT,
  TOP_CANDIDATE_LIMIT,
  checkMoveNumber,
  dispatchTool,
  filterGames,
  positionAt,
  summariseAnalysis,
  toolSchemas,
  type ToolContext,
  type ToolOutcome,
} from '../../../src/main/llm/agent/tools'

/**
 * The M3 agent tools' registry semantics and their pure cores.
 *
 * ## What is load-bearing here
 *
 * - **dispatch never throws for a tool-level failure.** A model that
 *   hallucinates an argument must get an `isError` result it can correct, not
 *   a dead run. Cancellation is the one exception, asserted explicitly.
 * - **bounds are inclusive and setup stones are not moves.** Cursor N means N
 *   moves applied; the position after the last move is askable; a handicap
 *   game's stones shift neither the numbering nor the side to move.
 * - **the filter's semantics** — case-insensitive, either colour for a player,
 *   AND across criteria, absent field never matches, capped with the true
 *   match count reported.
 * - **the analysis summary is bounded and engine-ranked** — candidates sorted
 *   by the engine's `order`, capped, GTP-spelled, pv truncated.
 */

const SIGNAL = new AbortController().signal

/**
 * A minimal but real collection. The DB-backed store serialises the AST into
 * the `sgf` column on `put` and re-parses it on `get`, so the fixture must
 * survive that round trip: an empty `roots` array serialises to zero bytes
 * and `get` would throw `SGF_EMPTY`. A hand-built AST with no backing bytes
 * was fine only under the Map, which never re-parsed.
 */
const COLLECTION: SgfCollection = parseSgf('(;GM[1]FF[4]CA[UTF-8]SZ[19])')

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    meta: {
      boardSize: 19,
      handicap: 0,
      komi: 6.5,
      blackName: 'Lee Changho',
      whiteName: 'Cho Hoonhyun',
      date: '2023-05-01',
      event: 'Title Match',
      ruleset: 'japanese',
    },
    setup: { black: [], white: [] },
    moves: [
      { number: 1, player: 'black', coord: { x: 3, y: 3 } },
      { number: 2, player: 'white', coord: { x: 15, y: 3 } },
      { number: 3, player: 'black', coord: null },
    ],
    branches: [],
    source: 'import',
    contentHash: 'g1',
    importedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * One real database for the file (DB-backed store since M4), cleared per
 * `storeWith` so each test sees exactly the games it named — the same
 * freshness the per-call in-memory `Map` used to provide. Closed only in
 * `afterAll`: Windows holds a lock on an open database file.
 */
const dbDir = mkdtempSync(join(tmpdir(), 'gomentor-tools-'))
const db = openDatabase(join(dbDir, 'library.db'))

afterAll(() => {
  db.close()
  rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function storeWith(games: Game[]): GameStore {
  const store = createGameStore(db)
  store.clear()
  for (const entry of games) store.put({ game: entry, collection: COLLECTION })
  return store
}

function analysisResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    queryId: 'agent:1',
    gameId: 'g1',
    moveNumber: 2,
    player: 'white',
    winrate: 0.42,
    scoreLead: -3.5,
    visits: 128,
    candidates: [
      {
        coord: { x: 2, y: 2 },
        winrate: 0.44,
        scoreLead: -3.2,
        visits: 90,
        order: 0,
        pv: [{ x: 2, y: 2 }, { x: 3, y: 3 }, null],
      },
      {
        coord: { x: 16, y: 2 },
        winrate: 0.4,
        scoreLead: -4.1,
        visits: 38,
        order: 1,
        pv: [{ x: 16, y: 2 }],
      },
    ],
    ownership: [0.3, -0.25, 0.75],
    complete: true,
    ...overrides,
  }
}

/**
 * A full stub of the `EngineService` interface — not a partial cast — so a
 * future interface addition fails this file's compile rather than silently
 * passing `undefined` through.
 */
function fakeEngine(
  analyzeOnce: EngineService['analyzeOnce'] = () => Promise.resolve(analysisResult()),
): EngineService {
  return {
    info: () => ({ status: 'unavailable' }),
    start: () => Promise.resolve({ status: 'unavailable' }),
    notifyStatus: () => undefined,
    setGame: () => ({ focusQueryId: null }),
    setCursor: () => ({ focusQueryId: null }),
    analyzeOnce,
    shutdown: () => Promise.resolve(),
  }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    engine: fakeEngine(),
    ...overrides,
    // Defaulted only when the caller supplied no store. An eager
    // `store: storeWith([])` above the spread would evaluate BEFORE the
    // spread merges the caller's store (object-literal properties all
    // evaluate in order) — and `storeWith` clears the shared database as its
    // first act, wiping the games the caller's store just put. With the
    // Map-backed store that clear was harmless (each storeWith made a fresh
    // Map); against one shared database it is destructive.
    store: overrides.store ?? storeWith([]),
  }
}

async function run(
  name: string,
  args: unknown,
  ctx: ToolContext = context(),
): Promise<ToolOutcome> {
  return dispatchTool(name, args, ctx, SIGNAL)
}

// ---------------------------------------------------------------------------
// Registry and dispatch semantics
// ---------------------------------------------------------------------------

describe('toolSchemas', () => {
  it('derives one wire schema per tool, names unique', () => {
    const schemas = toolSchemas()
    expect(schemas.map((schema) => schema.name)).toEqual([
      'get_position',
      'get_analysis',
      'search_library',
    ])
    expect(new Set(schemas.map((schema) => schema.name)).size).toBe(schemas.length)
  })

  it('emits a JSON object schema with the zod constraints, and no $schema key', () => {
    const position = toolSchemas().find((schema) => schema.name === 'get_position')
    expect(position).toBeDefined()
    const parameters = position?.parameters as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
      $schema?: unknown
    }
    expect(parameters.type).toBe('object')
    expect(Object.keys(parameters.properties ?? {})).toEqual(
      expect.arrayContaining(['gameId', 'moveNumber']),
    )
    // `gameId` is optional; `moveNumber` is not.
    expect(parameters.required).toEqual(['moveNumber'])
    expect(parameters.$schema).toBeUndefined()
  })

  it('describes the analysis budget with the constant that delivers it', () => {
    // The description is the promise the model reads; the constant is what the
    // engine is told. One number, one place.
    const analysis = toolSchemas().find((schema) => schema.name === 'get_analysis')
    expect(analysis?.description).toContain(String(AGENT_QUERY_VISITS))
    expect(AGENT_QUERY_VISITS).toBe(128)
  })
})

describe('dispatchTool', () => {
  it('reports an unknown tool as an isError result naming the alternatives', async () => {
    const outcome = await run('get_weather', {})
    expect(outcome.isError).toBe(true)
    // The header's mapping is a promise to the caller: an invalid *request*
    // carries the same code `ipc/register.ts` would give it.
    expect(outcome.content).toContain('IPC_INVALID_REQUEST')
    expect(outcome.content).toContain('get_weather')
    expect(outcome.content).toContain('get_position')
    expect(outcome.content).toContain('search_library')
  })

  it.each([
    ['missing moveNumber', { gameId: 'g1' }, 'moveNumber'],
    ['negative moveNumber', { moveNumber: -1 }, 'moveNumber'],
    ['fractional moveNumber', { moveNumber: 1.5 }, 'moveNumber'],
    ['empty-string gameId', { gameId: '', moveNumber: 1 }, 'gameId'],
    ['wrong-typed moveNumber', { moveNumber: 'two' }, 'moveNumber'],
  ])(
    'returns an isError result for %s instead of throwing',
    async (_label, args, path) => {
      const ctx = context({ store: storeWith([game()]) })
      const outcome = await run('get_position', args, ctx)
      // Not thrown: the model gets something it can read and correct.
      expect(outcome.isError).toBe(true)
      expect(outcome.content).toContain('IPC_INVALID_REQUEST')
      expect(outcome.content).toContain('invalid arguments')
      expect(outcome.content).toContain(path)
    },
  )

  it('reports a typed domain failure as an isError result carrying the code', async () => {
    const outcome = await run('get_position', { gameId: 'missing', moveNumber: 1 })
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('LIBRARY_NOT_FOUND')
  })

  it('reports an engine failure as an isError result, not a throw', async () => {
    const engine = fakeEngine(() =>
      Promise.reject(
        new AppError('ENGINE_UNAVAILABLE', 'the engine is unavailable, not ready'),
      ),
    )
    const outcome = await run(
      'get_analysis',
      { gameId: 'g1', moveNumber: 2 },
      context({ store: storeWith([game()]), engine }),
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('ENGINE_UNAVAILABLE')
  })

  it('re-throws cancellation instead of reporting it as a tool result', async () => {
    const engine = fakeEngine(() =>
      Promise.reject(new AppError('LLM_ABORTED', 'the analysis query was cancelled')),
    )
    await expect(
      run(
        'get_analysis',
        { gameId: 'g1', moveNumber: 2 },
        context({ store: storeWith([game()]), engine }),
      ),
    ).rejects.toMatchObject({ code: 'LLM_ABORTED' })
  })

  it('re-throws when the signal is already dead, even if the tool would succeed', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      dispatchTool(
        'get_position',
        { gameId: 'g1', moveNumber: 1 },
        context({ store: storeWith([game()]) }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'LLM_ABORTED' })
  })

  it('contains a non-typed crash as an isError result and still reports it', async () => {
    const engine = fakeEngine(() => Promise.reject(new TypeError('real bug')))
    const outcome = await run(
      'get_analysis',
      { gameId: 'g1', moveNumber: 2 },
      context({ store: storeWith([game()]), engine }),
    )
    expect(outcome.isError).toBe(true)
    // The raw bug text does not ride back to the model.
    expect(outcome.content).not.toContain('real bug')
  })
})

// ---------------------------------------------------------------------------
// get_position: bounds, setup stones, side to move
// ---------------------------------------------------------------------------

describe('positionAt', () => {
  it('summarises the position at a move number with 1-based numbering', () => {
    const summary = positionAt(game(), 2)
    expect(summary.moveAtNumber).toEqual({ player: 'white', coord: { x: 15, y: 3 } })
    expect(summary.playerToMove).toBe('black')
    expect(summary.recentMoves).toEqual([
      { number: 1, player: 'black', coord: { x: 3, y: 3 } },
      { number: 2, player: 'white', coord: { x: 15, y: 3 } },
    ])
    expect(summary.moveCount).toBe(3)
  })

  it('has no move at number 0 and reports the opening side to move', () => {
    const summary = positionAt(game(), 0)
    expect(summary.moveAtNumber).toBeUndefined()
    expect(summary.playerToMove).toBe('black')
    expect(summary.recentMoves).toEqual([])
  })

  it('accepts the position after the last move (the bound is inclusive)', () => {
    const summary = positionAt(game(), 3)
    expect(summary.moveAtNumber).toEqual({ player: 'black', coord: null })
    // After black's pass, white is to move.
    expect(summary.playerToMove).toBe('white')
    expect(summary.recentMoves).toHaveLength(3)
  })

  it('does not count setup stones as moves, and a handicap game is played white-first', () => {
    const handicap = game({
      setup: {
        black: [
          { x: 3, y: 3 },
          { x: 15, y: 3 },
          { x: 9, y: 9 },
        ],
        white: [],
      },
      // In a handicap game white plays first, so move 1 is white's — the
      // numbering is unchanged by the stones that were already on the board.
      moves: [{ number: 1, player: 'white', coord: { x: 15, y: 15 } }],
    })
    const atZero = positionAt(handicap, 0)
    expect(atZero.setupStones).toEqual({ black: 3, white: 0 })
    expect(atZero.moveCount).toBe(1)
    // The side to move at 0 is the player of move 1: white.
    expect(atZero.playerToMove).toBe('white')
    expect(atZero.moveAtNumber).toBeUndefined()

    const atOne = positionAt(handicap, 1)
    expect(atOne.moveAtNumber).toEqual({ player: 'white', coord: { x: 15, y: 15 } })
    expect(atOne.playerToMove).toBe('black')
  })

  it('flips the empty-record side to move for handicap stones', () => {
    // No moves at all: KataGo picks White when handicap stones are on the
    // board, and `playerToMoveAt` mirrors that so results are labelled right.
    const emptyHandicap = game({
      setup: { black: [{ x: 9, y: 9 }], white: [] },
      moves: [],
    })
    expect(positionAt(emptyHandicap, 0).playerToMove).toBe('white')
  })

  it('bounds the recent-move window to the limit with correct 1-based numbers', () => {
    const long = game({
      moves: Array.from({ length: 12 }, (_, index) => ({
        number: index + 1,
        player: index % 2 === 0 ? ('black' as const) : ('white' as const),
        coord: { x: index, y: index },
      })),
    })
    const summary = positionAt(long, 12)
    expect(RECENT_MOVE_LIMIT).toBe(5)
    expect(summary.recentMoves.map((move) => move.number)).toEqual([8, 9, 10, 11, 12])
    expect(summary.recentMoves.at(-1)).toEqual({
      number: 12,
      player: 'white',
      coord: { x: 11, y: 11 },
    })
    // Early in the record the window is the whole prefix so far.
    expect(positionAt(long, 3).recentMoves.map((move) => move.number)).toEqual([
      1, 2, 3,
    ])
  })

  it('returns only the window before the queried position, never the moves after it', () => {
    const summary = positionAt(game(), 1)
    expect(summary.recentMoves).toEqual([
      { number: 1, player: 'black', coord: { x: 3, y: 3 } },
    ])
    // Move 3 is the future of the position at 1 — a player cannot have seen it.
    expect(JSON.stringify(summary)).not.toContain('"number":3')
  })

  it('carries the compact metadata, never the whole record', () => {
    const summary = positionAt(game(), 2)
    const text = JSON.stringify(summary)
    expect(text).not.toContain('"moves":')
    expect(text).not.toContain('"branches":')
    // A pass is spelled the way the contract spells it, not dropped.
    expect(positionAt(game(), 3).recentMoves.at(-1)?.coord).toBeNull()
  })
})

describe('checkMoveNumber', () => {
  it('accepts both ends of the 0..moveCount range', () => {
    expect(checkMoveNumber(game(), 0)).toBe(0)
    expect(checkMoveNumber(game(), 3)).toBe(3)
  })

  it('rejects out-of-range with the record bound in the message', () => {
    expect(() => checkMoveNumber(game(), 4)).toThrow(/0\.\.3/)
    expect(() => checkMoveNumber(game(), 4)).toThrow(AppError)
    expect(() => checkMoveNumber(game(), -1)).toThrow(AppError)
  })
})

describe('get_position dispatch', () => {
  it('defaults the game to the one open in the chat context', async () => {
    const ctx = context({ store: storeWith([game()]), gameId: 'g1' })
    const outcome = await run('get_position', { moveNumber: 2 }, ctx)
    expect(outcome.isError).toBe(false)
    const parsed = JSON.parse(outcome.content) as { gameId: string; moveCount: number }
    expect(parsed.gameId).toBe('g1')
    expect(parsed.moveCount).toBe(3)
  })

  it('asks which game when neither the call nor the context names one', async () => {
    const outcome = await run('get_position', { moveNumber: 1 })
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('LIBRARY_NOT_FOUND')
    expect(outcome.content).toContain('no game is open')
  })

  it('reports an out-of-range move number as an error the model can correct', async () => {
    const outcome = await run(
      'get_position',
      { gameId: 'g1', moveNumber: 99 },
      context({ store: storeWith([game()]) }),
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('0..3')
  })
})

// ---------------------------------------------------------------------------
// search_library: the filter's semantics
// ---------------------------------------------------------------------------

describe('filterGames', () => {
  const library: GameSummary[] = [
    {
      id: 'a',
      blackName: 'Lee Changho',
      whiteName: 'Cho Hoonhyun',
      date: '2023-05-01',
      event: 'Judi Wang',
      moveCount: 200,
      boardSize: 19,
      source: 'import',
    },
    {
      id: 'b',
      blackName: 'Gu Li',
      whiteName: 'lee sedol',
      date: '2019-11-30',
      moveCount: 150,
      boardSize: 19,
      source: 'import',
    },
    {
      id: 'c',
      blackName: 'someone',
      whiteName: 'else',
      date: '2023-05-02',
      event: 'Nongshim',
      moveCount: 100,
      boardSize: 13,
      source: 'fox',
    },
  ]

  it('matches a player against either colour, case-insensitively', () => {
    expect(filterGames(library, { player: 'lee' }).results.map((r) => r.id)).toEqual([
      'a',
      'b',
    ])
    expect(filterGames(library, { player: 'GU LI' }).results.map((r) => r.id)).toEqual([
      'b',
    ])
  })

  it('matches event and date as substrings', () => {
    expect(filterGames(library, { event: 'wangle' }).results.map((r) => r.id)).toEqual(
      [],
    )
    expect(filterGames(library, { event: 'Wang' }).results.map((r) => r.id)).toEqual([
      'a',
    ])
    // A year matches inside the ISO date.
    expect(filterGames(library, { date: '2023' }).results.map((r) => r.id)).toEqual([
      'a',
      'c',
    ])
  })

  it('ANDs the criteria that are present', () => {
    const both = filterGames(library, { player: 'lee', date: '2023' })
    expect(both.results.map((r) => r.id)).toEqual(['a'])
    // Game b matches the player but carries no event: the event criterion must
    // exclude it, not be skipped.
    expect(
      filterGames(library, { player: 'lee', event: 'Wang' }).results.map((r) => r.id),
    ).toEqual(['a'])
  })

  it('never matches a criterion against an absent field', () => {
    // Game b carries no event; an event criterion must skip it, not match it.
    expect(filterGames(library, { event: 'x' }).results).toEqual([])
    // Same for a date criterion against a record with no date.
    const undated: GameSummary = {
      id: 'undated',
      blackName: 'someone',
      whiteName: 'else',
      moveCount: 1,
      boardSize: 19,
      source: 'import',
    }
    expect(filterGames([undated], { date: '2023' }).results).toEqual([])
  })

  it('caps the results and reports the true match count', () => {
    const many: GameSummary[] = Array.from(
      { length: SEARCH_RESULT_LIMIT + 4 },
      (_, i) => ({
        id: String(i),
        blackName: 'same',
        whiteName: 'same',
        moveCount: 1,
        boardSize: 19,
        source: 'import',
      }),
    )
    const result = filterGames(many, { player: 'same' })
    expect(result.matched).toBe(SEARCH_RESULT_LIMIT + 4)
    expect(result.results).toHaveLength(SEARCH_RESULT_LIMIT)
    expect(SEARCH_RESULT_LIMIT).toBe(10)
  })

  it('with no criteria, returns the first records in the given order', () => {
    const result = filterGames(library, {})
    expect(result.matched).toBe(3)
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('search_library dispatch', () => {
  it('returns summaries through the real store', async () => {
    const ctx = context({
      store: storeWith([game(), game({ id: 'g2', contentHash: 'g2' })]),
    })
    const outcome = await run('search_library', { player: 'cho hoonhyun' }, ctx)
    expect(outcome.isError).toBe(false)
    const parsed = JSON.parse(outcome.content) as {
      matched: number
      results: { id: string; event?: string }[]
    }
    expect(parsed.matched).toBe(2)
    expect(parsed.results.map((r) => r.id)).toEqual(['g2', 'g1'])
    expect(parsed.results[0]?.event).toBe('Title Match')
  })

  it('rejects empty-string criteria at the schema, so a criterion is always a filter', async () => {
    const outcome = await run('search_library', { player: '' })
    expect(outcome.isError).toBe(true)
    expect(outcome.content).toContain('player')
  })
})

// ---------------------------------------------------------------------------
// get_analysis: the summary projection
// ---------------------------------------------------------------------------

describe('summariseAnalysis', () => {
  it('spells coordinates in GTP for the board analysed, and passes as pass', () => {
    const summary = summariseAnalysis(analysisResult(), 19)
    expect(summary.candidates[0]?.move).toBe('C17')
    expect(summary.candidates[0]?.pv).toEqual(['C17', 'D16', 'pass'])
  })

  it('is correct on a small board, where a wrong board size spells a wrong point', () => {
    // Coords in bounds for 9×9: (2,2) is C7 there, C17 on 19×19.
    const small = analysisResult({
      candidates: [
        {
          coord: { x: 2, y: 2 },
          winrate: 0.44,
          scoreLead: -3.2,
          visits: 90,
          order: 0,
          pv: [{ x: 2, y: 2 }],
        },
        {
          coord: { x: 6, y: 6 },
          winrate: 0.4,
          scoreLead: -4.1,
          visits: 38,
          order: 1,
          pv: [],
        },
      ],
    })
    const summary = summariseAnalysis(small, 9)
    expect(summary.candidates[0]?.move).toBe('C7')
    expect(summary.candidates[1]?.move).toBe('G3')
  })

  it('orders candidates by the engine rank, not array position', () => {
    const shuffled = analysisResult({
      candidates: [
        {
          coord: { x: 16, y: 2 },
          winrate: 0.4,
          scoreLead: -4.1,
          visits: 38,
          order: 1,
          pv: [],
        },
        {
          coord: { x: 2, y: 2 },
          winrate: 0.44,
          scoreLead: -3.2,
          visits: 90,
          order: 0,
          pv: [],
        },
      ],
    })
    const summary = summariseAnalysis(shuffled, 19)
    expect(summary.candidates[0]?.move).toBe('C17')
    // Index 16 skips the GTP `I`: the column is R, not Q.
    expect(summary.candidates[1]?.move).toBe('R17')
    expect(summary.candidates).toHaveLength(2)
  })

  it('caps candidates and pv plies', () => {
    const wide = analysisResult({
      candidates: Array.from({ length: 6 }, (_, order) => ({
        coord: { x: order, y: 0 },
        winrate: 0.5,
        scoreLead: 0,
        visits: 10,
        order,
        pv: Array.from({ length: 12 }, (_, ply) => ({ x: ply, y: 1 })),
      })),
    })
    const summary = summariseAnalysis(wide, 19)
    expect(TOP_CANDIDATE_LIMIT).toBe(3)
    expect(PV_LIMIT).toBe(6)
    expect(summary.candidates).toHaveLength(3)
    expect(summary.candidates[0]?.pv).toHaveLength(6)
  })

  it('summarises ownership as one rounded net number, and omits it when absent', () => {
    // The fixture sums to 0.8: the round is a decision, not a no-op.
    expect(summariseAnalysis(analysisResult(), 19).ownershipNetPoints).toBe(1)
    const { ownership: _absent, ...none } = analysisResult()
    const withoutOwnership = summariseAnalysis({ ...none, ownership: undefined }, 19)
    expect('ownershipNetPoints' in withoutOwnership).toBe(false)
  })

  it('passes the quoted numbers through unchanged', () => {
    const summary = summariseAnalysis(analysisResult(), 19)
    expect(summary.winrate).toBe(0.42)
    expect(summary.scoreLead).toBe(-3.5)
    expect(summary.visits).toBe(128)
    expect(summary.player).toBe('white')
  })
})

describe('get_analysis dispatch', () => {
  it('hands the engine the projected engine game and returns the summary', async () => {
    const queried: { moveNumber: number; gameId: unknown }[] = []
    const engine = fakeEngine((engineGame, moveNumber) => {
      queried.push({ moveNumber, gameId: (engineGame as { gameId: string }).gameId })
      return Promise.resolve(analysisResult())
    })
    const outcome = await run(
      'get_analysis',
      { gameId: 'g1', moveNumber: 2 },
      context({ store: storeWith([game()]), engine }),
    )
    expect(outcome.isError).toBe(false)
    expect(queried).toEqual([{ moveNumber: 2, gameId: 'g1' }])
    const parsed = JSON.parse(outcome.content) as {
      moveNumber: number
      candidates: { move: string }[]
    }
    expect(parsed.moveNumber).toBe(2)
    expect(parsed.candidates).toHaveLength(2)
  })

  it('validates the move bound before spending engine work', async () => {
    let queries = 0
    const engine = fakeEngine(() => {
      queries += 1
      return Promise.resolve(analysisResult())
    })
    const outcome = await run(
      'get_analysis',
      { gameId: 'g1', moveNumber: 99 },
      context({ store: storeWith([game()]), engine }),
    )
    expect(outcome.isError).toBe(true)
    expect(queries).toBe(0)
  })
})
