import { describe, expect, it } from 'vitest'
import type { EngineGame } from '@gomentor/shared'
import {
  buildFocusQuery,
  buildSweepQuery,
  createAnalysisSession,
  playerToMoveAt,
  toKataGoRuleset,
} from '../../../src/main/katago/session'
import {
  SWEEP_CONCURRENCY,
  SWEEP_MAX_VISITS,
  createSweepLedger,
  markSweepComplete,
  markSweepFailed,
} from '../../../src/main/katago/sweep'
import type { Logger } from '../../../src/main/logger'

/**
 * The live-analysis session's pure construction helpers plus its mechanics
 * against a manual timer seam (no real clock: debounce and coalesce timers are
 * captured and fired by hand).
 *
 * ## What is load-bearing here
 *
 * - the record prefix is what gets analysed — `buildFocusQuery` slices at the
 *   cursor and clamps, so a seek past the end studies the final position, not
 *   an error and not the whole record;
 * - setup stones ride as `initialStones`, keeping a handicap game's parity
 *   (the M1 setup-field fix, now on the engine path);
 * - `setGame` issues immediately, `setCursor` debounces latest-wins under the
 *   id it eagerly allocated — the caller correlates against that id, so it must
 *   be the id on the wire when the timer fires;
 * - a superseded focus query is terminated via the production
 *   `encodeTerminateRequest`, and its mandated final reply is routed by id and
 *   dropped, never emitted;
 * - a wrong-length ownership array (B4) is a typed rejection the session
 *   survives — the next valid line still parses;
 * - perspective normalisation is applied before emission (white-to-move
 *   scoreLead arrives negated).
 */

const SETTINGS = {
  get: () => ({ engine: { maxVisits: 500, analyzeOwnership: true } }),
}

/** A logger that swallows everything, so a green run prints nothing. */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  failure: () => undefined,
}

function engineGame(overrides: Partial<EngineGame> = {}): EngineGame {
  return {
    gameId: 'g1',
    boardSize: 19,
    komi: 6.5,
    rules: 'japanese',
    setup: { black: [], white: [] },
    moves: [
      { player: 'black', coord: { x: 3, y: 3 } },
      { player: 'white', coord: { x: 15, y: 3 } },
    ],
    ...overrides,
  }
}

/** One canned response line in the analysis protocol, `D4` valid on any size. */
function analysisLine(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    rootInfo: { visits: 10, winrate: 0.55, scoreLead: 1.5 },
    moveInfos: [
      { move: 'D4', visits: 8, winrate: 0.55, scoreLead: 1.5, order: 0, pv: ['D4'] },
    ],
    ...overrides,
  })
}

/** A record long enough to exceed the sweep's concurrency window. */
function longGame(moves: number): EngineGame {
  return engineGame({
    moves: Array.from({ length: moves }, (_, index) => ({
      player: index % 2 === 0 ? 'black' : 'white',
      coord: { x: 3, y: 3 },
    })),
  })
}

interface Scheduled {
  fn: () => void
  ms: number
  cancelled: boolean
}

/** Captures timers instead of scheduling them; tests fire the one they mean. */
function timerSeam() {
  const timers: Scheduled[] = []
  return {
    setTimer: (fn: () => void, ms: number) => {
      const entry: Scheduled = { fn, ms, cancelled: false }
      timers.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    fire: (ms: number) => {
      const index = timers.findIndex((timer) => !timer.cancelled && timer.ms === ms)
      if (index === -1) throw new Error(`no live timer with ms=${String(ms)}`)
      const timer = timers[index]
      timers.splice(index, 1)
      timer?.fn()
    },
    liveCount: () => timers.filter((timer) => !timer.cancelled).length,
  }
}

function requestIds(sent: readonly string[]): string[] {
  return sent
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['action'] !== 'terminate')
    .map((record) => String(record['id']))
}

function terminateIds(sent: readonly string[]): string[] {
  return sent
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['action'] === 'terminate')
    .map((record) => String(record['id']))
}

/** The decoded request line sent under a given id (fails when none was sent). */
function requestRecord(sent: readonly string[], id: string): Record<string, unknown> {
  const line = sent.find((entry) => {
    try {
      const record = JSON.parse(entry) as Record<string, unknown>
      return record['id'] === id && record['action'] !== 'terminate'
    } catch {
      return false
    }
  })
  if (line === undefined) throw new Error(`no request sent for ${id}`)
  return JSON.parse(line) as Record<string, unknown>
}

