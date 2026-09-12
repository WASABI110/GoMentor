/**
 * Mutation harness for the M4 profile-input pipeline — Stage 2's batch
 * analysis (queue planning, resume planning, winrate-loss projection, the
 * query builder, and the ledger-driven driver) plus the "my game" predicate
 * the `mine` scope and Stage 3's profile both filter through.
 *
 * A passing suite proves the code does not crash. It does not prove the
 * assertions are load-bearing. This deliberately breaks each decision the
 * layer makes and requires the suite to notice.
 *
 * Same validity gate as the katago and llm harnesses, including the two
 * guards that have both fired on real mistakes: a baseline that is not green
 * aborts the whole run (every result would be meaningless), and a baseline
 * reporting zero tests aborts too — an instrument that measured nothing
 * reports `0 escaped`, which is the most reassuring possible output from a
 * harness covering nothing. A mutated run whose test total differs from
 * baseline broke collection rather than behaviour, and is reported INVALID
 * rather than counted as caught.
 *
 * The exit code is the gate, not the summary. An escaped mutant or an invalid
 * anchor exits non-zero: a report that only a human reading the output would
 * act on is not a gate, and exit 0 under `*** ESCAPED ***` lines is exactly
 * the green-that-isn't this harness exists to prevent.
 *
 * Four suites run per mutation, one vitest invocation: the pure queue/resume
 * core (`test/unit/batch-plan`), the mine predicate (`test/unit/mine`), the
 * batch query builder next to its session siblings
 * (`test/unit/katago/katago-session`), and the ledger-driven driver against
 * the real engine service and a real database file
 * (`test/integration/batch`). The driver mutants (yield, waves, chunk flush,
 * abort policy, accounting) are only observable through the integration
 * suite; the pure mutants are caught by the unit suites before integration
 * even starts. Filters are relative to the *project* root, not the repo
 * root — the exact mistake the baseline gate exists to catch, since a filter
 * that matches nothing exits 0.
 *
 * Deliberately not covered here, with the reason each exclusion is safe:
 *
 * - The `plan.startPosition > moveCount` gap-closing branch in `batch.ts`:
 *   falling through is observably identical (the loop no-ops, the final
 *   `markDone` commits the same empty remainder). The branch protects the
 *   same-transaction invariant, which the crash test pins through the
 *   ledger states it does assert.
 * - The resume-seed-missing replan (`plan = planGameRun([])`): unreachable
 *   without a tampered database — `winrateAt` can only miss on a row the
 *   contiguous-prefix contract says is present. Not constructible in a test.
 * - The yield predicate's `info().status === 'ready'` half on its own: no
 *   test parks a focus session on a dead engine. The focus half is mutated
 *   (D1/D2); the ready half rides along in every driver test's engine-lost
 *   assertions.
 * - `YIELD_POLL_MS` and the sleep seam: timing, not asserted behaviour.
 * - The batch window's source `.positions`: at the default 4 threads the
 *   sibling field `.threadsPerPosition` is numerically identical (both 2),
 *   so a mutant there reports green without testing anything. The wave
 *   arithmetic mutants (D3/D4) cover the window logic itself.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const MINE = 'apps/desktop/src/main/library/mine.ts'
const PLAN = 'apps/desktop/src/main/katago/batch-plan.ts'
const SESSION = 'apps/desktop/src/main/katago/session.ts'
const BATCH = 'apps/desktop/src/main/katago/batch.ts'

/**
 * `buildBatchQuery`'s opening lines, shared prefix for the B-series anchors.
 * The function body is field-for-field identical to `buildSweepQuery`'s, so
 * no interior line is unique on its own — every anchor spans from the
 * function head (the llm harness's L28 pattern).
 */
const BATCH_FN =
  'export function buildBatchQuery(\n  id: string,\n  game: EngineGame,\n  atMove: number,\n): AnalysisQuery {'
const BATCH_CLAMP =
  BATCH_FN +
  '\n  const moveNumber = Math.max(0, Math.min(Math.trunc(atMove), game.moves.length))'
const BATCH_ID = BATCH_CLAMP + '\n  return {\n    id,'
const BATCH_FIELDS =
  BATCH_ID +
  '\n    boardSize: game.boardSize,\n    komi: game.komi,\n    rules: toKataGoRuleset(game.rules),\n    moves: game.moves\n      .slice(0, moveNumber)\n      .map((move) => ({ player: move.player, coord: move.coord })),\n    initialStones: ['
