import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FOCUS_QUERY_PREFIX,
  settingsSchema,
  SWEEP_QUERY_PREFIX,
  type AnalysisResult,
  type EngineGame,
  type EngineInfo,
  type Settings,
} from '@gomentor/shared'
import type { SpawnFn } from '../../src/main/katago/process'
import type { LocateOutcome } from '../../src/main/katago/locate'
import type { EngineService } from '../../src/main/katago/service'

/**
 * Engine service integration: the full start sequence against the **real
 * spawned fake** (`fake-katago-child.ts --mode=analysis`), through the same
 * pipes, framing, and exit handling production uses. The seams here exist for
 * the reasons documented in `katago/process.ts`: `locate`/`writeConfig`/
 * `emitStatus`/the logger are injected so outcomes, the generated config,
 * emissions, and log levels are all assertable, and the spawn seam is a
 * passthrough that only appends per-test fault flags — the launch decision
 * (`planEngineLaunch`: a `.ts` binary runs via `execPath --import tsx`) is the
 * service's own code under test. Nothing about the protocol path is
 * substituted — `splitJsonLines` and `parseAnalysisResponse` decide what the
 * child's bytes mean.
 *
 * ## What these tests prove
 *
 * - readiness is **proven, not declared**: `ready` only appears after the
 *   1-visit probe round-trips through the production parser;
 * - missing assets map to `unavailable` in dev and `failed` in packaged
 *   builds — the two-states-for-missing decision (`design.md`);
 * - stderr floods are throttled into the log but the crash tail is dumped at
 *   warn once (B5/B6 groundwork: the `--hang-on-query`, `--garbage-on`,
 *   `--crash-after` faults each drive their failure path);
 * - a spawned child never outlives `shutdown()`.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/virtual/app',
    getPath: () => '/virtual/userData',
  },
  // `engine:analysis` is emitted through the real `ipc/events` fan-out, which
  // reads `BrowserWindow.getAllWindows()`. One fake window captures what main
  // would push, so a spec can assert the event a real renderer would receive.
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

/**
 * Spawn seam: a faithful passthrough plus the per-test fault flags appended
 * after the service's own argv. The launch decision itself — a `.ts` override
 * resolves to `process.execPath --import tsx <child>` — is `planEngineLaunch`'s
 * job in `locate.ts` and runs in the service under test here, so this seam must
 * not re-wrap: re-wrapping would be a second copy of the plan, able to drift
 * from the one production uses.
 */
const spawnFake: SpawnFn = (command, args) => {
  return spawn(command, [...args])
}

const SETTINGS: Settings = settingsSchema.parse({})

interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error' | 'failure'
  readonly msg: string
  readonly fields: Record<string, unknown> | undefined
}

function recordingLogger(): { logger: EngineServiceLog; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const make =
    (level: LogEntry['level']) => (msg: string, fields?: Record<string, unknown>) => {
      entries.push({ level, msg, fields })
    }
  return {
    entries,
    logger: {
      debug: make('debug'),
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
      // `failure` takes the thrown value as its second argument; the entry
      // records the optional fields argument, as every other level does.
      failure: (msg, _error, fields) => {
        entries.push({ level: 'failure', msg, fields })
      },
    },
  }
}

// The logger shape the service options accept (Pick of the scoped Logger).
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

function fakeLocate(outcome: LocateOutcome): () => LocateOutcome {
  return () => outcome
}

const FAKE_ARGS: string[] = []
function fakeArgs(...args: string[]): () => LocateOutcome {
  // The fault flags reach the child through the spawn seam: the seam appends
  // them to every fake launch. Set per-test before constructing the service.
  FAKE_ARGS.length = 0
  FAKE_ARGS.push(...args)
  return () => ({ kind: 'found', binary: CHILD, network: NETWORK })
}

/**
 * Per-spawn fault flags: launch N gets entry N, and absent entries get none.
 * Stage 5's recovery tests need exactly this asymmetry — a crashing first
 * spawn and a healthy respawn — which a per-test constant flag list cannot
 * express (the service respawns the same binary).
 */
