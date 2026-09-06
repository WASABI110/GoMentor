import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  encodeAnalysisRequest,
  parseAnalysisResponse,
} from '@gomentor/core/katago/analysis'
import type {
  AnalysisResult,
  EngineGame,
  EngineInfo,
  ErrorCode,
  Settings,
} from '@gomentor/shared'
import { scoped, type Logger } from '../logger'
import { emit } from '../ipc/events'
import { engineConfigFile } from '../paths'
import { buildAnalysisConfig } from './config'
import { locateBundledEngine, planEngineLaunch, type LocateOutcome } from './locate'
import { planRetry, RETRY_WINDOW_MS } from './backoff'
import {
  createEngineProcess,
  type EngineProcess,
  type ExitInfo,
  type SpawnFn,
} from './process'
import { createAnalysisSession, type AnalysisSession } from './session'
import { createSweepLedger, type SweepLedger } from './sweep'
import { reduceEnginePhase, type EngineEvent, type EnginePhase } from './state-machine'

/**
 * The engine service: owns the status state machine, proves readiness with a
 * real query, and answers the `engine:*` channels.
 *
 * ## Startup is lazy and readiness is proven, not declared
 *
 * Nothing happens at app launch beyond reporting `unavailable`. `start()`
 * (fired by the first game open) locates the bundled binary, writes the
 * generated config, spawns the child, and then **probes**: a real analysis
 * query with `maxVisits: 1` on an empty board must round-trip within a
 * deadline. Analysis mode has no version handshake — a stderr banner is not a
 * protocol (`design.md` §Engine lifecycle) — so the only honest "ready" is an
 * answer the production parser accepts. The version string, when the stderr
 * banner carries one, is best-effort metadata for `EngineInfo`.
 *
 * ## Crash recovery (Stage 5): watchdog + bounded backoff
 *
 * An unexpected exit — a crash, or a kill after the watchdog fires — no
 * longer lands on plain `failed`. With retry budget left (`backoff.ts`: ≥3
 * spawn attempts inside 60s → exhausted → `failed(ENGINE_CRASHED)`), the
 * service schedules a respawn after 1s/2s/4s and reports the restart on the
 * wire as `starting` — the badge shape decision is recorded in
 * `state-machine.ts`'s header. On a successful restart, `attachSession`
 * re-issues the held `desired` focus and the sweep ledger survives in the
 * service, so the sweep resumes at its first uncompleted move. The user
 * retrieves an exhausted engine with `engine:start`, which retries with a
 * fresh window.
 *
 * ## The watchdog (B6)
 *
 * While the session reports any query in flight, the service watches stdout
 * activity: every framed line refreshes the clock, and silence beyond
 * `watchdogDeadlineMs` trips terminate-all — one production
 * `encodeTerminateRequest` per in-flight id, cheap even against a hung engine —
 * then `stop()`'s grace and SIGKILL, then the crash path above. The service
 * owns the watchdog because it owns meaning; the process layer owns bytes.
 *
 * The default (30s) is bounded by the *slowest legitimate silence*, not by the
 * report interval: focus queries stream a partial every 0.1s and always refresh
 * the clock, but sweep queries carry no `reportDuringSearchEvery`, so a healthy
 * engine is silent until a sweep query completes — and the sweep runs
 * `SWEEP_CONCURRENCY` queries at once, which at the benchmark-gate envelope
 * (`research/benchmark-eigen.md`: b6c96 measured 311 visits/s aggregate; the
 * planning envelope's conservative low end, 40 visits/s aggregate,
 * `research/eigen-cpu-throughput.md`) puts 8 × 100 visits between 2.6s
 * measured and ~20s at the low end before the first completion. 30s bounds
 * the envelope's low end with margin and still turns "awaited forever" into
 * "restarted within half a minute".
 *
 * ## What stays deliberate
 *
 * `visitsPerSecond` stays unpopulated until the benchmark gate measures it on
 * a real engine — the field exists in the contract precisely so the number,
 * when it arrives, is measured rather than aspirational.
 */