describe('playerToMoveAt', () => {
  it('is the player of the move at the cursor index', () => {
    expect(playerToMoveAt(engineGame(), 0)).toBe('black')
    expect(playerToMoveAt(engineGame(), 1)).toBe('white')
  })

  it('at the end of the record is the opposite of the last move', () => {
    expect(playerToMoveAt(engineGame(), 2)).toBe('black')
  })

  it('with no moves is black, or white when handicap stones wait to be answered', () => {
    expect(
      playerToMoveAt(engineGame({ moves: [], setup: { black: [], white: [] } }), 0),
    ).toBe('black')
    // KataGo's analysis engine picks White after a handicap placement
    // (`initialPlayer` in cpp/command/analysis.cpp); the recorded player must
    // match what was analysed.
    expect(
      playerToMoveAt(
        engineGame({ moves: [], setup: { black: [{ x: 3, y: 3 }], white: [] } }),
        0,
      ),
    ).toBe('white')
  })
})

describe('toKataGoRuleset', () => {
  it('maps the spellings KataGo names', () => {
    expect(toKataGoRuleset('japanese')).toBe('japanese')
    expect(toKataGoRuleset('korean')).toBe('korean')
    expect(toKataGoRuleset('aga')).toBe('aga')
    expect(toKataGoRuleset('bga')).toBe('aga')
    expect(toKataGoRuleset('french')).toBe('aga')
    expect(toKataGoRuleset('tromp-taylor')).toBe('tromp-taylor')
    expect(toKataGoRuleset('chinese')).toBe('chinese')
  })

  it('normalises case and surrounding whitespace', () => {
    expect(toKataGoRuleset('  JAPANESE ')).toBe('japanese')
    expect(toKataGoRuleset('Tromp Taylor')).toBe('tromp-taylor')
  })

  it('falls back to chinese for anything unrecognised, including absence and NZ', () => {
    // Area scoring, which is what `board/rules.ts` computes — the fallback is
    // chosen so an engine score and our score stay comparable. NZ maps here too
    // (no NZ member in our ruleset list), and silence is what this must not be.
    expect(toKataGoRuleset('')).toBe('chinese')
    expect(toKataGoRuleset('NZ')).toBe('chinese')
    expect(toKataGoRuleset('GOE')).toBe('chinese')
  })
})

describe('buildFocusQuery', () => {
  const game = engineGame({
    setup: { black: [{ x: 3, y: 3 }], white: [] },
    moves: [
      { player: 'black', coord: { x: 3, y: 3 } },
      { player: 'white', coord: { x: 15, y: 3 } },
      { player: 'black', coord: { x: 3, y: 15 } },
    ],
  })

  it('sends only the record prefix up to the cursor', () => {
    const query = buildFocusQuery('focus:1', game, 2, SETTINGS.get().engine)
    expect(query.moves).toHaveLength(2)
    expect(query.moves.at(-1)).toEqual({ player: 'white', coord: { x: 15, y: 3 } })
  })

  it('clamps a cursor past the end to the whole record, and below 0 to nothing', () => {
    expect(
      buildFocusQuery('focus:1', game, 99, SETTINGS.get().engine).moves,
    ).toHaveLength(3)
    expect(
      buildFocusQuery('focus:1', game, -5, SETTINGS.get().engine).moves,
    ).toHaveLength(0)
  })

  it('carries setup stones as initialStones, not as moves', () => {
    const query = buildFocusQuery('focus:1', game, 0, SETTINGS.get().engine)
    expect(query.moves).toHaveLength(0)
    expect(query.initialStones).toEqual([{ player: 'black', coord: { x: 3, y: 3 } }])
  })

  it('maps rules and flows the engine settings, with streaming reports in seconds', () => {
    const query = buildFocusQuery('focus:1', game, 0, SETTINGS.get().engine)
    expect(query.rules).toBe('japanese')
    expect(query.maxVisits).toBe(500)
    expect(query.includeOwnership).toBe(true)
    expect(query.reportDuringSearchEvery).toBeGreaterThan(0)
    expect(query.id).toBe('focus:1')
  })
})

