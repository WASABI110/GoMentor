import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FOCUS_QUERY_PREFIX,
  settingsSchema,
  type EngineGame,
  type EngineInfo,
} from '@gomentor/shared'
import type { SpawnFn } from '../../src/main/katago/process'
import type { LocateOutcome } from '../../src/main/katago/locate'
import type { EngineService } from '../../src/main/katago/service'
import { AGENT_QUERY_VISITS } from '../../src/main/katago/session'

/**
 * The agent tier (`analyzeOnce`) against the **real spawned fake analysis
 * child** — the same harness `engine-service.test.ts` uses, because the risks
 * here are pipe-level and routing-level, and neither a mock nor a hand-built
 * session exercises them.
 *
 * ## What these tests prove
 *
 * - **The tier is independent.** An agent query issued while the user's focus
 *   query is in flight does not terminate or supersede it — asserted directly
 *   on the wire (no terminate frame for the user's id) and on the outcome (the
 *   user's result still reaches the renderer, complete). The same holds for a
 *   *debounced* cursor move: the focus query still fires under the id the
 *   renderer was eagerly given, even though an agent query completed in the
 *   middle of the debounce window.
 * - **Agent results stay in main.** Nothing carrying an `agent:` id is ever
 *   emitted on `engine:analysis` — the design routes these to the model, not
 *   the graph.
 * - **The contract shape arrives adapted**: the fake echoes the request's
 *   `maxVisits`, so `visits === AGENT_QUERY_VISITS` proves the query carried
 *   the tier's fixed budget; ownership comes back sized to the board.
 * - **Failure is a typed error, never a hang**: unavailable engine, aborted
 *   run (with the terminate frame to prove the engine was told), hung engine
 *   at the deadline, malformed answer, and a service shutting down
 *   mid-query all reject with codes.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/virtual/app',
    getPath: () => '/virtual/userData',
  },
  // `engine:analysis` is emitted through the real `ipc/events` fan-out; one
  // fake window captures what a real renderer would receive.
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
const SETTINGS = settingsSchema.parse({})

const GAME: EngineGame = {
  gameId: 'game-1',
  boardSize: 19,
  komi: 6.5,
  rules: 'japanese',
  setup: { black: [], white: [] },
  moves: [
    { player: 'black', coord: { x: 3, y: 3 } },
    { player: 'white', coord: { x: 15, y: 3 } },
    { player: 'black', coord: { x: 3, y: 15 } },
  ],
}

/**
 * One frame written to the child's stdin: the parsed request (or terminate)
 * plus the raw id. This is how the isolation claims are asserted — a test that
 * only looked at *results* could not tell "the user's query was left alone"
 * from "it was terminated, and the mandated final reply happened to look like
 * a complete answer".
 */
interface WireFrame {
  readonly id: string
  readonly action: string
  readonly record: Record<string, unknown>
}

let wire: WireFrame[] = []

/**
 * Spawn seam: a faithful passthrough that taps the child's stdin. The tap is
 * observational only — every byte still reaches the real child, and the
 * production framing/parsing decides what comes back.
 */
const spawnTap: SpawnFn = (command, args) => {
  const child = spawn(command, [...args])
  const original = child.stdin.write.bind(child.stdin)
  child.stdin.write = ((chunk: string): boolean => {
    try {
      const record = JSON.parse(chunk) as Record<string, unknown>
      const action = record['action']
      wire.push({
        id: String(record['id']),
        action: typeof action === 'string' ? action : 'query',
        record,
      })
    } catch {
      // A frame the tap cannot parse is still forwarded untouched below.
    }
    return original(chunk)
  }) as typeof child.stdin.write
  return child
}

interface LogEntry {
  readonly level: string
  readonly msg: string
}

function recordingLogger(): { logger: EngineServiceLog; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const make = (level: string) => (msg: string, _fields?: Record<string, unknown>) => {
    entries.push({ level, msg })
  }
  return {
    entries,
    logger: {
      debug: make('debug'),
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
      failure: (msg: string, _error: unknown, _fields?: Record<string, unknown>) => {
        entries.push({ level: 'failure', msg })
      },
    },
  }
}

interface EngineServiceLog {
  readonly debug: (msg: string, fields?: Record<string, unknown>) => void
  readonly info: (msg: string, fields?: Record<string, unknown>) => void
  readonly warn: (msg: string, fields?: Record<string, unknown>) => void
  readonly error: (msg: string, fields?: Record<string, unknown>) => void
  readonly failure: (
    msg: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ) => void
}

function locateWith(_faults: readonly string[]): () => LocateOutcome {
  // The faults reach the child through the spawn seam below, appended to every
  // launch; locate only has to keep reporting the fake binary as found.
  return () => ({ kind: 'found', binary: CHILD, network: NETWORK })
}

let tempDir: string
let loggerHandle: ReturnType<typeof recordingLogger>
let service: EngineService | undefined