const PROBE_ID = 'gomentor-probe'
const PROBE_BOARD_SIZE = 19
const PROBE_KOMI = 6.5
const DEFAULT_PROBE_DEADLINE_MS = 15_000

/**
 * Watchdog default (ms): silence on stdout with queries in flight beyond this
 * → terminate-all → grace → SIGKILL → the crash path. See the module header
 * for how the value is bounded by the slowest legitimate sweep silence. Not
 * tunable in settings (M2 adds no settings surface); tests inject a short
 * deadline.
 */
const DEFAULT_WATCHDOG_DEADLINE_MS = 30_000

/** `KataGo v1.18.1 …` in the startup banner; the `v` is normalised in. */
const VERSION_PATTERN = /KataGo\s+(v?\d+\.\d+\.\d+)/i

const logger = scoped('main:katago:service')

export interface EngineService {
  /** The current snapshot. Synchronous, so `engine:info` is cheap. */
  info(): EngineInfo
  /**
   * Idempotent start: from `ready` it returns immediately, an in-flight
   * attempt is joined, and `failed`/`unavailable` run the full sequence.
   * Never rejects — every failure is a status transition plus a typed
   * `errorCode` in the snapshot.
   */
  start(): Promise<EngineInfo>
  /** Emits the current snapshot so a freshly mounted badge has real state. */
  notifyStatus(): void
  /**
   * Holds (or clears, with `null`) the record under analysis and issues a
   * focus query for `atMove` when the engine is ready. The request is
   * remembered while the engine starts, so a slow cold start loses nothing.
   */
  setGame(
    game: EngineGame | null,
    atMove: number,
  ): { readonly focusQueryId: string | null }
  /**
   * Moves the analysis cursor. Debounced and terminate-on-supersede inside
   * the session; returns the id the resulting focus query will carry, or null
   * when no record is held or the engine is not ready.
   */
  setCursor(moveNumber: number): { readonly focusQueryId: string | null }
  /** Terminates the child on app quit. A spawned child never outlives the app. */
  shutdown(): Promise<void>
}

export interface EngineServiceOptions {
  /** Settings are read at start time (thread count, default visit cap). */
  readonly settings: { readonly get: () => Settings }
  /** Defaults to `locateBundledEngine`; tests inject outcomes. */
  readonly locate?: () => LocateOutcome
  /** Forwarded to the process layer; tests wrap the fake child's tsx launch. */
  readonly spawn?: SpawnFn
  /** Writes the generated config and returns its path. Default: `userData`. */
  readonly writeConfig?: (contents: string) => string
  /** Status emission. Default: the `engine:status` event. */
  readonly emitStatus?: (info: EngineInfo) => void
  readonly logger?: Logger
  /**
   * Probe deadline. The default is generous on purpose: a first launch on a
   * cold Eigen backend loads a neural net from disk, and a deadline that
   * fires during that load would report `failed` for a healthy engine.
   */
  readonly probeDeadlineMs?: number
  /**
   * Watchdog deadline: stdout silence with queries in flight beyond this is
   * a hang, not slowness (B6). See the module header for the value's
   * reasoning.
   */
  readonly watchdogDeadlineMs?: number
  /** Timer seam: returns a cancel function. Defaults to setTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void
  /** Clock seam for the watchdog, backoff window, and attempt stamps. */
  readonly now?: () => number
}

type ProbeResult =
  | { readonly kind: 'response'; readonly result: AnalysisResult }
  | { readonly kind: 'exit'; readonly info: ExitInfo }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'parse-failed' }

interface Deferred<T> {
  readonly promise: Promise<T>
  /** No-op once settled — late stdout/exit events must not double-resolve. */
  resolve(value: T): void
  readonly settled: boolean
}

function createDeferred<T>(): Deferred<T> {
  let settled = false
  let resolveFn: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return {
    promise,
    get settled() {
      return settled
    },
    resolve(value) {
      if (settled) return
      settled = true
      resolveFn(value)
    },
  }
}