const BATCH_BLACK =
  "\n      ...game.setup.black.map((coord) => ({ player: 'black' as const, coord })),"
const BATCH_OBJ =
  BATCH_FIELDS +
  BATCH_BLACK +
  "\n      ...game.setup.white.map((coord) => ({ player: 'white' as const, coord })),\n    ],"

interface Mutation {
  readonly id: string
  readonly file: string
  readonly what: string
  readonly from: string
  readonly to: string
}

const MUTATIONS: Mutation[] = [
  // --- mine.ts: the "my game" predicate (precedence and matching) ----------
  {
    id: 'G1',
    file: MINE,
    what: 'let override:false fall through to name matching',
    from: '  if (override !== undefined) return override',
    to: '  if (override === true) return override',
  },
  {
    id: 'G2',
    file: MINE,
    what: 'invert the override (the manual mark means its opposite)',
    from: '  if (override !== undefined) return override',
    to: '  if (override !== undefined) return !override',
  },
  {
    id: 'G3',
    file: MINE,
    what: 'match the list side case-sensitively',
    from: 'playerNames.map((name) => name.toLowerCase()).filter((name) => name.length > 0),',
    to: 'playerNames.map((name) => name).filter((name) => name.length > 0),',
  },
  {
    id: 'G4',
    file: MINE,
    what: 'match the black record side case-sensitively',
    from: 'wanted.has(names.blackName.toLowerCase())) ||',
    to: 'wanted.has(names.blackName)) ||',
  },
  {
    id: 'G5',
    file: MINE,
    what: 'match the white record side case-sensitively',
    from: '    (names.whiteName !== undefined && wanted.has(names.whiteName.toLowerCase()))',
    to: '    (names.whiteName !== undefined && wanted.has(names.whiteName))',
  },
  {
    id: 'G6',
    file: MINE,
    what: 'match black only (the student studies their white games too)',
    from: '    (names.blackName !== undefined && wanted.has(names.blackName.toLowerCase())) ||\n    (names.whiteName !== undefined && wanted.has(names.whiteName.toLowerCase()))',
    to: '    (names.blackName !== undefined && wanted.has(names.blackName.toLowerCase())) ||\n    false',
  },
  {
    id: 'G7',
    file: MINE,
    what: 'drop the empty-name filter (an empty list entry matches an empty player name)',
    from: '.filter((name) => name.length > 0),',
    to: '.filter(() => true),',
  },
  {
    id: 'G8',
    file: MINE,
    what: 'reject the single-name list (the guard fires on exactly one configured name)',
    from: '  if (wanted.size === 0) return false',
    to: '  if (wanted.size === 1) return false',
  },
  // --- batch-plan.ts: queue selection, resume planning, loss projection ----
  {
    id: 'P1',
    file: PLAN,
    what: 'project the loss as before − after (drops the opponent-swap −1)',
    from: '  return previousWinrate + currentWinrate - 1',
    to: '  return previousWinrate - currentWinrate',
  },
  {
    id: 'P2',
    file: PLAN,
    what: 'clamp the loss at zero (a follow-up the engine rates higher reads as no gain)',
    from: '  return previousWinrate + currentWinrate - 1',
    to: '  return Math.max(0, previousWinrate + currentWinrate - 1)',
  },
  {
    id: 'P3',
    file: PLAN,
    what: 'start a fresh game at move 1 (the empty board never seeds move 1’s loss)',
    from: '  if (lastPersisted === 0) return { startPosition: 0, resumeFromMove: null }',
    to: '  if (lastPersisted === 0) return { startPosition: 1, resumeFromMove: null }',
  },
  {
    id: 'P4',
    file: PLAN,
    what: 'resume two past the last persisted row (a move is never analysed)',
    from: '  return { startPosition: lastPersisted + 1, resumeFromMove: lastPersisted }',
    to: '  return { startPosition: lastPersisted + 2, resumeFromMove: lastPersisted }',
  },
  {
    id: 'P5',
    file: PLAN,
    what: 'trust the last array entry instead of the maximum persisted move',
    from: '    if (moveNumber > lastPersisted) lastPersisted = moveNumber',
    to: '    lastPersisted = moveNumber',
  },
  {
    id: 'P6',
    file: PLAN,
    what: 'skip pending games instead of done ones (finished work repeats forever)',
    from: "    if (game.ledgerStatus === 'done') continue",
    to: "    if (game.ledgerStatus === 'pending') continue",
  },
  {
    id: 'P7',
    file: PLAN,
    what: 'invert the mine filter (the run analyses everyone else’s games)',
    from: "    if (scope === 'mine' && !isMyGame(game, playerNames, game.override)) continue",
    to: "    if (scope === 'mine' && isMyGame(game, playerNames, game.override)) continue",
  },
  {
    id: 'P8',
    file: PLAN,
    what: 'apply the mine filter under the "all" scope too',
    from: "    if (scope === 'mine' && !isMyGame(game, playerNames, game.override)) continue",
    to: '    if (!isMyGame(game, playerNames, game.override)) continue',
  },
  {
    id: 'P9',
    file: PLAN,
    what: 'take candidates positionally instead of by the engine rank',
    from: '  const ordered = [...result.candidates].sort((a, b) => a.order - b.order)',
    to: '  const ordered = [...result.candidates]',
  },
  {
    id: 'P10',
    file: PLAN,
    what: 'spell a pass candidate as a board point',
    from: "    coord: best.coord === null ? 'pass' : toGtp(best.coord, boardSize),",
    to: "    coord: best.coord === null ? 'A0' : toGtp(best.coord, boardSize),",
  },
  {
    id: 'P11',
    file: PLAN,
    what: 'number rows off by one against the position index',
    from: '    moveNumber: result.moveNumber,',
    to: '    moveNumber: result.moveNumber + 1,',
  },
  {
    id: 'P12',
    file: PLAN,
    what: 'double the mid-game checkpoint bound',
    from: 'export const BATCH_CHUNK_SIZE = 25',
    to: 'export const BATCH_CHUNK_SIZE = 26',
  },
  // --- session.ts: the batch tier's query contract -------------------------
  {
    id: 'B1',
    file: SESSION,
    what: 'drop the move clamp (a negative atMove slices from the end of the game)',
    from: BATCH_CLAMP,
    to: BATCH_FN + '\n  const moveNumber = Math.trunc(atMove)',
  },
  {
    id: 'B2',
    file: SESSION,
    what: 'let the builder invent the query id instead of using the caller’s',
    from: BATCH_ID,
    to: BATCH_CLAMP + "\n  return {\n    id: 'batch:0',",
  },
  {
    id: 'B3',
    file: SESSION,
    what: 'run batch queries at the agent cap (the tier spends the latency budget)',
    from: BATCH_OBJ + '\n    maxVisits: SWEEP_MAX_VISITS,',
    to: BATCH_OBJ + '\n    maxVisits: AGENT_QUERY_VISITS,',
  },
  {
    id: 'B4',
    file: SESSION,
    what: 'ask the engine for ownership the batch rows never read',
    from:
      BATCH_OBJ + '\n    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: false,',
    to: BATCH_OBJ + '\n    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: true,',
  },
  {
    id: 'B5',
    file: SESSION,
    what: 'subscribe batch queries to streaming reports (partials nobody reads)',
    from:
      BATCH_OBJ +
      '\n    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: false,\n  }',
    to:
      BATCH_OBJ +
      '\n    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: false,\n    reportDuringSearchEvery: 0.1,\n  }',
  },
  {
    id: 'B6',
    file: SESSION,
    what: 'drop the black setup stones (a handicap position is analysed wrong)',
    from: BATCH_FIELDS + BATCH_BLACK,
    to: BATCH_FIELDS,
  },
  // --- batch.ts: the ledger-driven driver -----------------------------------
  {
    id: 'D1',
    file: BATCH,
    what: 'pause on a ready engine even with no focus session (the run never resumes)',
    from: "      if (options.engine.isFocusActive() && options.engine.info().status === 'ready') {",
    to: "      if (options.engine.info().status === 'ready') {",
  },
  {
    id: 'D2',
    file: BATCH,
    what: 'break out of the yield loop and issue queries into a held focus session',
    from: '        await sleep(YIELD_POLL_MS)\n        continue',
    to: '        await sleep(YIELD_POLL_MS)\n        break',
  },
  {
    id: 'D3',
    file: BATCH,
    what: 'let the wave overrun the move count (an extra clamped query per tail wave)',
    from: '      const waveEnd = Math.min(position + window - 1, moveCount)',
    to: '      const waveEnd = position + window',
  },
  {
    id: 'D4',
    file: BATCH,
    what: 'shrink the wave by one (the concurrency share is not what the thread model says)',
    from: '      const waveEnd = Math.min(position + window - 1, moveCount)',
    to: '      const waveEnd = Math.min(position + window - 2, moveCount)',
  },
  {
    id: 'D5',
    file: BATCH,
    what: 'flush the chunk one row late (a crash re-analyses the row past the threshold)',
    from: '      if (pendingRows.length >= chunkSize) {',
    to: '      if (pendingRows.length > chunkSize) {',
  },
  {
    id: 'D6',
    file: BATCH,
    what: 'checkpoint nothing (the mid-game flush writes an empty chunk)',
    from: '        repository.commitChunk(game.id, pendingRows)',
    to: '        repository.commitChunk(game.id, [])',
  },
  {
    id: 'D7',
    file: BATCH,
    what: 'persist the empty-board row too (row 0 has no loss seed and breaks the recurrence)',
    from: '        if (at === 0) {',
    to: '        if (false) {',
  },
  {
    id: 'D8',
    file: BATCH,
    what: 'skip the final commit (rows and ledger flip never happen)',
    from: "    repository.markDone(game.id, pendingRows, now())\n    return 'done'",
    to: "    return 'done'",
  },
  {
    id: 'D9',
    file: BATCH,
    what: 'split the final commit (rows without the ledger flip — done no longer implies rows)',
    from: '    repository.markDone(game.id, pendingRows, now())',
    to: '    repository.commitChunk(game.id, pendingRows)',
  },
  {
    id: 'D10',
    file: BATCH,
    what: 'record our own cancel as the game’s failure',
    from: "          if (run.controller.signal.aborted) return 'interrupted'",
    to: "          if (run.controller.signal.aborted) return 'failed'",
  },
  {
    id: 'D11',
    file: BATCH,
    what: 'mark the game failed when the engine died (a dead engine is the run’s problem)',
    from: "          if (options.engine.info().status !== 'ready') throw engineLostError()",
    to: "          if (options.engine.info().status !== 'ready') {\n            repository.markFailed(game.id, now())\n            return 'failed'\n          }",
  },
  {
    id: 'D12',
    file: BATCH,
    what: 'abort the whole run on a live-engine query error (one bad position kills the queue)',
    from: "          repository.markFailed(game.id, now())\n          return 'failed'",
    to: '          throw engineLostError()',
  },
  {
    id: 'D13',
    file: BATCH,
    what: 'seed the resumed loss from one row early',
    from: '        : repository.winrateAt(game.id, plan.resumeFromMove)',
    to: '        : repository.winrateAt(game.id, plan.resumeFromMove - 1)',
  },
  {
    id: 'D14',
    file: BATCH,
    what: 'admit a second start (two runs own one engine and one ledger)',
    from: '      if (active !== null) {\n        throw new AppError(',
    to: '      if (active === null) {\n        throw new AppError(',
  },
  {
    id: 'D15',
    file: BATCH,
    what: 'count a game deleted mid-run as a failure',
    from: "counting it done', {\n            gameId,\n          })\n          run.done += 1",
    to: "counting it done', {\n            gameId,\n          })\n          run.failed += 1",
  },
  {
    id: 'D16',
    file: BATCH,
    what: 'drop the batch query-id namespace (ids collide with the agent tier)',
    from: '  return `${BATCH_QUERY_PREFIX}${String(counter)}`',
    to: '  return `${String(counter)}`',
  },
  {
    id: 'D17',
    file: BATCH,
    what: 'route batch queries as agent tier',
    from: "            tier: 'batch',",
    to: "            tier: 'agent',",
  },
  {
    id: 'D18',
    file: BATCH,
    what: 'report a cancelled run as done',
    from: "        ? { status: 'cancelled', total: run.total, done: run.done, failed: run.failed }",
    to: "        ? { status: 'done', total: run.total, done: run.done, failed: run.failed }",
  },
  {
    id: 'D19',
    file: BATCH,
    what: 'mark queued games failed at queue time (the ledger lies before analysis)',
    from: '      for (const gameId of queue) repository.markPending(gameId, now())',
    to: '      for (const gameId of queue) repository.markFailed(gameId, now())',
  },
  {
    id: 'D20',
    file: BATCH,
    what: 'count a finished game twice (the run arithmetic exceeds the queue)',
    from: "        if (outcome === 'done') run.done += 1\n        else run.failed += 1",
    to: "        if (outcome === 'done') run.done += 2\n        else run.failed += 1",
  },
  {
    id: 'D21',
    file: BATCH,
    what: 'count a failed game twice (the run arithmetic exceeds the queue)',
    from: "        if (outcome === 'done') run.done += 1\n        else run.failed += 1",
    to: "        if (outcome === 'done') run.done += 1\n        else run.failed += 2",
  },
  {
    id: 'D22',
    file: BATCH,
    what: 'commit rows for a record the library no longer holds (a delete or re-import landed mid-wave)',
    from: '      if (current?.game.contentHash !== game.contentHash) {',
    to: '      if (current?.game.contentHash === game.contentHash) {',
  },
  {
    id: 'D23',
    file: BATCH,
    what: 'ignore a mid-flight re-import (stale rows are committed and the game is marked done over them)',
    from: '      if (current?.game.contentHash !== game.contentHash) {',
    to: '      if (current === undefined) {',
  },
]