async function makeService(
  options: {
    faults?: readonly string[]
    probeDeadlineMs?: number
  } = {},
): Promise<EngineService> {
  const faults = options.faults ?? ['--mode=analysis']
  const { createEngineService } = await import('../../src/main/katago/service')
  return createEngineService({
    settings: { get: () => SETTINGS },
    locate: locateWith(faults),
    spawn: (command, args) => spawnTap(command, [...args, ...faults]),
    writeConfig: (contents) => {
      const path = join(tempDir, 'katago-analysis.cfg')
      writeFileSync(path, contents, 'utf8')
      return path
    },
    emitStatus: (_info: EngineInfo) => undefined,
    logger: loggerHandle.logger,
    ...(options.probeDeadlineMs === undefined
      ? {}
      : { probeDeadlineMs: options.probeDeadlineMs }),
  })
}

/** The analysis results the renderer received, in order. */
function rendererResults(): { queryId: string; complete: boolean }[] {
  return sentEvents
    .filter((event) => event.channel === 'engine:analysis')
    .map((event) => event.payload as { queryId: string; complete: boolean })
}

/** Frames written for a given id (queries and terminates alike). */
function framesFor(id: string): WireFrame[] {
  return wire.filter((frame) => frame.id === id)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gomentor-agent-'))
  sentEvents.length = 0
  wire = []
  loggerHandle = recordingLogger()
  delete process.env['FAKE_KATAGO_OWNERSHIP_SHORT']
})

afterEach(async () => {
  await service?.shutdown()
  delete process.env['FAKE_KATAGO_OWNERSHIP_SHORT']
  rmSync(tempDir, { recursive: true, force: true })
})