export function createEngineService(options: EngineServiceOptions): EngineService {
  const locate = options.locate ?? locateBundledEngine
  const writeConfig = options.writeConfig ?? defaultWriteConfig
  const emitStatus =
    options.emitStatus ??
    ((info: EngineInfo) => {
      emit('engine:status', info)
    })
  const log = options.logger ?? logger
  const probeDeadlineMs = options.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS
  const watchdogDeadlineMs = options.watchdogDeadlineMs ?? DEFAULT_WATCHDOG_DEADLINE_MS
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms)
      return () => {
        clearTimeout(timer)
      }
    })
  const now = options.now ?? Date.now

  let phase: EnginePhase = 'unavailable'
  let backend: EngineInfo['backend']
  let version: string | undefined
  let networkName: string | undefined
  // `ErrorCode`, not `string`: the wire schema parses `errorCode` through
  // `errorCodeSchema`, so an invented code is now a compile error here rather
  // than a runtime rejection at the boundary (or worse, an untranslatable key
  // in the renderer).
  let failureCode: ErrorCode | undefined
  let proc: EngineProcess | null = null
  let session: AnalysisSession | null = null
  /**
   * Spawn times of every attempt — the circuit breaker's input
   * (`backoff.ts`), pruned to the retry window at each crash. Deliberately
   * NOT cleared on a successful probe: a spawn whose probe answers and whose
   * process then dies is still a failed attempt inside the window — clearing
   * on success would make three consecutive crash-restarts loop forever,
   * which is exactly what the breaker exists to stop. Ageing out is the
   * healthy engine's clean slate (an engine that runs for ten minutes and
   * crashes once restarts with a fresh window), and exhaustion clears the
   * list so the user's manual `engine:start` retries fresh.
   */
  let attemptTimes: number[] = []
  /** The pending backoff respawn, if any. Cancelled by shutdown and superseded starts. */
  let retryCancel: (() => void) | null = null
  /** The armed watchdog's cancel function, or null when disarmed. */
  let watchdogCancel: (() => void) | null = null
  /** True between a watchdog trip and the crash path it feeds, so re-entrant notifications cannot re-trip. */
  let watchdogTripping = false
  /**
   * The analysis the renderer most recently asked for. Survives not-ready
   * phases: `setGame`/`setCursor` before readiness only update this record,
   * and the moment the readiness probe succeeds the held position is issued.
   * On a crash the session is rebuilt by the next successful start and the
   * same record re-issued — the renderer never takes part in recovery.
   */
  let desired: { game: EngineGame | null; atMove: number } = {
    game: null,
    atMove: 0,
  }
  /**
   * The sweep ledger for the held record. Owned here — not by the session —
   * so completion bookkeeping survives the session rebuild after an engine
   * crash: the restarted session resumes at the first uncompleted move (see
   * `sweep.ts` §Ledger ownership). Replaced wholesale on every `setGame`, which
   * is the recorded "a new record restarts the sweep" rule.
   */
  let sweepLedger: SweepLedger | null = null
  let startPromise: Promise<EngineInfo> | null = null
  let stopped = false

  /** Built from the phase plus the detail fields, so there is one snapshot shape. */
  function snapshot(): EngineInfo {
    return {
      status: phase,
      ...(backend === undefined ? {} : { backend }),
      ...(version === undefined ? {} : { version }),
      ...(networkName === undefined ? {} : { networkName }),
      ...(failureCode === undefined ? {} : { errorCode: failureCode }),
    }
  }

  /** Applies an event; emits only on an actual transition. */
  function transition(event: EngineEvent): void {
    const next = reduceEnginePhase(phase, event)
    if (next === phase) return
    phase = next
    emitStatus(snapshot())
  }

  function handleLocateFailure(
    outcome: Exclude<LocateOutcome, { kind: 'found' }>,
  ): EngineInfo {
    switch (outcome.kind) {
      case 'unsupported':
        // Not a failure — no engine tier exists for this platform (macOS, or
        // a non-x64 machine). `unavailable` is the honest permanent state.
        log.info('no bundled engine for this platform', {
          platform: process.platform,
          arch: process.arch,
        })
        transition({ kind: 'missing-in-dev' })
        return snapshot()
      case 'binary-missing':
        if (outcome.mode === 'dev') {
          log.warn('engine binary not found — run `pnpm fetch:katago`', {
            searched: outcome.searched,
          })
          transition({ kind: 'missing-in-dev' })
        } else {
          // Packaged (a zero-config build with no engine is a defect) or an
          // override pointing nowhere (a demanded binary that is not there).
          log.error('engine binary missing', {
            searched: outcome.searched,
            mode: outcome.mode,
          })
          failureCode = 'ENGINE_BINARY_MISSING'
          transition({ kind: 'start-failed' })
        }
        return snapshot()
      case 'binary-not-executable':
        if (outcome.mode === 'dev') {
          log.warn('engine binary is not executable — re-run `pnpm fetch:katago`', {
            path: outcome.path,
          })
          transition({ kind: 'missing-in-dev' })
        } else {
          log.error('engine binary is not executable', { path: outcome.path })
          failureCode = 'ENGINE_BINARY_MISSING'
          transition({ kind: 'start-failed' })
        }
        return snapshot()
      case 'network-missing':
        if (outcome.mode === 'dev') {
          log.warn('network weights not found — run `pnpm fetch:weights`', {
            dir: outcome.dir,
          })
          transition({ kind: 'missing-in-dev' })
        } else {
          log.error('network weights missing from installation', { dir: outcome.dir })
          failureCode = 'ENGINE_BINARY_MISSING'
          transition({ kind: 'start-failed' })
        }
        return snapshot()
      case 'network-ambiguous':
        log.warn('multiple network weights found; refusing to guess', {
          dir: outcome.dir,
          matches: [...outcome.matches],
        })
        if (outcome.mode === 'dev') transition({ kind: 'missing-in-dev' })
        else {
          failureCode = 'ENGINE_BINARY_MISSING'
          transition({ kind: 'start-failed' })
        }
        return snapshot()
    }
  }

  function handleProbeLine(line: string, probe: Deferred<ProbeResult>): void {
    if (probe.settled) return
    let parsed: AnalysisResult
    try {
      parsed = parseAnalysisResponse(line, {
        gameId: PROBE_ID,
        moveNumber: 0,
        player: 'black',
        boardSize: PROBE_BOARD_SIZE,
      })
    } catch (error) {
      // A line that is not ours (or not anything) does not get to fail the
      // probe — engines occasionally chatter on stdout, and the production
      // parser throwing `ENGINE_QUERY_FAILED` on it is normal. But a line
      // that names our probe id and will not parse means the engine answered
      // the probe with garbage: it is not speaking the analysis protocol, and
      // that is fatal. The id is distinctive enough that an accidental match
      // is implausible — and a garbage-spewing engine fails the probe anyway,
      // one deadline later.
      if (line.includes(PROBE_ID)) {
        log.failure('probe response was not a well-formed analysis result', error)
        probe.resolve({ kind: 'parse-failed' })
      } else {
        log.debug('ignoring unparseable engine output', { length: line.length })
      }
      return
    }
    if (parsed.queryId === PROBE_ID) {
      probe.resolve({ kind: 'response', result: parsed })
    }
  }

  /**
   * The watchdog (B6): armed while the session reports queries in flight,
   * refreshed by every framed stdout line, and fired by silence beyond the
   * deadline. The deadline is deliberately not the report interval: sweep
   * queries carry no `reportDuringSearchEvery`, so a healthy engine is silent
   * for a whole 100-visit search — the bound is "healthy query duration",
   * not "time between reports".
   */
  function armWatchdog(): void {
    if (watchdogCancel !== null || stopped) return
    watchdogCancel = setTimer(() => {
      watchdogCancel = null
      void onWatchdogTrip()
    }, watchdogDeadlineMs)
  }

  function disarmWatchdog(): void {
    if (watchdogCancel !== null) {
      watchdogCancel()
      watchdogCancel = null
    }
  }

  /** Refreshes the silence clock; called for every framed stdout line. */
  function noteActivity(): void {
    if (watchdogCancel === null) return
    // Full deadline from the latest line: a steadily-chatty engine never
    // trips, and one gap — however late it starts — is what counts.
    disarmWatchdog()
    armWatchdog()
  }

  /** Session notification: non-zero in-flight arms, zero disarms. */
  function onInFlightChanged(count: number): void {
    if (watchdogTripping) return
    if (count > 0) armWatchdog()
    else disarmWatchdog()
  }

  async function onWatchdogTrip(): Promise<void> {
    if (watchdogTripping) return
    watchdogTripping = true
    const live = proc
    log.warn('engine unresponsive with queries in flight', {
      inFlight: session?.inFlightCount() ?? 0,
      deadlineMs: watchdogDeadlineMs,
    })
    // Protocol courtesy first: one terminate per in-flight id. Against a
    // hung engine these are cheap no-ops on a dead stdin; against a merely
    // stuck one they let it conclude cleanly. Either way the kill below is
    // what actually frees the child — per design, a tripped watchdog always
    // restarts, it does not forgive.
    session?.terminateAllInFlight()
    if (live === null) {
      watchdogTripping = false
      return
    }
    // stop() is stdin-close → grace → SIGKILL; a truly hung engine gets the
    // SIGKILL. The exit it produces is classified `expected` by the process
    // layer, so handleExit ignores it — the watchdog itself reports the crash.
    await live.stop()
    watchdogTripping = false
    if (stopped) return
    if (proc !== live) return
    handleUnexpectedExit(null)
  }

  /**
   * The single crash path: unexpected exit (a real exit event, info carried)
   * or watchdog kill (info null, the watchdog is the reporter). Disposes the
   * session, then either schedules a bounded backoff respawn (`crash-retry`,
   * reported on the wire as `starting`) or, at three attempts inside the
   * window, lands on `failed(ENGINE_CRASHED)` retrievable via `engine:start`.
   */
  function handleUnexpectedExit(info: ExitInfo | null): void {
    if (stopped) return
    disarmWatchdog()
    if (info === null) {
      log.warn('engine killed after watchdog expiry')
    } else {
      log.warn('engine exited unexpectedly', { code: info.code, signal: info.signal })
    }
    proc = null
    session?.dispose()
    session = null
    // Prune to the window before consulting the breaker: entries older than
    // RETRY_WINDOW_MS have already served their purpose, and keeping them
    // would both grow the array forever and (were planRetry's own filter
    // removed) count against a fresh engine.
    const at = now()
    attemptTimes = attemptTimes.filter((t) => at - t < RETRY_WINDOW_MS)
    const plan = planRetry(attemptTimes, now())
    if (plan.kind === 'exhausted') {
      attemptTimes = []
      failureCode = 'ENGINE_CRASHED'
      transition({ kind: 'crashed' })
      return
    }
    transition({ kind: 'crash-retry' })
    log.info('engine restart scheduled', {
      delayMs: plan.delayMs,
      attempts: attemptTimes.length,
    })
    retryCancel = setTimer(() => {
      retryCancel = null
      void launch()
    }, plan.delayMs)
  }

  function handleExit(info: ExitInfo, probe: Deferred<ProbeResult> | null): void {
    if (info.expected) return
    if (probe !== null && !probe.settled) {
      probe.resolve({ kind: 'exit', info })
      return
    }
    // A failure already reported (probe timeout, parse failure, …) stands: a
    // late exit from the process we are stopping must not rewrite it.
    if (phase !== 'starting' && phase !== 'ready') return
    handleUnexpectedExit(info)
  }

  /**
   * Binds a fresh analysis session to the live process and re-issues the
   * held analysis, if any. Called once per successful start: the session is
   * per-process, so a restart (crash retry, Stage 5's backoff) rebuilds it.
   * The sweep ledger is not rebuilt — the same instance resumes, which is
   * what makes a post-crash sweep continue at its first uncompleted move.
   */
  function attachSession(): void {
    if (proc === null || session !== null) return
    session = createAnalysisSession({
      send: (line) => {
        proc?.send(line)
      },
      onResult: (result) => {
        emit('engine:analysis', result)
      },
      settings: options.settings,
      logger: log,
      onInFlightChange: onInFlightChanged,
    })
    if (desired.game !== null) {
      session.setGame(desired.game, desired.atMove)
      if (sweepLedger !== null) session.startSweep(sweepLedger)
    }
  }

  /**
   * Runs one spawn attempt and tracks it as such: `startPromise` is held for
   * the attempt's lifetime so a user `engine:start` during a backoff
   * respawn joins it rather than racing a second spawn, and any pending
   * backoff timer is cancelled first — a manual start supersedes the
   * scheduled one.
   */
  function launch(): Promise<EngineInfo> {
    // Double-checked with the timer's cancellation in `shutdown()`: a
    // respawn after quit would be an orphan holding CPU for nothing.
    if (stopped) return Promise.resolve(snapshot())
    if (retryCancel !== null) {
      retryCancel()
      retryCancel = null
    }
    const attempt = doStart()
    startPromise = attempt
    return attempt.finally(() => {
      startPromise = null
    })
  }

  async function doStart(): Promise<EngineInfo> {
    transition({ kind: 'start-requested' })
    const outcome = locate()
    if (outcome.kind !== 'found') {
      return handleLocateFailure(outcome)
    }

    backend = 'eigen'
    networkName = outcome.network.split(/[\\/]/).at(-1) ?? outcome.network
    failureCode = undefined
    version = undefined

    let configPath: string
    try {
      const settings = options.settings.get()
      configPath = writeConfig(
        buildAnalysisConfig({
          threads: settings.engine.threads,
          maxVisits: settings.engine.maxVisits,
        }),
      )
    } catch (error) {
      log.failure('engine config could not be written', error)
      failureCode = 'SETTINGS_WRITE_FAILED'
      transition({ kind: 'start-failed' })
      return snapshot()
    }

    const probe = createDeferred<ProbeResult>()
    try {
      // A script override (the env-override diagnostics seam) is exec'd through
      // the app's own runtime with the tsx loader; a bundled binary is exec'd
      // directly. `planEngineLaunch` is the one place that knows which is
      // which — the spawn seam below stays a faithful passthrough either way.
      const launchPlan = planEngineLaunch(outcome.binary, process.execPath)
      // This spawn is one breaker attempt — recorded before the process
      // exists, so even a spawn that dies instantly counts (a crash that
      // outruns bookkeeping would give the breaker a free pass).
      attemptTimes.push(now())
      proc = createEngineProcess({
        binary: launchPlan.command,
        args: [
          ...launchPlan.prefixArgs,
          'analysis',
          '-config',
          configPath,
          '-model',
          outcome.network,
        ],
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        ...(launchPlan.env === null ? {} : { env: launchPlan.env }),
        logger: log,
        onLine: (line) => {
          noteActivity()
          handleProbeLine(line, probe)
          // Probe lines carry the probe id, which the session does not own;
          // session lines likewise carry no probe id. Routing by id makes the
          // two handlers safe to run for every line.
          session?.handleLine(line)
        },
        onExit: (info) => {
          handleExit(info, probe)
        },
      })
    } catch (error) {
      // Synchronous spawn failure (e.g. the platform refused the executable).
      // The async `error`-event path below resolves the same way; this is its
      // twin for the throw-on-launch case.
      log.failure('engine process could not be launched', error, {
        binary: outcome.binary,
      })
      failureCode = 'ENGINE_CRASHED'
      transition({ kind: 'crashed' })
      return snapshot()
    }

    proc.send(
      encodeAnalysisRequest({
        id: PROBE_ID,
        boardSize: PROBE_BOARD_SIZE,
        komi: PROBE_KOMI,
        rules: 'chinese',
        moves: [],
        maxVisits: 1,
      }),
    )

    const timeout = setTimeout(() => {
      probe.resolve({ kind: 'deadline' })
    }, probeDeadlineMs)
    const result = await probe.promise
    clearTimeout(timeout)
    if (stopped) return snapshot()

    switch (result.kind) {
      case 'response': {
        version = scanVersion(proc.stderrTail())
        log.info('engine ready', {
          ...(version === undefined ? {} : { version }),
          network: networkName,
        })
        transition({ kind: 'probe-succeeded' })
        attachSession()
        break
      }
      case 'exit': {
        // A crash during the probe is an unexpected exit like any other: the
        // same crash path decides retry-or-fail. (The state stays `starting`
        // on a retry — `crash-retry` is a no-op there — which is exactly the
        // honest badge: an engine is coming up.)
        handleUnexpectedExit(result.info)
        break
      }
      case 'deadline': {
        log.warn('engine readiness probe timed out', { deadlineMs: probeDeadlineMs })
        failureCode = 'ENGINE_START_TIMEOUT'
        transition({ kind: 'probe-timed-out' })
        void proc.stop()
        break
      }
      case 'parse-failed': {
        failureCode = 'ENGINE_QUERY_FAILED'
        transition({ kind: 'start-failed' })
        void proc.stop()
        break
      }
    }
    return snapshot()
  }

  return {
    info: () => snapshot(),

    async start() {
      if (stopped) return snapshot()
      if (phase === 'ready') return snapshot()
      if (startPromise !== null) return startPromise
      return launch()
    },

    notifyStatus() {
      emitStatus(snapshot())
    },

    setGame(game, atMove) {
      desired = { game, atMove: game === null ? 0 : atMove }
      if (session === null) {
        // Not ready: the request is held and issued by `attachSession` the
        // moment the readiness probe succeeds. The ledger is built now so the
        // sweep starts from move 0 either way.
        sweepLedger = game === null ? null : createSweepLedger(game.moves.length)
        return { focusQueryId: null }
      }
      if (game === null) {
        sweepLedger = null
        session.clearGame()
        return { focusQueryId: null }
      }
      sweepLedger = createSweepLedger(game.moves.length)
      const focusQueryId = session.setGame(game, atMove)
      session.startSweep(sweepLedger)
      return { focusQueryId }
    },

    setCursor(moveNumber) {
      if (desired.game === null) return { focusQueryId: null }
      desired = { game: desired.game, atMove: moveNumber }
      if (session === null) return { focusQueryId: null }
      return { focusQueryId: session.setCursor(moveNumber) }
    },

    async shutdown() {
      stopped = true
      // A pending backoff respawn must die here: the timer callback checks
      // `stopped`, but cancelling is the guarantee that survives a future
      // edit of that check — an engine spawning during app teardown is an
      // orphan holding CPU out of nothing.
      if (retryCancel !== null) {
        retryCancel()
        retryCancel = null
      }
      disarmWatchdog()
      const live = proc
      proc = null
      session?.dispose()
      session = null
      // No emission: shutdown runs during quit, when the renderer that would
      // render a status change is already gone.
      phase = reduceEnginePhase(phase, { kind: 'shutdown' })
      if (live !== null) await live.stop()
    },
  }
}

function defaultWriteConfig(contents: string): string {
  const target = engineConfigFile()
  // `userData` exists by the time the engine starts (lazy start implies a
  // window is up), but `recursive` keeps this honest under test fakes.
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, 'utf8')
  return target
}

/** Best-effort version from the stderr banner; undefined when it carries none. */
function scanVersion(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = VERSION_PATTERN.exec(line)
    if (match?.[1] !== undefined) {
      const raw = match[1]
      return raw.startsWith('v') ? raw : `v${raw}`
    }
  }
  return undefined
}
