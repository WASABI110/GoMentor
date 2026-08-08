/**
 * Mutation harness for the katago protocol layer.
 *
 * A passing suite proves the code does not crash. It does not prove the
 * assertions are load-bearing. This deliberately breaks each decision the layer
 * makes and requires the suite to notice.
 *
 * The validity gate is the important part: if the mutated run's total test count
 * differs from the baseline, the mutation broke collection rather than behaviour,
 * and the result is reported as INVALID — never as "caught". A syntax error that
 * takes the whole file down would otherwise read as a perfect score.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

interface Mutation {
  readonly id: string
  readonly file: string
  readonly what: string
  readonly from: string
  readonly to: string
}

const MUTATIONS: Mutation[] = [
  // --- gtp.ts: sanitising -------------------------------------------------
  {
    id: 'M1',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'stop truncating at a comment',
    from: "    if (char === '#') break",
    to: "    if (char === '#') { /* mutated */ }",
  },
  {
    id: 'M2',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'drop the tab-to-space conversion, splicing two tokens into one',
    from: "    if (char === '\\t') {\n      out += ' '\n      continue\n    }",
    to: "    if (char === '\\t') {\n      continue\n    }",
  },
  // --- gtp.ts: encoding ---------------------------------------------------
  {
    id: 'M3',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'put the id after the command instead of before',
    from: '  const head = id === undefined ? command : `${String(id)} ${command}`',
    to: '  const head = id === undefined ? command : `${command} ${String(id)}`',
  },
  {
    id: 'M4',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'stop flattening embedded newlines, allowing command injection',
    from: "  const clean = sanitiseLine(line).replace(/\\n/g, ' ').trim()",
    to: '  const clean = sanitiseLine(line).trim()',
  },
  {
    id: 'M5',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'send komi as a bare integer',
    from: '  return encodeCommand(GTP_COMMANDS.komi, [komi.toFixed(1)], id)',
    to: '  return encodeCommand(GTP_COMMANDS.komi, [komi], id)',
  },
  {
    id: 'M6',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'swap colour and vertex in play',
    from: '  return encodeCommand(GTP_COMMANDS.play, [player, encodeMove(move, size)], id)',
    to: '  return encodeCommand(GTP_COMMANDS.play, [encodeMove(move, size), player], id)',
  },
  // --- gtp.ts: decoding ---------------------------------------------------
  {
    id: 'M7',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'let a CoordError escape decodeMove instead of returning null',
    from: "  try {\n    const coord = fromGtp(trimmed, size)\n    return coord === null ? null : { kind: 'play', coord }\n  } catch {\n    return null\n  }",
    to: "  const coord = fromGtp(trimmed, size)\n  return coord === null ? null : { kind: 'play', coord }",
  },
  {
    id: 'M8',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'treat resign as pass',
    from: "  if (trimmed === 'resign') return { kind: 'resign' }",
    to: "  if (trimmed === 'resign') return { kind: 'pass' }",
  },
  // --- gtp.ts: response framing ------------------------------------------
  {
    id: 'M9',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'split responses on a newline instead of a blank line',
    from: "    const end = normalised.indexOf('\\n\\n', start)",
    to: "    const end = normalised.indexOf('\\n', start)",
  },
  {
    id: 'M10',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'skip CRLF normalisation, so a Windows engine buffers forever',
    from: "  const normalised = buffer.replace(/\\r\\n/g, '\\n')\n  const blocks: string[] = []",
    to: '  const normalised = buffer\n  const blocks: string[] = []',
  },
  {
    id: 'M11',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'throw on a ? failure instead of returning it',
    from: '  const prefix = trimmed[0]\n  if (prefix !== GTP_SUCCESS_PREFIX && prefix !== GTP_FAILURE_PREFIX) {',
    to: '  const prefix = trimmed[0]\n  if (prefix !== GTP_SUCCESS_PREFIX) {',
  },
  {
    id: 'M12',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'put the whole block in the error context instead of the first 40 chars',
    from: '      context: { head: trimmed.slice(0, 40) },',
    to: '      context: { head: trimmed },',
  },
  {
    id: 'M13',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'ignore the echoed id',
    from: '  const id = idMatch === null ? null : Number(idMatch[1])',
    to: '  const id = null',
  },
  // --- gtp.ts: kata-analyze ----------------------------------------------
  {
    id: 'M14',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'keep an unparseable candidate as a pass instead of dropping it',
    from: '    if (parsed === null) {\n      current = null\n      return\n    }',
    to: '    if (parsed === null) {\n      /* mutated */\n    }',
  },
  {
    id: 'M15',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'substitute null for a garbled pv vertex instead of truncating',
    from: "    if (decoded === null || decoded.kind === 'resign') break\n    out.push(decoded.kind === 'play' ? decoded.coord : null)",
    to: "    out.push(decoded === null || decoded.kind !== 'play' ? null : decoded.coord)",
  },
  {
    id: 'M16',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'take only the first pv token, truncating every variation to depth 1',
    from: '  for (const vertex of values ?? []) {',
    to: '  for (const vertex of (values ?? []).slice(0, 1)) {',
  },
  {
    id: 'M17',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'return NaN rather than 0 for a non-numeric field',
    from: '  return Number.isFinite(parsed) ? parsed : 0',
    to: '  return parsed',
  },
  {
    id: 'M18',
    file: 'packages/core/src/katago/gtp.ts',
    what: 'let a value token overwrite the key it belongs to',
    from: '    if (KNOWN_ANALYZE_KEYS.has(token)) {\n      key = token\n      current[key] = []\n      continue\n    }',
    to: '    if (true) {\n      key = token\n      current[key] = []\n      continue\n    }',
  },
  // --- analysis.ts: requests ---------------------------------------------
  {
    id: 'M19',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'send black/white instead of B/W',
    from: "  return player === 'black' ? 'B' : 'W'",
    to: "  return player === 'black' ? ('black' as 'B') : ('white' as 'W')",
  },
  {
    id: 'M20',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'drop a pass from the moves array, shifting turn parity',
    from: "    moves: query.moves.map((move) => [\n      colourToken(move.player),\n      move.coord === null ? 'pass' : vertex(move.coord, query.boardSize),\n    ]),",
    to: '    moves: query.moves\n      .filter((move) => move.coord !== null)\n      .map((move) => [colourToken(move.player), vertex(move.coord as Coord, query.boardSize)]),',
  },
  {
    id: 'M21',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'accept maxVisits of 0',
    from: '  if (query.maxVisits < 1) {',
    to: '  if (query.maxVisits < 0) {',
  },
  {
    id: 'M22',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'let a CoordError escape without a domain code',
    from: '  try {\n    return toGtp(coord, size)\n  } catch {',
    to: '  try {\n    return toGtp(coord, size)\n  } catch (unused) {\n    void unused\n    if (true) throw new Error(String(unused))\n    // eslint-disable-next-line no-unreachable',
  },
  {
    id: 'M23',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'send includeOwnership even when false',
    from: '  if (query.includeOwnership === true) request.includeOwnership = true',
    to: '  request.includeOwnership = query.includeOwnership === true',
  },
  // --- analysis.ts: framing ---------------------------------------------
  {
    id: 'M24',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'treat a half-received JSON line as complete',
    from: "  const remainder = parts.pop() ?? ''",
    to: "  const remainder = ''",
  },
  // --- analysis.ts: responses -------------------------------------------
  {
    id: 'M25',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'default a missing winrate to 0.5, fabricating an even game',
    from: '  const winrate = rootWinrate ?? candidates[0]?.winrate ?? null\n  if (winrate === null) {',
    to: '  const winrate = rootWinrate ?? candidates[0]?.winrate ?? 0.5\n  if (false) {',
  },
  {
    id: 'M26',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'forward the engine-controlled error string into our envelope',
    from: "      'the engine reported an error for this query',",
    to: '      response.error,',
  },
  {
    id: 'M27',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'echo the malformed line in the parse-failure context',
    from: '      context: { length: line.length },',
    to: '      context: { line },',
  },
  {
    id: 'M28',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'pad a wrong-length ownership array instead of rejecting it',
    from: '  if (value.length !== expected) {',
    to: '  if (false) {',
  },
  {
    id: 'M29',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'treat a streaming partial as a final result',
    from: '    complete: response.isDuringSearch !== true,',
    to: '    complete: true,',
  },
  {
    id: 'M30',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'read gameId from the wire instead of the caller',
    from: '    gameId: context.gameId,',
    to: '    gameId: stringOr(response.gameId, context.gameId),',
  },
  {
    id: 'M31',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'coerce a non-string id to the text "undefined"',
    from: "  return typeof value === 'string' ? value : fallback",
    to: '  return String(value)',
  },
  {
    id: 'M32',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'keep a fractional visit count, failing the int schema downstream',
    from: '    visits: Math.max(0, Math.trunc(finiteOr(rootInfo?.visits, null) ?? 0)),',
    to: '    visits: Math.max(0, finiteOr(rootInfo?.visits, null) ?? 0),',
  },
  {
    id: 'M33',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'stop clamping the root winrate into 0..1',
    from: '    winrate: clamp01(winrate),\n    scoreLead: finiteOr(rootInfo?.scoreLead, null)',
    to: '    winrate: winrate,\n    scoreLead: finiteOr(rootInfo?.scoreLead, null)',
  },
  {
    id: 'M33b',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'stop clamping a candidate winrate into 0..1',
    from: '    winrate: clamp01(winrate),\n    scoreLead: finiteOr(info.scoreLead, null)',
    to: '    winrate: winrate,\n    scoreLead: finiteOr(info.scoreLead, null)',
  },
  {
    id: 'M34',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'accept a warning with no analysis as a valid result',
    from: "  if (typeof response.warning === 'string' && response.moveInfos === undefined) {",
    to: '  if (false) {',
  },
  {
    id: 'M35',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'prefer the best candidate over rootInfo for the winrate',
    from: '  const winrate = rootWinrate ?? candidates[0]?.winrate ?? null',
    to: '  const winrate = candidates[0]?.winrate ?? rootWinrate ?? null',
  },
  {
    id: 'M36',
    file: 'packages/core/src/katago/analysis.ts',
    what: 'collapse pass and unparseable to the same value in a candidate vertex',
    from: '  const coord = tryFromGtp(move, size)\n  if (coord === undefined) return null',
    to: '  const coord = tryFromGtp(move, size) ?? null',
  },
]

function run(): { total: number; failed: number; ok: boolean } {
  try {
    const out = execFileSync(
      'pnpm',
      ['vitest', 'run', '--project', 'core', 'test/katago', '--reporter', 'basic'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true },
    )
    return parse(out, true)
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string }
    return parse((shaped.stdout ?? '') + (shaped.stderr ?? ''), false)
  }
}

function parse(
  output: string,
  ok: boolean,
): { total: number; failed: number; ok: boolean } {
  const clean = output.replace(ANSI, '')
  const totalMatch =
    /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)/.exec(
      clean,
    )
  if (totalMatch === null) {
    // No summary line at all means collection failed — a syntax error, not a
    // behavioural difference. Reported as total 0 so the gate marks it INVALID.
    return { total: 0, failed: 0, ok }
  }
  return {
    total: Number(totalMatch[4]),
    failed: Number(totalMatch[1] ?? 0),
    ok,
  }
}

const baseline = run()
console.log(
  `baseline: ${String(baseline.total)} tests, ${String(baseline.failed)} failed`,
)
if (!baseline.ok || baseline.failed > 0) {
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
    const result = run()
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