const LAUNCH_ARGS: string[][] = []
function perLaunch(...launches: string[][]): () => LocateOutcome {
  LAUNCH_ARGS.length = 0
  LAUNCH_ARGS.push(...launches)
  return () => ({ kind: 'found', binary: CHILD, network: NETWORK })
}

let tempDir: string
let emissions: EngineInfo[]
let loggerHandle: ReturnType<typeof recordingLogger>
let service: EngineService | undefined
/** How many children the spawn seam launched. Reset per test. */
let spawnCount = 0

async function makeService(options: {
  locate: () => LocateOutcome
  probeDeadlineMs?: number
  watchdogDeadlineMs?: number
  setTimer?: (fn: () => void, ms: number) => () => void
  now?: () => number
}): Promise<EngineService> {
  const { createEngineService } = await import('../../src/main/katago/service')
  spawnCount = 0
  return createEngineService({
    settings: { get: () => SETTINGS },
    locate: options.locate,
    spawn: (command, args) => {
      const per = LAUNCH_ARGS[spawnCount] ?? []
      spawnCount += 1
      return spawnFake(command, [...args, ...FAKE_ARGS, ...per])
    },
    writeConfig: (contents) => {
      const path = join(tempDir, 'katago-analysis.cfg')
      writeFileSync(path, contents, 'utf8')
      return path
    },
    emitStatus: (info) => {
      emissions.push(info)
    },
    logger: loggerHandle.logger,
    ...(options.probeDeadlineMs === undefined
      ? {}
      : { probeDeadlineMs: options.probeDeadlineMs }),
    ...(options.watchdogDeadlineMs === undefined
      ? {}
      : { watchdogDeadlineMs: options.watchdogDeadlineMs }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gomentor-engine-'))
  emissions = []
  sentEvents.length = 0
  loggerHandle = recordingLogger()
  FAKE_ARGS.length = 0
  LAUNCH_ARGS.length = 0
})

afterEach(async () => {
  await service?.shutdown()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('start against the fake analysis engine', () => {
  it('reaches ready only after the probe round-trips', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    const info = await service.start()

    expect(info.status).toBe('ready')
    expect(info.backend).toBe('eigen')
    expect(info.networkName).toBe('net.txt.gz')
    // The fake banner carries no version — best-effort means absent, not made up.
    expect(info.version).toBeUndefined()
    // starting was emitted, then ready — and readiness came after the probe,
    // which is the whole point.
    expect(emissions.map((e) => e.status)).toEqual(['starting', 'ready'])
  })

  it('writes the generated config with the pinned perspective', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()

    const config = readFileSync(join(tempDir, 'katago-analysis.cfg'), 'utf8')
    expect(config).toContain('reportAnalysisWinratesAs = SIDETOMOVE')
    // The v1.18 thread model: the settings budget flows through the split
    // (`analysisThreadSplit` — its exact arithmetic is unit-tested in
    // katago-config.test.ts; here the flow-through is the point).
    expect(config).toContain('numAnalysisThreads = 2')
    expect(config).toContain('numSearchThreadsPerAnalysisThread = 2')
    expect(config).toContain(`maxVisits = ${String(SETTINGS.engine.maxVisits)}`)
  })

  it('spawns with the analysis command line (config + model args)', async () => {
    const spawnArgs: string[][] = []
    const { createEngineService } = await import('../../src/main/katago/service')
    service = createEngineService({
      settings: { get: () => SETTINGS },
      locate: fakeArgs('--mode=analysis'),
      spawn: (command, args) => {
        spawnArgs.push([command, ...args])
        return spawnFake(command, [...args, ...FAKE_ARGS])
      },
      writeConfig: () => join(tempDir, 'katago-analysis.cfg'),
      emitStatus: (info) => {
        emissions.push(info)
      },
      logger: loggerHandle.logger,
    })
    await service.start()

    // The located "binary" is the fake's TypeScript child, so `planEngineLaunch`
    // resolves the exec to the app's own runtime with the tsx loader — that
    // decision is under test here, through the service, not restated in the seam.
    const [first] = spawnArgs
    expect(first?.[0]).toBe(process.execPath)
    expect(first?.[1]).toBe('--import')
    expect(first?.[2]).toBe('tsx')
    expect(first?.[3]).toBe(CHILD)
    expect(first?.[4]).toBe('analysis')
    expect(first?.[5]).toBe('-config')
    expect(first?.[7]).toBe('-model')
    expect(first?.[8]).toBe(NETWORK)
  })

  it('start is idempotent: concurrent calls join one attempt', async () => {
    let spawns = 0
    const { createEngineService } = await import('../../src/main/katago/service')
    service = createEngineService({
      settings: { get: () => SETTINGS },
      locate: fakeArgs('--mode=analysis'),
      spawn: (command, args) => {
        spawns += 1
        return spawnFake(command, [...args, ...FAKE_ARGS])
      },
      writeConfig: () => join(tempDir, 'katago-analysis.cfg'),
      emitStatus: (info) => {
        emissions.push(info)
      },
      logger: loggerHandle.logger,
    })

    const [a, b] = await Promise.all([service.start(), service.start()])
    expect(a.status).toBe('ready')
    expect(b.status).toBe('ready')
    expect(spawns).toBe(1)
    // One starting emission for the joined attempt, not one per call.
    expect(emissions.filter((e) => e.status === 'starting')).toHaveLength(1)
  })

  it('shutdown is clean: the child exits and no failure is emitted', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()
    emissions.length = 0

    await service.shutdown()
    const statuses = emissions.map((e) => e.status)
    expect(statuses).not.toContain('failed')
    expect(service.info().status).toBe('unavailable')
    // A second shutdown is a harmless no-op — no throw, no respawn.
    await service.shutdown()
  })

  it('a hanging engine fails the probe with ENGINE_START_TIMEOUT', async () => {
    service = await makeService({
      locate: fakeArgs('--mode=analysis', '--hang-on-query'),
      probeDeadlineMs: 400,
    })
    const info = await service.start()

    expect(info.status).toBe('failed')
    expect(info.errorCode).toBe('ENGINE_START_TIMEOUT')
    expect(emissions.map((e) => e.status)).toEqual(['starting', 'failed'])
    // shutdown still reaps the hung child cleanly.
    await service.shutdown()
  })

  it('a garbage answer to the probe fails with ENGINE_QUERY_FAILED', async () => {
    service = await makeService({
      locate: fakeArgs('--mode=analysis', '--garbage-on=gomentor-probe'),
    })
    const info = await service.start()

    expect(info.status).toBe('failed')
    expect(info.errorCode).toBe('ENGINE_QUERY_FAILED')
  })

  it('a crash after the probe answer retries, and repeated crashes exhaust into failed(ENGINE_CRASHED)', async () => {
    // A local, not the module-scoped `service`: the closure below outlives this
    // test's synchronous flow, and a `let` that later tests reassign cannot be
    // narrowed inside it — a local `const` can.
    const crashing = await makeService({
      locate: fakeArgs('--mode=analysis', '--crash-after=1', '--exit-code=3'),
    })
    service = crashing
    await crashing.start()

    // Every spawn answers the probe (response 1) then exits 3 — the fault
    // flags ride every launch through the seam. Stage 5's contract: the
    // first two crashes retry (badge honestly back to `starting`), the third
    // opens the circuit → failed(ENGINE_CRASHED). The backoff is real time
    // here (1s + 2s), so the wait must cover ~3.5s of restarts.
    await vi.waitFor(
      () => {
        expect(crashing.info().status).toBe('failed')
        expect(crashing.info().errorCode).toBe('ENGINE_CRASHED')
      },
      { timeout: 10_000 },
    )
    expect(emissions.map((e) => e.status)).toEqual([
      'starting',
      'ready',
      'starting', // crash 1 → backoff respawn
      'ready',
      'starting', // crash 2 → backoff respawn
      'ready',
      'failed', // crash 3 → circuit open
    ])
  })
})

describe('missing assets map to status by mode', () => {
  it('dev missing binary degrades to unavailable with a fetch hint', async () => {
    service = await makeService({
      locate: fakeLocate({
        kind: 'binary-missing',
        searched: '/res/katago/win32-x64/katago.exe',
        mode: 'dev',
      }),
    })
    const info = await service.start()

    expect(info.status).toBe('unavailable')
    expect(info.errorCode).toBeUndefined()
    const warn = loggerHandle.entries.find((e) => e.level === 'warn')
    expect(warn?.msg).toContain('fetch:katago')
    // No process was spawned — nothing to shut down, nothing to leak.
    expect(emissions.map((e) => e.status)).toEqual(['starting', 'unavailable'])
  })

  it('packaged missing binary fails with ENGINE_BINARY_MISSING', async () => {
    service = await makeService({
      locate: fakeLocate({
        kind: 'binary-missing',
        searched: '/res/katago/win32-x64/katago.exe',
        mode: 'packaged',
      }),
    })
    const info = await service.start()

    expect(info.status).toBe('failed')
    expect(info.errorCode).toBe('ENGINE_BINARY_MISSING')
    expect(emissions.map((e) => e.status)).toEqual(['starting', 'failed'])
  })

  it('dev missing weights degrades to unavailable pointing at fetch:weights', async () => {
    service = await makeService({
      locate: fakeLocate({ kind: 'network-missing', dir: '/res/weights', mode: 'dev' }),
    })
    const info = await service.start()

    expect(info.status).toBe('unavailable')
    expect(loggerHandle.entries.some((e) => e.msg.includes('fetch:weights'))).toBe(true)
  })

  it('unsupported platform stays unavailable by construction', async () => {
    service = await makeService({ locate: fakeLocate({ kind: 'unsupported' }) })
    const info = await service.start()

    expect(info.status).toBe('unavailable')
    expect(loggerHandle.entries.some((e) => e.level === 'info')).toBe(true)
  })
})

describe('stderr handling', () => {
  it('a stderr flood is throttled in the log and dumped at warn on crash', async () => {
    service = await makeService({
      locate: fakeArgs('--mode=analysis', '--stderr-lines=500', '--crash-after=1'),
    })
    await service.start()

    // The crash (and therefore the warn dump) lands a tick after the probe
    // response — wait for it rather than racing it.
    await vi.waitFor(() => {
      expect(loggerHandle.entries.some((e) => e.msg === 'engine stderr tail')).toBe(
        true,
      )
    })

    const debugCalls = loggerHandle.entries.filter(
      (e) => e.level === 'debug' && e.msg === 'engine stderr',
    )
    // 500 lines arrived within milliseconds; the throttle must have kept the
    // log to a handful of entries, not 500.
    expect(debugCalls.length).toBeLessThan(10)
    expect(debugCalls.length).toBeGreaterThan(0)

    const dump = loggerHandle.entries.find((e) => e.msg === 'engine stderr tail')
    expect(dump?.level).toBe('warn')
    const lines = dump?.fields?.['lines']
    expect(Array.isArray(lines)).toBe(true)
    // The ring buffer is bounded — the tail is the LAST words, not the first.
    expect((lines as unknown[]).length).toBeLessThanOrEqual(200)
    expect((lines as unknown[]).join('\n')).toContain('noise line 499')
  })

  it('a clean shutdown does not dump the stderr tail at warn', async () => {
    service = await makeService({
      locate: fakeArgs('--mode=analysis', '--stderr-noise'),
    })
    await service.start()
    loggerHandle.entries.length = 0

    await service.shutdown()
    expect(loggerHandle.entries.some((e) => e.msg === 'engine stderr tail')).toBe(false)
  })
})

describe('live analysis through the service (Stage 3)', () => {
  const GAME: EngineGame = {
    gameId: 'g1',
    boardSize: 19,
    komi: 6.5,
    rules: 'japanese',
    setup: { black: [], white: [] },
    moves: [
      { player: 'black', coord: { x: 3, y: 3 } },
      { player: 'white', coord: { x: 15, y: 3 } },
    ],
  }

  function analysisEvents(): AnalysisResult[] {
    return sentEvents
      .filter((entry) => entry.channel === 'engine:analysis')
      .map((entry) => entry.payload as AnalysisResult)
  }

  // Stage 4 added the whole-record sweep: setGame now also produces sweep
  // events, so "how many results arrived" must mean "how many FOCUS results"
  // anywhere the count is the assertion. The filter rides the shared prefix
  // constants — the same namespacing contract production keys on — so a rename
  // of either prefix fails this file's compile, not a count.
  function focusEvents(): AnalysisResult[] {
    return analysisEvents().filter((r) => r.queryId.startsWith(FOCUS_QUERY_PREFIX))
  }

  it('setGame before start is held and issued the moment the engine is ready', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    const held = service.setGame(GAME, 2)
    // Not ready: nothing to name yet — the response is null, not a guess.
    expect(held).toEqual({ focusQueryId: null })

    await service.start()
    await vi.waitFor(() => {
      expect(
        analysisEvents().some((r) => r.gameId === 'g1' && r.moveNumber === 2),
      ).toBe(true)
    })
  })

  it('setCursor debounces latest-wins: two quick steps become one query, for the last position', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()
    service.setGame(GAME, 2)
    await vi.waitFor(() => {
      expect(focusEvents()).toHaveLength(1)
    })

    service.setCursor(1)
    service.setCursor(0)
    await vi.waitFor(() => {
      expect(focusEvents().some((r) => r.moveNumber === 0)).toBe(true)
    })
    // The intermediate position never became a query: exactly two focus results
    // — the initial game-open and the final cursor — and no moveNumber 1 among
    // them. (The sweep runs beside all of this; it is not what this test counts.)
    expect(focusEvents().some((r) => r.moveNumber === 1)).toBe(false)
    expect(focusEvents()).toHaveLength(2)
  })

  it('setCursor without a held record answers null and sends nothing', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()

    expect(service.setCursor(5)).toEqual({ focusQueryId: null })
    expect(analysisEvents()).toHaveLength(0)
  })

  it('clearGame releases the record: later cursor moves answer null', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()
    service.setGame(GAME, 2)
    await vi.waitFor(() => {
      expect(focusEvents()).toHaveLength(1)
    })

    service.setGame(null, 0)
    expect(service.setCursor(1)).toEqual({ focusQueryId: null })
  })

  it('the held record survives a not-ready start and re-issues on ready', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    service.setGame(GAME, 1)
    await service.start()

    await vi.waitFor(() => {
      expect(analysisEvents().some((r) => r.moveNumber === 1)).toBe(true)
    })
  })
})