describe('buildSweepQuery', () => {
  const game = engineGame({
    setup: { black: [{ x: 3, y: 3 }], white: [] },
    moves: [
      { player: 'black', coord: { x: 3, y: 3 } },
      { player: 'white', coord: { x: 15, y: 3 } },
      { player: 'black', coord: { x: 3, y: 15 } },
    ],
  })

  it('carries the sweep contract: fixed visit cap, no ownership, no streaming reports', () => {
    const query = buildSweepQuery('sweep:0', game, 0)
    // The three differences from focus are the whole point of the tier
    // (`sweep.ts` §What the sweep is) — each one is asserted, not implied:
    // the graph never paints ownership, and a sweep partial is noise, so the
    // query neither asks for the tensor nor for mid-search reports.
    expect(query.maxVisits).toBe(SWEEP_MAX_VISITS)
    expect(query.includeOwnership).toBe(false)
    expect('reportDuringSearchEvery' in query).toBe(false)
    expect(query.id).toBe('sweep:0')
  })

  it('slices the record prefix and carries setup as initialStones like focus does', () => {
    const query = buildSweepQuery('sweep:2', game, 2)
    expect(query.moves).toHaveLength(2)
    expect(query.moves.at(-1)).toEqual({ player: 'white', coord: { x: 15, y: 3 } })
    expect(query.initialStones).toEqual([{ player: 'black', coord: { x: 3, y: 3 } }])
    expect(query.rules).toBe('japanese')
  })

  it('clamps the cursor exactly like the focus query', () => {
    expect(buildSweepQuery('sweep:1', game, 99).moves).toHaveLength(3)
    expect(buildSweepQuery('sweep:1', game, -5).moves).toHaveLength(0)
  })
})

