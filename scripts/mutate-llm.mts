/**
 * Mutation harness for the M3 LLM agent layer — Stage 1's tool registry, the
 * agent tier's pure query construction, and Stage 2's agent-loop pure core.
 *
 * A passing suite proves the code does not crash. It does not prove the
 * assertions are load-bearing. This deliberately breaks each decision the layer
 * makes and requires the suite to notice.
 *
 * Same validity gate as the katago harness, including the two guards that have
 * both fired on real mistakes: a baseline that is not green aborts the whole
 * run (every result would be meaningless), and a baseline reporting zero tests
 * aborts too — an instrument that measured nothing reports `0 escaped`, which
 * is the most reassuring possible output from a harness covering nothing. A
 * mutated run whose test total differs from baseline broke collection rather
 * than behaviour, and is reported INVALID rather than counted as caught.
 *
 * The exit code is the gate, not the summary. An escaped mutant or an invalid
 * anchor exits non-zero: a report that only a human reading the output would
 * act on is not a gate, and exit 0 under `*** ESCAPED ***` lines is exactly the
 * green-that-isn't this harness exists to prevent.
 *
 * One run covers both suites the mutants live in: the tool registry's and the
 * loop core's unit tests (`apps/desktop/test/unit/llm`) and the katago
 * session's pure builders (`apps/desktop/test/unit/katago`, where
 * `buildAgentQuery` and its visit budget are tested next to their focus/sweep
 * siblings). A single vitest invocation with two path filters halves the spawns
 * and the total is still comparable across baseline and mutants, which is all
 * the gate needs. Filters are relative to the *project* root, not the repo
 * root — the exact mistake the baseline gate exists to catch, since a filter
 * that matches nothing exits 0.
 *
 * Deliberately not covered here: the loop's stream plumbing
 * (`runAgentLoop`/`consumeTurn`) and `service.ts`'s wiring. Their correctness
 * is a property of a live stream — chunk interleaving, cancellation mid-turn,
 * event fan-out — and the integration suite
 * (`test/integration/llm-agent.test.ts`) asserts it against a scripted
 * provider, which is far too slow to run per mutant. The service layer is
 * excluded from the katago harness for the same reason.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const TOOLS = 'apps/desktop/src/main/llm/agent/tools.ts'
const RUNNER = 'apps/desktop/src/main/llm/agent/runner.ts'
const SESSION = 'apps/desktop/src/main/katago/session.ts'

interface Mutation {
  readonly id: string
  readonly file: string
  readonly what: string
  readonly from: string
  readonly to: string
}

const MUTATIONS: Mutation[] = [
  // --- matchesField: what a substring match means -------------------------
  {
    id: 'L1',
    file: TOOLS,
    what: 'match case-sensitively (drop the needle normalisation)',
    from: '  return value?.toLowerCase().includes(needle.toLowerCase()) === true',
    to: '  return value?.toLowerCase().includes(needle) === true',
  },
  {
    id: 'L2',
    file: TOOLS,
    what: 'let a criterion match a record whose field is absent',
    from: '  return value?.toLowerCase().includes(needle.toLowerCase()) === true',
    to: '  return true',
  },
  // --- filterGames: the search contract ----------------------------------
  {
    id: 'L3',
    file: TOOLS,
    what: 'match a player against black only (people search names, not colours)',
    from: '      const playerMatched =\n        matchesField(summary.blackName, player) ||\n        matchesField(summary.whiteName, player)',
    to: '      const playerMatched = matchesField(summary.blackName, player)',
  },
  {
    id: 'L4',
    file: TOOLS,
    what: 'invert the event criterion (matches are rejected, non-matches kept)',
    from: '    if (event !== undefined && !matchesField(summary.event, event)) return false',
    to: '    if (event !== undefined && matchesField(summary.event, event)) return false',
  },
  {
    id: 'L5',
    file: TOOLS,
    what: 'drop the date criterion entirely',
    from: '    if (date !== undefined && !matchesField(summary.date, date)) return false',
    to: '    if (date !== undefined && false) return false',
  },
  {
    id: 'L6',
    file: TOOLS,
    what: 'report the capped count as the match count (the model loses the truncation signal)',
    from: '  return { matched: matching.length, results: matching.slice(0, limit) }',
    to: '  return {\n    matched: matching.slice(0, limit).length,\n    results: matching.slice(0, limit),\n  }',
  },
  {
    id: 'L7',
    file: TOOLS,
    what: 'return nothing when no criteria were given ("what is in the library")',
    from: '  return { matched: matching.length, results: matching.slice(0, limit) }',
    to: '  return { matched: matching.length, results: matching.slice(0, 0) }',
  },
  {
    id: 'L8',
    file: TOOLS,
    what: 'double the result cap',
    from: '  limit: number = SEARCH_RESULT_LIMIT,',
    to: '  limit: number = SEARCH_RESULT_LIMIT * 2,',
  },
  // --- checkMoveNumber: the record bound ---------------------------------
  {
    id: 'L9',
    file: TOOLS,
    what: 'make the upper bound exclusive (the position after the last move becomes unaskable)',
    from: '    moveNumber > game.moves.length',
    to: '    moveNumber >= game.moves.length',
  },
  {
    id: 'L10',
    file: TOOLS,
    what: 'accept negative move numbers',
    from: '    moveNumber < 0 ||',
    to: '    false ||',
  },
  // --- positionAt: the position summary ---------------------------------
  {
    id: 'L11',
    file: TOOLS,
    what: 'report the move *after* the cursor as the move at hand',
    from: '  const at = game.moves[moveNumber - 1]',
    to: '  const at = game.moves[moveNumber]',
  },
  {
    id: 'L12',
    file: TOOLS,
    what: 'unclamp the recent-move window (a negative slice start empties it)',
    from: '  const recentStart = Math.max(0, moveNumber - RECENT_MOVE_LIMIT)',
    to: '  const recentStart = moveNumber - RECENT_MOVE_LIMIT',
  },
  {
    id: 'L13',
    file: TOOLS,
    what: 'number recent moves from zero, off by one against the record',
    from: '      number: recentStart + index + 1,',
    to: '      number: recentStart + index,',
  },
  {
    id: 'L14',
    file: TOOLS,
    what: 'stop counting black setup stones (a handicap disappears from the summary)',
    from: '      black: game.setup.black.length,',
    to: '      black: 0,',
  },
  // --- summariseAnalysis: what the teacher may quote ----------------------
  {
    id: 'L15',
    file: TOOLS,
    what: 'cap candidates at one (the alternatives the teacher could discuss vanish)',
    from: 'export const TOP_CANDIDATE_LIMIT = 3',
    to: 'export const TOP_CANDIDATE_LIMIT = 1',
  },
  {
    id: 'L16',
    file: TOOLS,
    what: 'cap pv at one ply',
    from: 'export const PV_LIMIT = 6',
    to: 'export const PV_LIMIT = 1',
  },
  {
    id: 'L17',
    file: TOOLS,
    what: 'take candidates positionally instead of by the engine rank',
    from: '  const ordered = [...result.candidates].sort((a, b) => a.order - b.order)',
    to: '  const ordered = [...result.candidates]',
  },
  {
    id: 'L18',
    file: TOOLS,
    what: 'return every candidate (unbounded payload to the model)',
    from: '    candidates: ordered.slice(0, TOP_CANDIDATE_LIMIT).map((candidate) => ({',
    to: '    candidates: ordered.map((candidate) => ({',
  },
  {
    id: 'L19',
    file: TOOLS,
    what: 'return every pv ply (unbounded payload to the model)',
    from: '      pv: candidate.pv\n        .slice(0, PV_LIMIT)\n        .map((coord) => describeCoord(coord, boardSize)),',
    to: '      pv: candidate.pv.map((coord) => describeCoord(coord, boardSize)),',
  },
  {
    id: 'L20',
    file: TOOLS,
    what: 'spell GTP coordinates on a hardcoded 19×19 board (wrong point on 9×9)',
    from: "  return coord === null ? 'pass' : toGtp(coord, boardSize)",
    to: "  return coord === null ? 'pass' : toGtp(coord, 19 as BoardSize)",
  },
  {
    id: 'L21',
    file: TOOLS,
    what: 'spell a pass as a board point (the model teaches a stone that was not played)',
    from: "  return coord === null ? 'pass' : toGtp(coord, boardSize)",
    to: '  return toGtp(coord ?? { x: 0, y: 0 }, boardSize)',
  },
  {
    id: 'L22',
    file: TOOLS,
    what: 'skip the ownership rounding (a fractional "net points" value)',
    from: '          ownershipNetPoints: Math.round(\n            result.ownership.reduce((total, value) => total + value, 0),\n          ),',
    to: '          ownershipNetPoints: result.ownership.reduce(\n            (total, value) => total + value,\n            0,\n          ),',
  },
  // --- dispatchTool: the registry contract -------------------------------
  {
    id: 'L23',
    file: TOOLS,
    what: 'report an unknown tool as a success (the model trusts a tool that did not run)',
    from: "        `IPC_INVALID_REQUEST: unknown tool ${bound(name)} — available tools: ` +\n        AGENT_TOOLS.map((candidate) => candidate.name).join(', '),\n      isError: true,",
    to: "        `IPC_INVALID_REQUEST: unknown tool ${bound(name)} — available tools: ` +\n        AGENT_TOOLS.map((candidate) => candidate.name).join(', '),\n      isError: false,",
  },
  {
    id: 'L24',
    file: TOOLS,
    what: 'answer a cancelled run with a tool result (the loop re-enters the provider on a dead signal)',
    from: "  if (signal.aborted) {\n    throw new AppError('LLM_ABORTED', 'the run was cancelled before the tool ran')\n  }",
    to: "  if (false) {\n    throw new AppError('LLM_ABORTED', 'the run was cancelled before the tool ran')\n  }",
  },
  // --- session.ts: the agent tier's query contract ------------------------
  {
    id: 'L25',
    file: SESSION,
    what: "run agent queries at the focus cap (the tier spends the user's latency budget)",
    from: 'export const AGENT_QUERY_VISITS = 128',
    to: 'export const AGENT_QUERY_VISITS = 500',
  },
  {
    id: 'L26',
    file: SESSION,
    what: 'stop asking the engine for ownership (the teacher cannot summarise territory)',
    from: '    maxVisits: AGENT_QUERY_VISITS,\n    includeOwnership: true,\n  }',
    to: '    maxVisits: AGENT_QUERY_VISITS,\n    includeOwnership: false,\n  }',
  },
  {
    id: 'L27',
    file: SESSION,
    what: 'subscribe agent queries to streaming reports (partials nobody reads)',
    from: '    maxVisits: AGENT_QUERY_VISITS,\n    includeOwnership: true,\n  }',
    to: '    maxVisits: AGENT_QUERY_VISITS,\n    includeOwnership: true,\n    reportDuringSearchEvery: 0.1,\n  }',
  },
  {
    id: 'L28',
    file: SESSION,
    what: "let the builder invent the query id instead of using the caller's",
    from: 'export function buildAgentQuery(\n  id: string,\n  game: EngineGame,\n  atMove: number,\n): AnalysisQuery {\n  const moveNumber = Math.max(0, Math.min(Math.trunc(atMove), game.moves.length))\n  return {\n    id,',
    to: "export function buildAgentQuery(\n  id: string,\n  game: EngineGame,\n  atMove: number,\n): AnalysisQuery {\n  const moveNumber = Math.max(0, Math.min(Math.trunc(atMove), game.moves.length))\n  return {\n    id: 'agent:0',",
  },
  // --- runner.ts: the agent loop's pure core (Stage 2) --------------------
  {
    id: 'R1',
    file: RUNNER,
    what: 'multiply the step budget tenfold (a runaway run stops costing little)',
    from: 'export const MAX_AGENT_STEPS = 8',
    to: 'export const MAX_AGENT_STEPS = 80',
  },
  {
    id: 'R2',
    file: RUNNER,
    what: 'make the cap exclusive (an eighth tool turn buys a ninth provider call)',
    from: '  return completedSteps >= MAX_AGENT_STEPS',
    to: '  return completedSteps > MAX_AGENT_STEPS',
  },
  {
    id: 'R3',
    file: RUNNER,
    what: 'read null (never probed) as tool support (degrade becomes a guess)',
    from: '  return capability === true',
    to: '  return capability !== false',
  },
  {
    id: 'R4',
    file: RUNNER,
    what: 'accept any JSON value as arguments (an array becomes {"0":...})',
    from: "  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {",
    to: "  if (typeof parsed !== 'object' || parsed === null) {",
  },
  {
    id: 'R5',
    file: RUNNER,
    what: 'let malformed JSON through as empty arguments (dispatch runs on nothing)',
    from: `    return { ok: false, reason: 'the arguments were not valid JSON' }`,
    to: '    return { ok: true, value: {} }',
  },
  {
    id: 'R6',
    file: RUNNER,
    what: 'drop isError from the assembled tool reply (the model cannot self-correct)',
    from: '      isError: entry.outcome.isError,',
    to: '      isError: false,',
  },
  {
    id: 'R7',
    file: RUNNER,
    what: 'misrecord the rejection reason (the loop dispatches on arguments that never parsed)',
    from: '      invalid.set(call.id, `IPC_INVALID_REQUEST: ${parsed.reason}`)',
    to: "      invalid.set('untracked', `IPC_INVALID_REQUEST: ${parsed.reason}`)",
  },
  {
    id: 'R8',
    file: RUNNER,
    what: 'revert the null-prototype args record (model-supplied __proto__ poisons the object again)',
    from: '  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>',
    to: '  const value: Record<string, unknown> = {} as Record<string, unknown>',
  },
  // --- tools.ts: the get_profile tool (M4 Stage 4) --------------------------
  {
    id: 'P1',
    file: TOOLS,
    what: 'drop get_profile from the registry (the teacher loses the profile and will not say so)',
    from: '  searchLibraryTool,\n  getProfileTool,\n]',
    to: '  searchLibraryTool,\n]',
  },
  {
    id: 'P2',
    file: TOOLS,
    what: 'fabricate an empty profile instead of returning the derivation',
    from: '    return { content: JSON.stringify(ctx.profile()), isError: false }',
    to: '    return {\n      content: JSON.stringify({ weaknesses: [], myGames: 0, analysedMyGames: 0 }),\n      isError: false,\n    }',
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
        'test/unit/llm',
        'test/unit/katago',
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