interface SuiteResult {
  total: number
  failed: number
  ok: boolean
}

function runSuite(): SuiteResult {
  let output: string
  let ok: boolean
  try {
    output = execFileSync(
      'pnpm',
      [
        'vitest',
        'run',
        '--project',
        'desktop',
        'test/unit/batch-plan',
        'test/unit/mine',
        'test/unit/katago/katago-session',
        'test/integration/batch',
        '--reporter',
        'basic',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      },
    )
    ok = true
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string }
    output = (shaped.stdout ?? '') + (shaped.stderr ?? '')
    ok = false
  }
  const parsed = parse(output)
  return { total: parsed.total, failed: parsed.failed, ok }
}

function parse(output: string): { total: number; failed: number } {
  const clean = output.replace(ANSI, '')
  const totalMatch =
    /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)/.exec(
      clean,
    )
  if (totalMatch === null) {
    // No summary line at all means collection failed — a syntax error, not a
    // behavioural difference. Reported as total 0 so the gate marks it INVALID.
    return { total: 0, failed: 0 }
  }
  return {
    total: Number(totalMatch[4]),
    failed: Number(totalMatch[1] ?? 0),
  }
}

const baseline = runSuite()
console.log(
  `baseline: ${String(baseline.total)} tests, ${String(baseline.failed)} failed`,
)
// The gate: not green, or measuring nothing — either way every per-mutation
// verdict below would be fiction.
if (!baseline.ok || baseline.failed > 0 || baseline.total <= 0) {
  console.log('BASELINE IS NOT GREEN — aborting, every result would be meaningless')
  process.exit(1)
}