describe('createAnalysisSession', () => {
  it('setGame issues a focus query immediately under a fresh id', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })

    const id = session.setGame(engineGame(), 2)
    expect(id).toBe('focus:1')
    expect(requestIds(sent)).toEqual(['focus:1'])
    session.dispose()
  })

  it('setCursor holds the move, latest-wins, and issues under the eagerly allocated id', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      debounceMs: 50,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)

    const first = session.setCursor(1)
    const second = session.setCursor(0)
    expect(first).toBe('focus:2')
    expect(second).toBe('focus:3')
    // Nothing issued while the debounce runs.
    expect(requestIds(sent)).toEqual(['focus:1'])

    seam.fire(50)
    // The LAST held position wins, under the id its caller was given.
    expect(requestIds(sent)).toEqual(['focus:1', 'focus:3'])
    session.dispose()
  })

  it('a superseded focus query is terminated before the replacement is sent', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      debounceMs: 50,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.setCursor(1)
    seam.fire(50)

    expect(terminateIds(sent)).toEqual(['focus:1'])
    // Terminate precedes the new request on the wire: the engine must know the
    // old id is dead before (or as) it starts the new query.
    const kinds = sent.map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>
      return record['action'] === 'terminate' ? 'terminate' : 'request'
    })
    expect(kinds).toEqual(['request', 'terminate', 'request'])
    session.dispose()
  })

  it('the mandated final reply of a terminated query is dropped, never emitted', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const emitted: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      debounceMs: 50,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.setCursor(1)
    seam.fire(50) // focus:2 issued, focus:1 terminated

    session.handleLine(analysisLine('focus:1')) // the late final reply
    session.handleLine(analysisLine('focus:2'))
    expect(emitted).toEqual(['focus:2'])
    session.dispose()
  })

  it('routes by wire id: a reply for an unknown id is ignored, not an error', () => {
    const seam = timerSeam()
    const emitted: string[] = []
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)

    session.handleLine(analysisLine('gomentor-probe'))
    session.handleLine('this is not JSON at all')
    session.handleLine(JSON.stringify({ noId: true }))
    expect(emitted).toEqual([])
    session.dispose()
  })

  it('applies the perspective adaptation before emission', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const results: number[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: (result) => results.push(result.scoreLead),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    // White to move at the cursor: the wire says +1.5 for White; the contract
    // wants positive-favours-black, so the emitted value must be -1.5.
    session.setGame(
      engineGame({ moves: [{ player: 'white', coord: { x: 3, y: 3 } }] }),
      0,
    )
    session.handleLine(analysisLine('focus:1'))
    expect(results).toEqual([-1.5])
    session.dispose()
  })

  it('rejects a wrong-length ownership array as a typed failure and survives it', () => {
    const seam = timerSeam()
    const warns: string[] = []
    const logger: Logger = { ...silentLogger, warn: (msg) => warns.push(msg) }
    const emitted: string[] = []
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger,
    })
    session.setGame(engineGame(), 2)

    // 4 values where 19×19 expects 361 — B4's rejection, live. The session must
    // log it and stay usable: the next valid line still parses and emits.
    session.handleLine(analysisLine('focus:1', { ownership: [0.1, 0.2, 0.3, 0.4] }))
    expect(emitted).toEqual([])
    expect(warns.some((msg) => msg.includes('analysis result rejected'))).toBe(true)

    session.handleLine(analysisLine('focus:1'))
    expect(emitted).toEqual(['focus:1'])
    session.dispose()
  })

  it('coalesces partials per query: a fast second partial waits for the flush', () => {
    const seam = timerSeam()
    const emitted: number[] = []
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: (result) => {
        emitted.push(result.visits)
      },
      settings: SETTINGS,
      coalesceIntervalMs: 50,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)

    session.handleLine(
      analysisLine('focus:1', {
        isDuringSearch: true,
        rootInfo: { visits: 1, winrate: 0.5, scoreLead: 0 },
      }),
    )
    session.handleLine(
      analysisLine('focus:1', {
        isDuringSearch: true,
        rootInfo: { visits: 2, winrate: 0.5, scoreLead: 0 },
      }),
    )
    // First partial emitted immediately; the second is held inside the window.
    expect(emitted).toEqual([1])

    seam.fire(50) // the coalescer's flush timer
    expect(emitted).toEqual([1, 2])
    session.dispose()
  })

  it('a complete result is urgent: it bypasses the coalesce window', () => {
    const seam = timerSeam()
    const emitted: number[] = []
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: (result) => {
        emitted.push(result.visits)
      },
      settings: SETTINGS,
      coalesceIntervalMs: 50,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.handleLine(
      analysisLine('focus:1', {
        isDuringSearch: true,
        rootInfo: { visits: 1, winrate: 0.5, scoreLead: 0 },
      }),
    )
    session.handleLine(
      analysisLine('focus:1', {
        isDuringSearch: true,
        rootInfo: { visits: 2, winrate: 0.5, scoreLead: 0 },
      }),
    )
    // The settled verdict arrives a beat later — the user must not wait a whole
    // interval for the number the search ended on.
    session.handleLine(
      analysisLine('focus:1', { rootInfo: { visits: 3, winrate: 0.5, scoreLead: 0 } }),
    )
    expect(emitted).toEqual([1, 3])
    // No flush timer left holding the urgent tick's predecessor.
    expect(seam.liveCount()).toBe(0)
    session.dispose()
  })

  it('clearGame drops the record and terminates the in-flight focus query', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.clearGame()
    expect(terminateIds(sent)).toEqual(['focus:1'])

    // A late reply after clearing finds no expectation and nothing is emitted;
    // setCursor without a record is a contract violation and says so.
    expect(() => session.setCursor(0)).toThrow(/no game held/)
    session.dispose()
  })

  it('dispose cancels a held cursor and ignores everything afterwards', () => {
    const seam = timerSeam()
    const emitted: string[] = []
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      debounceMs: 50,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.setCursor(1)
    session.dispose()

    expect(seam.liveCount()).toBe(0)
    session.handleLine(analysisLine('focus:1'))
    expect(emitted).toEqual([])
  })
})

