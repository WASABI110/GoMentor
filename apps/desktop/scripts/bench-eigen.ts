/**
 * Real-engine throughput benchmark (M2 Stage 2/3 gate evidence).
 *
 * Spawns the **bundled** KataGo Eigen build through the production process
 * layer (`main/katago/process.ts`) and the production protocol codecs
 * (`@gomentor/core/katago/analysis`), with the config the app itself generates
 * (`main/katago/config.ts`). Deliberately does NOT import `service.ts` /
 * `session.ts` — those pull the electron-bound logger and IPC emitter, and the
 * state machine is not the subject of a throughput measurement. Everything
 * that shapes the numbers (config string, launch args, framing, parsing) is
 * the production code.
 *
 * Measures, in order:
 *
 * 1. **Cold start** — spawn → the same `maxVisits: 1` probe the service uses
 *    for readiness. This is B3's "first complete read" floor and the number
 *    the 15s probe deadline must bound.
 * 2. **Focus latency** — three 500-visit queries (the settings default) with
 *    ownership on, at three different positions so NN-cache reuse cannot make
 *    repeats look free. Median wall time → visits/s.
 * 3. **Sweep aggregate** — 8 concurrent 100-visit queries with ownership off,
 *    exactly the shape the 30s watchdog deadline is bounded by (service.ts
 *    header: `SWEEP_CONCURRENCY` × 100 visits). Aggregate wall time →
 *    aggregate visits/s.
 *
 * Run: `pnpm -F @gomentor/desktop bench:engine`
 * Results land in the task's research dir; this script only prints them.
 */

import { cpus } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encodeAnalysisRequest,
  parseAnalysisResponse,
} from '@gomentor/core/katago/analysis'
import type { AnalysisResult, Player } from '@gomentor/shared'
import { buildAnalysisConfig } from '../src/main/katago/config'
import { createEngineProcess } from '../src/main/katago/process'

const BINARY = join(
  fileURLToPath(new URL('../resources/katago/win32-x64', import.meta.url)),
  'katago.exe',
)
/** The bundled net; override with an alternative path to re-measure (e.g. b10c128). */
const NETWORK =
  process.argv[2] ??
  fileURLToPath(
    new URL(
      '../resources/weights/kata1-b6c96-s175395328-d26788732.txt.gz',
      import.meta.url,
    ),
  )

/** The settings defaults (`packages/shared/src/types/settings.ts`). */
const THREADS = 4
const FOCUS_VISITS = 500
const KOMI = 6.5
const RULES = 'chinese'
const BOARD = 19

/** A plausible 30-move 19×19 fuseki; every point distinct, nothing captured. */
const GAME: readonly { player: Player; x: number; y: number }[] = [
  { player: 'black', x: 15, y: 3 },
  { player: 'white', x: 3, y: 3 },
  { player: 'black', x: 15, y: 15 },
  { player: 'white', x: 3, y: 15 },
  { player: 'black', x: 9, y: 9 },
  { player: 'white', x: 9, y: 3 },
  { player: 'black', x: 9, y: 15 },
  { player: 'white', x: 3, y: 9 },
  { player: 'black', x: 15, y: 9 },
  { player: 'white', x: 6, y: 6 },
  { player: 'black', x: 12, y: 12 },
  { player: 'white', x: 6, y: 12 },
  { player: 'black', x: 12, y: 6 },
  { player: 'white', x: 10, y: 10 },
  { player: 'black', x: 8, y: 8 },
  { player: 'white', x: 11, y: 11 },
  { player: 'black', x: 7, y: 7 },
  { player: 'white', x: 13, y: 13 },
  { player: 'black', x: 5, y: 5 },
  { player: 'white', x: 14, y: 14 },
  { player: 'black', x: 4, y: 4 },
  { player: 'white', x: 16, y: 16 },
  { player: 'black', x: 16, y: 4 },
  { player: 'white', x: 4, y: 16 },
  { player: 'black', x: 10, y: 4 },
  { player: 'white', x: 10, y: 14 },
  { player: 'black', x: 4, y: 10 },
  { player: 'white', x: 14, y: 10 },
  { player: 'black', x: 13, y: 9 },
  { player: 'white', x: 5, y: 9 },
]

function prefixMoves(n: number): { player: Player; coord: { x: number; y: number } }[] {
  return GAME.slice(0, n).map((move) => ({
    player: move.player,
    coord: { x: move.x, y: move.y },
  }))
}

const consoleLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  failure: () => undefined,
}

/** Every `complete` result this run still waits on. */
const waiters = new Map<string, (done: { visits: number }) => void>()

function dispatch(line: string): void {
  let result: AnalysisResult
  try {
    result = parseAnalysisResponse(line, {
      gameId: 'bench',
      moveNumber: 0,
      // `player` only anchors the ownership-perspective decode, and the
      // benchmark reads only visits/timing — the constant is deliberate.
      player: 'black',
      boardSize: BOARD,
    })
  } catch {
    return // not an analysis line (banner-adjacent noise goes to stderr anyway)
  }
  if (!result.complete) return
  const resolve = waiters.get(result.queryId)
  if (resolve === undefined) return
  waiters.delete(result.queryId)
  resolve({ visits: result.visits })
}

function query(
  proc: ReturnType<typeof createEngineProcess>,
  id: string,
  moveNumber: number,
  maxVisits: number,
  includeOwnership: boolean,
): Promise<{ visits: number }> {
  return new Promise<{ visits: number }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(id)
      reject(new Error(`${id}: no complete result within 120s`))
    }, 120_000)
    waiters.set(id, (done) => {
      clearTimeout(timeout)
      resolve(done)
    })
    proc.send(
      encodeAnalysisRequest({
        id,
        boardSize: BOARD,
        komi: KOMI,
        rules: RULES,
        moves: prefixMoves(moveNumber),
        maxVisits,
        ...(includeOwnership ? { includeOwnership: true } : {}),
      }),
    )
  })
}

async function main(): Promise<void> {
  const configPath = join(
    mkdtempSync(join(tmpdir(), 'gomentor-bench-')),
    'analysis.cfg',
  )
  writeFileSync(
    configPath,
    buildAnalysisConfig({ threads: THREADS, maxVisits: FOCUS_VISITS }),
  )

  const started = Date.now()
  const proc = createEngineProcess({
    binary: BINARY,
    args: ['analysis', '-config', configPath, '-model', NETWORK],
    logger: consoleLogger,
    onLine: dispatch,
    onExit: (info) => {
      if (!info.expected) {
        console.error('engine exited uninvited:', info)
        console.error('stderr tail:', proc.stderrTail().slice(-10).join('\n'))
      }
    },
  })

  // 1. Cold start: spawn → the service's readiness probe.
  await query(proc, 'bench-probe', 0, 1, false)
  const coldMs = Date.now() - started
  console.log(`cold start (spawn → 1-visit probe complete): ${coldMs} ms`)

  // 2. Focus: three 500-visit queries at distinct positions, ownership on.
  const focusTimes: number[] = []
  for (const moveNumber of [30, 24, 27]) {
    const id = `bench-focus-${moveNumber}`
    const t0 = Date.now()
    const done = await query(proc, id, moveNumber, FOCUS_VISITS, true)
    const ms = Date.now() - t0
    focusTimes.push(ms)
    console.log(
      `focus @move ${moveNumber}: ${ms} ms (${done.visits} visits, ${((done.visits / ms) * 1000).toFixed(0)} visits/s)`,
    )
  }
  const medianFocus = focusTimes.sort((a, b) => a - b)[1]
  if (medianFocus === undefined) throw new Error('no focus measurements recorded')
  console.log(
    `focus median: ${medianFocus} ms → ${((FOCUS_VISITS / medianFocus) * 1000).toFixed(0)} visits/s`,
  )

  // 3. Sweep aggregate: 8 × 100 visits concurrently, ownership off.
  const sweepMoveNumbers = [3, 6, 9, 12, 15, 18, 21, 27]
  const sweepStart = Date.now()
  await Promise.all(
    sweepMoveNumbers.map((moveNumber, i) =>
      query(proc, `bench-sweep-${i}`, moveNumber, 100, false),
    ),
  )
  const sweepMs = Date.now() - sweepStart
  const sweepVisits = sweepMoveNumbers.length * 100
  console.log(
    `sweep aggregate (8 × 100 visits): ${sweepMs} ms → ${((sweepVisits / sweepMs) * 1000).toFixed(0)} visits/s aggregate`,
  )

  await proc.stop()
  console.log('\n--- machine context (record with the numbers) ---')
  console.log(`platform: ${process.platform} ${process.arch}`)
  const list = cpus()
  console.log(`cpus: ${list.length} × ${list[0]?.model}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