const results: string[] = []
for (const mutation of MUTATIONS) {
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  const occurrences = original.split(mutation.from).length - 1
  if (occurrences !== 1) {
    results.push(
      `${mutation.id}  ANCHOR NOT UNIQUE (${String(occurrences)} matches)  ${mutation.what}`,
    )
    continue
  }

  writeFileSync(path, original.replace(mutation.from, mutation.to), 'utf8')
  try {
    const result = runSuite()
    if (result.total !== baseline.total) {
      // The gate. A mutation that changes the test count broke collection.
      results.push(
        `${mutation.id}  INVALID (${String(result.total)} tests vs ${String(baseline.total)})  ${mutation.what}`,
      )
    } else if (result.failed > 0) {
      results.push(
        `${mutation.id}  caught (${String(result.failed)} failed)  ${mutation.what}`,
      )
    } else {
      results.push(`${mutation.id}  *** ESCAPED ***  ${mutation.what}`)
    }
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  console.log(results[results.length - 1])
}

console.log('\n===== SUMMARY =====')
for (const line of results) console.log(line)
const escaped = results.filter((line) => line.includes('ESCAPED')).length
const invalid = results.filter(
  (line) => line.includes('INVALID') || line.includes('ANCHOR'),
).length
console.log(
  `\n${String(results.length - escaped - invalid)}/${String(results.length)} caught, ${String(escaped)} escaped, ${String(invalid)} invalid`,
)
// An anchor that matched ≠1 site is drift in this harness, not a neutral
// result, and an escaped mutant is the finding the whole run exists for. Either
// fails the gate: the exit code is what CI and the stage checklist consume.
if (escaped > 0 || invalid > 0) {
  console.log('MUTATION GATE FAILED — an instrument reporting itself is not green.')
  process.exit(1)
}