describe('the whole-record sweep (Stage 4)', () => {
  const GAME: EngineGame = {
    gameId: 'g1',
    boardSize: 19,
    komi: 6.5,
    rules: 'japanese',
    setup: { black: [], white: [] },
    moves: [
      { player: 'black', coord: { x: 3, y: 3 } },
      { player: 'white', coord: { x: 15, y: 3 } },
    ],
  }

  function analysisEvents(): AnalysisResult[] {
    return sentEvents
      .filter((entry) => entry.channel === 'engine:analysis')
      .map((entry) => entry.payload as AnalysisResult)
  }

  function sweepEvents(gameId: string): AnalysisResult[] {
    return analysisEvents().filter(
      (r) => r.queryId.startsWith(SWEEP_QUERY_PREFIX) && r.gameId === gameId,
    )
  }

  it('setGame starts a sweep: a complete tick for every position arrives under sweep: ids', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()
    service.setGame(GAME, 2)

    // Positions 0, 1, 2 of a 2-move record — one settled point each, the
    // complete-only contract: no partial ever carries a sweep id.
    await vi.waitFor(() => {
      const moves = sweepEvents('g1')
        .map((r) => r.moveNumber)
        .sort((a, b) => a - b)
      expect(moves).toEqual([0, 1, 2])
    })
    for (const event of sweepEvents('g1')) {
      expect(event.complete).toBe(true)
      // The sweep contract on the wire: the fixed visit cap, never ownership.
      // The fake echoes the request's maxVisits and sizes ownership only when
      // asked, so these two fields prove what the query carried.
      expect(event.visits).toBe(100)
      expect(event.ownership).toBeUndefined()
    }
  })

  it('sweep and focus run concurrently for the same record', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()
    service.setGame(GAME, 2)

    await vi.waitFor(() => {
      expect(
        analysisEvents().some((r) => r.queryId.startsWith(FOCUS_QUERY_PREFIX)),
      ).toBe(true)
      expect(sweepEvents('g1')).toHaveLength(3)
    })
    // The focus query rides the settings cap (500), the sweep the fixed one
    // (100) — same record, two tiers, one engine.
    const focus = analysisEvents().find((r) => r.queryId.startsWith(FOCUS_QUERY_PREFIX))
    expect(focus?.visits).toBe(500)
    expect(focus?.moveNumber).toBe(2)
    expect(focus?.ownership).toBeDefined()
  })

  it('a new setGame sweeps the new record: positions arrive under the new gameId', async () => {
    service = await makeService({ locate: fakeArgs('--mode=analysis') })
    await service.start()
    service.setGame(GAME, 2)
    await vi.waitFor(() => {
      expect(sweepEvents('g1')).toHaveLength(3)
    })

    const OTHER: EngineGame = { ...GAME, gameId: 'g2' }
    service.setGame(OTHER, 0)
    await vi.waitFor(() => {
      const moves = sweepEvents('g2')
        .map((r) => r.moveNumber)
        .sort((a, b) => a - b)
      expect(moves).toEqual([0, 1, 2])
    })
    // Every g2 tick names g2 — the gameId correlation the renderer filters on.
    for (const event of sweepEvents('g2')) {
      expect(event.gameId).toBe('g2')
    }
  })
})