describe('the whole-record sweep (Stage 4)', () => {
  it('startSweep with no held record is a contract violation', () => {
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: () => undefined,
      settings: SETTINGS,
      logger: silentLogger,
    })
    expect(() => {
      session.startSweep(createSweepLedger(2))
    }).toThrow(/no game held/)
    session.dispose()
  })

  it('issues one sweep:<n> query per position 0..moveCount, none carrying ownership', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.startSweep(createSweepLedger(2))

    expect(requestIds(sent)).toEqual(['focus:1', 'sweep:0', 'sweep:1', 'sweep:2'])
    for (const id of ['sweep:0', 'sweep:1', 'sweep:2']) {
      const request = requestRecord(sent, id)
      expect(request['includeOwnership']).toBeUndefined()
      expect(request['reportDuringSearchEvery']).toBeUndefined()
      expect(request['maxVisits']).toBe(SWEEP_MAX_VISITS)
      // The position analysed is the prefix: sweep:1 studies one move applied.
      expect(request['moves']).toHaveLength(Number(id.slice('sweep:'.length)))
    }
    session.dispose()
  })

  it('fills the concurrency window, then pumps the next issue as completions land', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const emitted: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(longGame(20), 0)
    session.startSweep(createSweepLedger(20))

    // Window full: SWEEP_CONCURRENCY queries, lowest moves first, and nothing
    // beyond — the pump must not flood the in-flight map.
    const firstWave = requestIds(sent).filter((id) => id.startsWith('sweep:'))
    expect(firstWave).toEqual(
      Array.from({ length: SWEEP_CONCURRENCY }, (_, move) => `sweep:${String(move)}`),
    )

    // One completion frees a slot: the next unissued move is pumped.
    session.handleLine(analysisLine('sweep:0'))
    expect(emitted).toEqual(['sweep:0'])
    expect(requestIds(sent).filter((id) => id.startsWith('sweep:'))).toContain(
      'sweep:8',
    )
    session.dispose()
  })

  it('a partial sweep tick is dropped, never emitted; the complete tick lands and marks the ledger', () => {
    const seam = timerSeam()
    const emitted: string[] = []
    const ledger = createSweepLedger(2)
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.startSweep(ledger)

    // Mid-search noise: the graph paints settled points only, so this must not
    // reach the renderer — and must not be mistaken for the completion either.
    session.handleLine(
      analysisLine('sweep:0', {
        isDuringSearch: true,
        rootInfo: { visits: 1, winrate: 0.5, scoreLead: 0 },
      }),
    )
    expect(emitted).toEqual([])
    expect(ledger.completed.has(0)).toBe(false)

    session.handleLine(analysisLine('sweep:0'))
    expect(emitted).toEqual(['sweep:0'])
    expect(ledger.completed.has(0)).toBe(true)
    expect(ledger.failed.has(0)).toBe(false)
    session.dispose()
  })

  it('a malformed sweep result is recorded failed, never emitted, and never re-issued', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const emitted: string[] = []
    const ledger = createSweepLedger(2)
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.startSweep(ledger)

    // A well-formed line with no winrate anywhere — the production parser's
    // rejection, live. The move is failed (a retry would be rejected
    // identically) and the sweep moves on.
    session.handleLine(JSON.stringify({ id: 'sweep:0', rootInfo: {} }))
    expect(emitted).toEqual([])
    expect(ledger.failed.has(0)).toBe(true)
    expect(ledger.completed.has(0)).toBe(false)

    // Re-starting the sweep on the same ledger (the crash-resume shape):
    // completed and failed moves are skipped, only the unanswered move 1 and
    // 2 are re-issued — sweep:0 exactly once across both epochs.
    session.startSweep(ledger)
    const sweepZeroIssues = requestIds(sent).filter((id) => id === 'sweep:0').length
    expect(sweepZeroIssues).toBe(1)
    expect(requestIds(sent).filter((id) => id.startsWith('sweep:'))).toEqual([
      'sweep:0',
      'sweep:1',
      'sweep:2',
      'sweep:1',
      'sweep:2',
    ])
    session.dispose()
  })

  it('startSweep resumes at the ledger’s first uncompleted move', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const ledger = createSweepLedger(20)
    markSweepComplete(ledger, 0)
    markSweepComplete(ledger, 1)
    markSweepComplete(ledger, 2)
    markSweepFailed(ledger, 3)
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(longGame(20), 0)
    session.startSweep(ledger)

    expect(requestIds(sent).filter((id) => id.startsWith('sweep:'))).toEqual([
      'sweep:4',
      'sweep:5',
      'sweep:6',
      'sweep:7',
      'sweep:8',
      'sweep:9',
      'sweep:10',
      'sweep:11',
    ])
    session.dispose()
  })

  it('the pump window skips a failed move sitting above the resume point', () => {
    // resumeFrom lands on the lowest un-finished move, but the window then
    // walks UP through moves the ledger already knows about — including
    // failures. A failed move inside the window must not be re-issued: the
    // parser rejected it once and will reject it identically on retry.
    const seam = timerSeam()
    const sent: string[] = []
    const ledger = createSweepLedger(20)
    markSweepFailed(ledger, 5)
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(longGame(20), 0)
    session.startSweep(ledger)

    expect(requestIds(sent).filter((id) => id.startsWith('sweep:'))).toEqual([
      'sweep:0',
      'sweep:1',
      'sweep:2',
      'sweep:3',
      'sweep:4',
      'sweep:6',
      'sweep:7',
      'sweep:8',
    ])
    session.dispose()
  })

  it('setGame stops the sweep: every in-flight sweep query is terminated', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(longGame(20), 0)
    session.startSweep(createSweepLedger(20))

    session.setGame(engineGame(), 0)
    const terminates = terminateIds(sent)
    for (let move = 0; move < SWEEP_CONCURRENCY; move += 1) {
      expect(terminates).toContain(`sweep:${String(move)}`)
    }
    // The superseded focus query terminates through its own path, as before —
    // the sweep stop must not have touched it, and no sweep query leaks into
    // the new record's issue list.
    expect(terminates).toContain('focus:1')
    expect(requestIds(sent).at(-1)).toBe('focus:2')
    session.dispose()
  })

  it('a cursor move supersedes focus only — the sweep keeps completing', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const emitted: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      debounceMs: 50,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.startSweep(createSweepLedger(2))

    session.setCursor(1)
    seam.fire(50) // focus:2 issued, focus:1 terminated

    // No sweep query was terminated by the cursor move…
    expect(terminateIds(sent)).toEqual(['focus:1'])
    // …and the sweep's completions still land afterwards.
    session.handleLine(analysisLine('sweep:1'))
    expect(emitted).toEqual(['sweep:1'])
    session.dispose()
  })

  it('sweep results are perspective-normalized before emission', () => {
    const seam = timerSeam()
    const results: number[] = []
    const session = createAnalysisSession({
      send: () => undefined,
      onResult: (result) => results.push(result.scoreLead),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    // White to move at position 0: the wire's +1.5 for White must arrive as
    // -1.5 in the black-positive contract — same adaptation as focus.
    session.setGame(
      engineGame({ moves: [{ player: 'white', coord: { x: 3, y: 3 } }] }),
      0,
    )
    session.startSweep(createSweepLedger(1))
    session.handleLine(analysisLine('sweep:0'))
    expect(results).toEqual([-1.5])
    session.dispose()
  })

  it('a fully-completed ledger sweeps nothing — no sweep:null query', () => {
    // The crash-resume shape when the engine died after the sweep finished:
    // resumeFrom is null, and the pump must treat that as "done", not as a
    // starting cursor. `null <= moves.length` is true in JS, so a naive
    // assignment here emits one bogus query under the id `sweep:null`.
    const seam = timerSeam()
    const sent: string[] = []
    const ledger = createSweepLedger(2)
    markSweepComplete(ledger, 0)
    markSweepComplete(ledger, 1)
    markSweepComplete(ledger, 2)
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.startSweep(ledger)

    expect(requestIds(sent)).toEqual(['focus:1'])
    session.dispose()
  })

  it('dispose sends no sweep terminates — the process is going away', () => {
    const seam = timerSeam()
    const sent: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: () => undefined,
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
    })
    session.setGame(engineGame(), 2)
    session.startSweep(createSweepLedger(2))
    session.dispose()

    // Requests went out; terminates would be writes to a dying stdin.
    expect(requestIds(sent)).toEqual(['focus:1', 'sweep:0', 'sweep:1', 'sweep:2'])
    expect(terminateIds(sent)).toEqual([])
  })
})