describe('analyzeOnce against the fake analysis child', () => {
  it(
    'answers a one-shot query with a contract-shaped, agent-namespaced result that never reaches the renderer',
    { timeout: 30_000 },
    async () => {
      service = await makeService()
      await service.start()

      const result = await service.analyzeOnce(GAME, 2)
      // The id is the tier's namespace, monotonic per service.
      expect(result.queryId).toBe('agent:1')
      expect(result.gameId).toBe('game-1')
      expect(result.complete).toBe(true)
      // At move 2 the third move is black's, so black is to move.
      expect(result.player).toBe('black')
      expect(result.winrate).toBeGreaterThanOrEqual(0)
      expect(result.winrate).toBeLessThanOrEqual(1)
      // The fake echoes the request's maxVisits into rootInfo: a result at
      // the tier's budget proves the query carried that budget.
      expect(result.visits).toBe(AGENT_QUERY_VISITS)
      expect(result.candidates.length).toBeGreaterThanOrEqual(1)
      expect(result.candidates[0]?.pv.length).toBeGreaterThanOrEqual(1)
      expect(result.ownership).toHaveLength(19 * 19)

      const second = await service.analyzeOnce(GAME, 3)
      expect(second.queryId).toBe('agent:2')
      expect(second.player).toBe('white')

      // Agent results belong to the model, not the graph: nothing prefixed
      // `agent:` is ever emitted on `engine:analysis`.
      expect(rendererResults().some((r) => r.queryId.startsWith('agent:'))).toBe(false)

      // The wire request carries the tier's fixed shape.
      const query = framesFor('agent:1')[0]?.record
      expect(query?.['maxVisits']).toBe(AGENT_QUERY_VISITS)
      expect(query?.['includeOwnership']).toBe(true)
      expect('reportDuringSearchEvery' in (query ?? {})).toBe(false)
    },
  )

  it(
    'leaves an in-flight focus query untouched: no terminate, and the user still gets their answer',
    { timeout: 30_000 },
    async () => {
      // The delay serialises the fake's answers, so the focus query is
      // genuinely in flight when the agent query is issued.
      service = await makeService({ faults: ['--mode=analysis', '--delay-ms=120'] })
      await service.start()

      const { focusQueryId } = service.setGame(GAME, 2)
      if (focusQueryId === null) {
        throw new Error('the engine is ready — setGame must return a focus id')
      }
      expect(focusQueryId).toBe(`${FOCUS_QUERY_PREFIX}1`)

      const agent = service.analyzeOnce(GAME, 0)
      const result = await agent
      expect(result.queryId).toBe('agent:1')

      // The user's query was never terminated.
      expect(
        framesFor(focusQueryId).some((frame) => frame.action === 'terminate'),
      ).toBe(false)
      // And its complete answer still reached the renderer.
      const focus = rendererResults().find((r) => r.queryId === focusQueryId)
      expect(focus?.complete).toBe(true)
      // Under that concurrency the agent result stayed in main: the renderer
      // saw the focus answer and nothing with an `agent:` id.
      expect(rendererResults().some((r) => r.queryId.startsWith('agent:'))).toBe(false)
    },
  )

  it(
    'does not disturb a debounced cursor move: the focus query still fires under its eagerly allocated id',
    { timeout: 30_000 },
    async () => {
      service = await makeService()
      await service.start()
      service.setGame(GAME, 2)
      // Wait out the setGame focus query so the assertions below see only the
      // cursor one.
      await vi.waitFor(() => {
        expect(
          rendererResults().some(
            (r) => r.queryId === `${FOCUS_QUERY_PREFIX}1` && r.complete,
          ),
        ).toBe(true)
      })

      wire = []
      const { focusQueryId } = service.setCursor(1)
      if (focusQueryId === null) {
        throw new Error('the engine is ready — setCursor must return a focus id')
      }
      // The agent query completes inside the cursor debounce window — the
      // exact moment a cursor-session-coupled tier would steal or reset the
      // held position.
      const agent = service.analyzeOnce(GAME, 0)
      const result = await agent
      expect(result.queryId).toBe('agent:1')

      await vi.waitFor(() => {
        expect(
          rendererResults().some((r) => r.queryId === focusQueryId && r.complete),
        ).toBe(true)
      })
      // The debounced focus fired under the id the renderer was given, and it
      // was study of the position the user asked for — not the agent's.
      const cursorQuery = framesFor(focusQueryId).find(
        (frame) => frame.action === 'query',
      )
      expect(cursorQuery?.record['moves']).toHaveLength(1)
      expect(framesFor(focusQueryId).some((f) => f.action === 'terminate')).toBe(false)
    },
  )

  it('rejects with ENGINE_UNAVAILABLE when the engine is not ready', async () => {
    service = await makeService()
    await expect(service.analyzeOnce(GAME, 1)).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    })
    // And after a start that never reached ready, the same.
    await service.start()
    await service.shutdown()
    await expect(service.analyzeOnce(GAME, 1)).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    })
  })

  it(
    'rejects an already-aborted signal with LLM_ABORTED and never reaches the engine',
    { timeout: 30_000 },
    async () => {
      service = await makeService()
      await service.start()

      // An already-dead signal never fires an `abort` event, so without an
      // entry check this method would spend a real engine query on a cancelled
      // run and then resolve with an answer instead of the documented code.
      const controller = new AbortController()
      controller.abort()
      await expect(
        service.analyzeOnce(GAME, 2, controller.signal),
      ).rejects.toMatchObject({ code: 'LLM_ABORTED' })
      // No query frame and no terminate frame for the agent id: the engine
      // never heard of it. (The tap still carries the readiness probe's frame,
      // so the assertion is per-id, not on the whole stream.)
      expect(framesFor('agent:1')).toEqual([])
    },
  )

  it(
    'rejects with LLM_ABORTED on cancel, and tells the engine',
    { timeout: 30_000 },
    async () => {
      service = await makeService({ faults: ['--mode=analysis', '--delay-ms=900'] })
      await service.start()

      const controller = new AbortController()
      const pending = service.analyzeOnce(GAME, 2, controller.signal)
      setTimeout(() => {
        controller.abort()
      }, 120)
      await expect(pending).rejects.toMatchObject({ code: 'LLM_ABORTED' })
      // Cancellation reached the engine as a terminate for the agent query.
      expect(framesFor('agent:1').some((f) => f.action === 'terminate')).toBe(true)
    },
  )

  it(
    'rejects with ENGINE_QUERY_FAILED at the deadline when the engine hangs, after terminating the query',
    { timeout: 30_000 },
    async () => {
      service = await makeService({
        faults: ['--mode=analysis', '--hang-on=agent'],
        probeDeadlineMs: 500,
      })
      await service.start()

      const startedAt = Date.now()
      await expect(service.analyzeOnce(GAME, 2)).rejects.toMatchObject({
        code: 'ENGINE_QUERY_FAILED',
      })
      // Bounded by the injected deadline, with margin for the round trip.
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect(framesFor('agent:1').some((f) => f.action === 'terminate')).toBe(true)
    },
  )

  it(
    'rejects with ENGINE_QUERY_FAILED when the engine answers with a malformed result',
    { timeout: 30_000 },
    async () => {
      // The fake's env-selected B4 fault: answers one ownership point short for
      // ids containing 'agent'. The production parser rejects it, which is the
      // tier's parse-failure path — a failed query, not a hang and not a crash.
      process.env['FAKE_KATAGO_OWNERSHIP_SHORT'] = 'agent'
      service = await makeService()
      await service.start()

      await expect(service.analyzeOnce(GAME, 2)).rejects.toMatchObject({
        code: 'ENGINE_QUERY_FAILED',
      })
    },
  )

  it(
    'settles in-flight agent queries when the service shuts down, instead of hanging',
    { timeout: 30_000 },
    async () => {
      service = await makeService({ faults: ['--mode=analysis', '--delay-ms=900'] })
      await service.start()

      const pending = service.analyzeOnce(GAME, 2)
      // Attached before the shutdown so the rejection is handled the moment it
      // lands, not after a floating `await` in which Node would report it.
      const expectation = expect(pending).rejects.toMatchObject({
        code: 'ENGINE_QUERY_FAILED',
      })
      await service.shutdown()
      await expectation
    },
  )
})