describe('crash recovery and the watchdog (Stage 5)', () => {
  /** Six moves → positions 0..6, enough to have pre-crash completions AND unqueried tail. */
  const GAME: EngineGame = {
    gameId: 'g1',
    boardSize: 19,
    komi: 6.5,
    rules: 'japanese',
    setup: { black: [], white: [] },
    moves: Array.from({ length: 6 }, (_, index) => ({
      player: index % 2 === 0 ? 'black' : 'white',
      coord: { x: 3, y: 3 },
    })),
  }

  function analysisEvents(): AnalysisResult[] {
    return sentEvents
      .filter((entry) => entry.channel === 'engine:analysis')
      .map((entry) => entry.payload as AnalysisResult)
  }

  function sweepEvents(gameId: string): AnalysisResult[] {
    return analysisEvents().filter(
      (r) => r.queryId.startsWith(SWEEP_QUERY_PREFIX) && r.gameId === gameId,
    )
  }

  function focusEvents(): AnalysisResult[] {
    return analysisEvents().filter((r) => r.queryId.startsWith(FOCUS_QUERY_PREFIX))
  }

  /**
   * The service's timer seam, captured: watchdog and backoff timers are
   * scheduled but never fire until a test fires them. That is what makes the
   * crash tests fast and ordered — the backoff (1s) and the watchdog deadline
   * (30s) are real policy values, and waiting them for real would make every
   * recovery assertion a timing claim about CI load rather than about the
   * code. The session's own debounce/coalesce timers stay real (the session
   * builds its own), so those paths are exercised in production timing.
   */
  interface Scheduled {
    readonly fn: () => void
    readonly ms: number
    cancelled: boolean
  }
  function timerHarness(): {
    readonly setTimer: (fn: () => void, ms: number) => () => void
    readonly fireFirst: (ms: number) => void
    readonly hasLive: (ms: number) => boolean
  } {
    const timers: Scheduled[] = []
    return {
      setTimer: (fn, ms) => {
        const entry: Scheduled = { fn, ms, cancelled: false }
        timers.push(entry)
        return () => {
          entry.cancelled = true
        }
      },
      fireFirst: (ms) => {
        const index = timers.findIndex((timer) => !timer.cancelled && timer.ms === ms)
        if (index === -1) throw new Error(`no live ${String(ms)}ms timer to fire`)
        const timer = timers[index]
        if (timer === undefined) throw new Error('unreachable')
        timers.splice(index, 1)
        timer.fn()
      },
      hasLive: (ms) => timers.some((timer) => !timer.cancelled && timer.ms === ms),
    }
  }

  it('a mid-analysis crash re-issues the focus and resumes the sweep from the ledger without re-querying completed moves', async () => {
    // Launch 1: 60ms per answer, crash after 5 responses — the probe
    // (response 1), the focus query (2), and sweeps for moves 0, 1, 2 (3–5).
    // Launch 2: healthy, no faults.
    const timers = timerHarness()
    service = await makeService({
      locate: perLaunch(
        ['--mode=analysis', '--delay-ms=60', '--crash-after=5'],
        ['--mode=analysis'],
      ),
      setTimer: timers.setTimer,
    })
    await service.start()
    service.setGame(GAME, 2)

    // The crash lands after the fifth response. Recovery: the badge honestly
    // returns to `starting` while the respawn is pending.
    await vi.waitFor(() => {
      expect(emissions.map((e) => e.status)).toEqual(['starting', 'ready', 'starting'])
    })
    // The ledger held the pre-crash completions: exactly the first three
    // positions arrived before the restart, no more (4–6 were in flight and
    // their answers died with the child).
    expect(
      sweepEvents('g1')
        .map((r) => r.moveNumber)
        .sort((a, b) => a - b),
    ).toEqual([0, 1, 2])
    // The focus query for the held cursor had answered pre-crash.
    expect(focusEvents().map((r) => r.moveNumber)).toEqual([2])

    // The backoff respawn is scheduled (tier 0: 1s) and waiting on the seam.
    expect(timers.hasLive(1_000)).toBe(true)
    timers.fireFirst(1_000)

    // The respawn proves readiness again, re-issues the held focus for the
    // same cursor, and resumes the sweep at the first uncompleted move.
    await vi.waitFor(() => {
      expect(emissions.map((e) => e.status)).toEqual([
        'starting',
        'ready',
        'starting',
        'ready',
      ])
    })
    await vi.waitFor(() => {
      expect(
        sweepEvents('g1')
          .map((r) => r.moveNumber)
          .sort((a, b) => a - b),
      ).toEqual([0, 1, 2, 3, 4, 5, 6])
    })
    // The load-bearing no-re-query assertion: one settled result per position.
    // A resumed sweep that re-issued completed moves would produce a second
    // event for each — the fake answers every query it is sent.
    const counts = new Map<number, number>()
    for (const event of sweepEvents('g1')) {
      counts.set(event.moveNumber, (counts.get(event.moveNumber) ?? 0) + 1)
    }
    expect([...counts.entries()].map(([move]) => move).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])
    for (const [move, count] of counts) {
      expect(count, `sweep move ${String(move)} queried exactly once`).toBe(1)
    }
    // The focus was re-issued for the same cursor: one pre-crack answer, one
    // post-restart re-issue.
    expect(focusEvents().map((r) => r.moveNumber)).toEqual([2, 2])
  })

  it('a hung engine trips the watchdog: terminate-all, kill, restart, analysis resumes', async () => {
    // Launch 1: the focus query never answers (the probe's id does not
    // contain the value, so start still succeeds). Launch 2: healthy.
    const timers = timerHarness()
    service = await makeService({
      locate: perLaunch(['--mode=analysis', '--hang-on=focus:1'], ['--mode=analysis']),
      setTimer: timers.setTimer,
      watchdogDeadlineMs: 400,
    })
    await service.start()
    service.setGame(GAME, 2)

    // The sweep answers (its ids never match the hang target); the focus
    // query hangs forever. Once the sweep is done, the hung focus query is the
    // only thing in flight — and the watchdog's 400ms timer is live.
    await vi.waitFor(() => {
      expect(sweepEvents('g1')).toHaveLength(7)
    })
    expect(timers.hasLive(400)).toBe(true)

    // Fire the deadline: silence with work in flight is a hang, not slowness.
    timers.fireFirst(400)

    await vi.waitFor(() => {
      expect(emissions.map((e) => e.status)).toEqual(['starting', 'ready', 'starting'])
    })
    expect(
      loggerHandle.entries.some(
        (e) => e.msg === 'engine unresponsive with queries in flight',
      ),
    ).toBe(true)

    // The backoff respawn, then readiness and a working focus query again.
    timers.fireFirst(1_000)
    await vi.waitFor(() => {
      expect(emissions.map((e) => e.status)).toEqual([
        'starting',
        'ready',
        'starting',
        'ready',
      ])
    })
    await vi.waitFor(() => {
      expect(focusEvents().map((r) => r.moveNumber)).toEqual([2])
    })
    // Nothing was double-queried: the sweep's completions survived the kill
    // and the restart resumed nothing that was already done.
    expect(sweepEvents('g1')).toHaveLength(7)
  })

  it('a garbage answer to a session query is dropped without failing the engine', async () => {
    service = await makeService({
      locate: perLaunch(['--mode=analysis', '--garbage-on=focus:1']),
      watchdogDeadlineMs: 60_000,
    })
    await service.start()
    service.setGame(GAME, 2)

    // The garbage line answers nothing the parser accepts; the session drops
    // it as unattributable chatter, and the rest of the record still analyses.
    // (B6's inverse: a bad line is not a hang, not a crash, and not a reason
    // for the app to stop working — the watchdog deadline here is long so the
    // still-owed focus query cannot trip it inside the test's lifetime.)
    await vi.waitFor(() => {
      expect(sweepEvents('g1')).toHaveLength(7)
    })
    expect(service.info().status).toBe('ready')
    expect(emissions.map((e) => e.status)).toEqual(['starting', 'ready'])
    expect(focusEvents()).toHaveLength(0)
    expect(
      loggerHandle.entries.some((e) => e.msg === 'ignoring unparseable engine output'),
    ).toBe(true)
  })

  it('shutdown cancels a pending backoff respawn: no orphan engine', async () => {
    const timers = timerHarness()
    service = await makeService({
      locate: perLaunch(['--mode=analysis', '--crash-after=1']),
      setTimer: timers.setTimer,
    })
    await service.start()
    // The probe answered and the child died — a respawn is scheduled.
    await vi.waitFor(() => {
      expect(emissions.map((e) => e.status)).toEqual(['starting', 'ready', 'starting'])
    })
    expect(timers.hasLive(1_000)).toBe(true)
    expect(spawnCount).toBe(1)

    await service.shutdown()

    // The respawn timer was cancelled, not merely outlived: an engine spawning
    // during app teardown would be an orphan holding CPU for a renderer that
    // no longer exists.
    expect(timers.hasLive(1_000)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(spawnCount).toBe(1)
    expect(emissions.map((e) => e.status)).toEqual(['starting', 'ready', 'starting'])
  })

  it('a terminated focus query still concludes with one final reply, and it is dropped', async () => {
    // KataGo's documented terminate behaviour (Analysis_Engine.md): a
    // terminated query concludes with exactly one `isDuringSearch: false`
    // reply. The fake models that since Stage 5, which is what lets this be
    // proven against a real child rather than only at unit level — the gap
    // Stage 3's verify note recorded.
    //
    // One move, so the record's own sweep (2 positions) does not stack the
    // fake's serialised answer queue behind the focus query under test: the
    // answer chain is focus:1 → sweep:0 → sweep:1 → focus:2, and everything
    // the assertion needs lands within the wait below.
    const SHORT: EngineGame = { ...GAME, moves: GAME.moves.slice(0, 1) }
    service = await makeService({
      locate: perLaunch(['--mode=analysis', '--delay-ms=400']),
    })
    await service.start()
    service.setGame(SHORT, 1)
    // Supersede focus:1 (for position 1) before its 400ms answer lands: the
    // cursor debounce fires a terminate and issues focus:2 for position 0.
    service.setCursor(0)

    await vi.waitFor(
      () => {
        expect(focusEvents().map((r) => r.moveNumber)).toEqual([0])
      },
      { timeout: 5_000 },
    )
    // Exactly one focus result — focus:1's mandated final reply arrived (the
    // fake writes it on the terminate) and was dropped by the terminated-
    // entry path, never emitted. A second event for position 1 is the
    // failure this test exists to catch.
    expect(focusEvents()).toHaveLength(1)
  })
})