describe('in-flight reporting and terminate-all (Stage 5)', () => {
  /**
   * The service's watchdog arms on a non-zero in-flight population and disarms
   * on zero, so the reported count IS the watchdog's input: a count that
   * forgot the sweep's entries (or the terminated focus entries the engine
   * still owes a final reply) would leave the watchdog disarmed while work
   * sat unanswered — a hang that never trips. These tests pin the population
   * through every mutation that touches it.
   */
  function inFlightSession(): {
    readonly session: ReturnType<typeof createAnalysisSession>
    readonly counts: number[]
    readonly sent: string[]
    readonly emitted: string[]
    readonly fire: (ms: number) => void
  } {
    const seam = timerSeam()
    const sent: string[] = []
    const counts: number[] = []
    const emitted: string[] = []
    const session = createAnalysisSession({
      send: (line) => sent.push(line),
      onResult: (result) => emitted.push(result.queryId),
      settings: SETTINGS,
      setTimer: seam.setTimer,
      logger: silentLogger,
      onInFlightChange: (count) => counts.push(count),
    })
    return { session, counts, sent, emitted, fire: seam.fire }
  }

  it('the population covers focus and sweep together, and tracks every mutation', () => {
    const { session, counts, sent } = inFlightSession()
    session.setGame(engineGame(), 2)
    session.startSweep(createSweepLedger(2))

    // focus:1 plus sweep:0..2: four queries owed. The notification is
    // per-batch — `pumpSweep` reports once after its issue loop, not once per
    // query — so the counts are [focus issue, full sweep batch], which is all
    // the watchdog needs (it keys on zero versus non-zero).
    expect(session.inFlightCount()).toBe(4)
    expect(counts).toEqual([1, 4])

    // A sweep completion frees its slot; nothing is pumped past a complete
    // 3-position record, so the population walks down.
    session.handleLine(analysisLine('sweep:0'))
    expect(session.inFlightCount()).toBe(3)

    session.handleLine(analysisLine('sweep:1'))
    session.handleLine(analysisLine('sweep:2'))
    expect(session.inFlightCount()).toBe(1)

    // The focus completion closes the last slot.
    session.handleLine(analysisLine('focus:1'))
    expect(session.inFlightCount()).toBe(0)
    expect(counts.at(-1)).toBe(0)

    session.dispose()
    expect(sent.length).toBeGreaterThan(0)
  })

  it('a terminated focus entry still counts: the engine owes it a final reply', () => {
    const { session, counts, fire } = inFlightSession()
    session.setGame(engineGame(), 2)
    session.setCursor(1)
    fire(50) // the debounce: terminate focus:1, issue focus:2

    // focus:1 terminated, focus:2 issued — two entries, one of them dead but
    // owed. The population must not drop: the watchdog's silence clock runs
    // until the final reply lands (or the engine is killed for silence).
    expect(session.inFlightCount()).toBe(2)
    expect(counts).toEqual([1, 2])
    session.dispose()
  })

  it('stopSweep reports the sweep entries leaving the map', () => {
    const { session, counts } = inFlightSession()
    session.setGame(engineGame(), 2)
    session.startSweep(createSweepLedger(2))
    expect(session.inFlightCount()).toBe(4)

    session.clearGame()
    // The sweep driver is dropped with its entries; the focus was terminated
    // (still owed its final reply, so it stays).
    expect(session.inFlightCount()).toBe(1)
    expect(counts).toContain(1)
    session.dispose()
  })

  it('terminateAllInFlight sends one terminate per owed id, once each', () => {
    const { session, sent } = inFlightSession()
    session.setGame(longGame(20), 0)
    session.startSweep(createSweepLedger(20))
    // focus:1 + sweep:0..7 = nine owed ids.
    expect(session.inFlightCount()).toBe(1 + SWEEP_CONCURRENCY)

    session.terminateAllInFlight()

    // Exactly one terminate per id, and every id is covered — a watchdog that
    // terminated only one tier (or terminated an id twice) leaves work the
    // kill then interrupts without the protocol courtesy.
    expect(terminateIds(sent).sort()).toEqual(
      [
        'focus:1',
        ...Array.from({ length: SWEEP_CONCURRENCY }, (_, m) => `sweep:${String(m)}`),
      ].sort(),
    )
    // Sweep entries leave immediately (their ids are reused per record);
    // terminated focus entries stay for their mandated final reply.
    expect(session.inFlightCount()).toBe(1)
    session.dispose()
  })

  it('the mandated final reply after terminateAllInFlight is dropped and closes the slot', () => {
    const { session, sent, emitted } = inFlightSession()
    session.setGame(engineGame(), 2)
    session.terminateAllInFlight()

    // The engine's documented conclusion of the terminated query: one final
    // reply, routed by id, dropped — never emitted.
    session.handleLine(analysisLine('focus:1'))
    expect(emitted).toEqual([])
    expect(session.inFlightCount()).toBe(0)
    expect(sent.length).toBeGreaterThan(0)
    session.dispose()
  })

  it('dispose silences the in-flight reporting', () => {
    const { session, counts } = inFlightSession()
    session.setGame(engineGame(), 2)
    session.dispose()
    const atDispose = counts.length
    session.handleLine(analysisLine('focus:1'))
    expect(counts.length).toBe(atDispose)
  })
})
