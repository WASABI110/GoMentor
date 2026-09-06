/**
 * Mutation harness for the katago protocol layer and the M2 lifecycle's pure
 * modules.
 *
 * A passing suite proves the code does not crash. It does not prove the
 * assertions are load-bearing. This deliberately breaks each decision the layer
 * makes and requires the suite to notice.
 *
 * The validity gate is the important part: if the mutated run's total test count
 * differs from the baseline, the mutation broke collection rather than behaviour,
 * and the result is reported as INVALID — never as "caught". A syntax error that
 * takes the whole file down would otherwise read as a perfect score.
 *
 * Two suites run per mutation: the protocol layer (`packages/core/test/katago`)
 * and the M2 lifecycle's pure decision modules (`apps/desktop/test/unit/katago`
 * and the `katago-*` unit files — config builder, locate policy and launch
 * planning, stderr ring buffer, status state machine, tick coalescer,
 * perspective adapter, analysis session, sweep ledger). A third run covers
 * the SGF adapter's branch projection (`apps/desktop/test/unit/sgf-adapter`),
 * whose mutants (line following, option indexing, density) the katago suites
 * never load. The totals are summed; a mutation that changes any count
 * invalidates the run.
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
  // --- config.ts: the perspective pin and flowed-through params ------------
  {
    id: 'M37',
    file: 'apps/desktop/src/main/katago/config.ts',
    what: 'unpin the winrate perspective (SIDETOMOVE -> BLACK)',
    from: "    'reportAnalysisWinratesAs = SIDETOMOVE',",
    to: "    'reportAnalysisWinratesAs = BLACK',",
  },
  {
    id: 'M38',
    file: 'apps/desktop/src/main/katago/config.ts',
    what: 'stop flowing the thread split from settings (pin sweep positions to 8)',
    from: '    `numAnalysisThreads = ${String(split.positions)}`,',
    to: '    `numAnalysisThreads = 8`,',
  },
  {
    id: 'M39',
    file: 'apps/desktop/src/main/katago/config.ts',
    what: 'drop the batch size line entirely',
    from: '    `nnMaxBatchSize = ${String(NN_MAX_BATCH_SIZE)}`,\n',
    to: '',
  },
  {
    id: 'M40',
    file: 'apps/desktop/src/main/katago/config.ts',
    what: 'stop flowing the default visit cap from settings',
    from: '    `maxVisits = ${String(params.maxVisits)}`,',
    to: '    `maxVisits = 500`,',
  },
  // --- locate.ts: override precedence, target mapping, network selection ---
  {
    id: 'M41',
    file: 'apps/desktop/src/main/katago/locate.ts',
    what: 'ignore the env override and always use the bundled binary',
    from: "  if (input.envOverride !== undefined && input.envOverride !== '') {",
    to: '  if (false) {',
  },
  {
    id: 'M42',
    file: 'apps/desktop/src/main/katago/locate.ts',
    what: 'un-map the win32 target (report no Windows engine)',
    from: "  if (platform === 'win32') return 'win32-x64'",
    to: "  if (platform === 'win32') return null",
  },
  {
    id: 'M43',
    file: 'apps/desktop/src/main/katago/locate.ts',
    what: 'pick the first net even when the directory holds several',
    from: '  return matches.length === 1 ? (matches[0] ?? null) : null',
    to: '  return matches[0] ?? null',
  },
  {
    id: 'M44',
    file: 'apps/desktop/src/main/katago/locate.ts',
    what: 'report dev mode even in a packaged build',
    from: "  const defaultMode: LocateMode = input.isPackaged ? 'packaged' : 'dev'",
    to: "  const defaultMode: LocateMode = 'dev'",
  },
  // --- ring-buffer.ts: the bound and the drop order -------------------------
  {
    id: 'M45',
    file: 'apps/desktop/src/main/katago/ring-buffer.ts',
    what: 'remove the capacity bound (unbounded growth)',
    from: '      if (lines.length > capacity) {',
    to: '      if (false) {',
  },
  {
    id: 'M46',
    file: 'apps/desktop/src/main/katago/ring-buffer.ts',
    what: 'drop the NEWEST lines instead of the oldest',
    from: '        lines = lines.slice(lines.length - capacity)',
    to: '        lines = lines.slice(0, capacity)',
  },
  // --- state-machine.ts: guards on the transition table -------------------
  {
    id: 'M47',
    file: 'apps/desktop/src/main/katago/state-machine.ts',
    what: 'start-requested always restarts, breaking idempotence',
    from: "      return current === 'unavailable' || current === 'failed' ? 'starting' : current",
    to: "      return 'starting'",
  },
  {
    id: 'M48',
    file: 'apps/desktop/src/main/katago/state-machine.ts',
    what: 'probe-succeeded resurrects any phase to ready',
    from: "      return current === 'starting' ? 'ready' : current",
    to: "      return 'ready'",
  },
  {
    id: 'M49',
    file: 'apps/desktop/src/main/katago/state-machine.ts',
    what: 'crashed fails even from unavailable/failed',
    from: "      return current === 'starting' || current === 'ready' ? 'failed' : current",
    to: "      return 'failed'",
  },
  {
    id: 'M50',
    file: 'apps/desktop/src/main/katago/state-machine.ts',
    what: 'missing-in-dev reports failed instead of unavailable',
    from: "      return current === 'starting' ? 'unavailable' : current",
    to: "      return current === 'starting' ? 'failed' : current",
  },
  // --- coalesce.ts: latest-wins, the window boundary, the flush stamp --------
  {
    id: 'M51',
    file: 'apps/desktop/src/main/katago/coalesce.ts',
    what: 'queue behind a held tick instead of replacing it (not latest-wins)',
    from: '    state: { lastEmitAtMs: state.lastEmitAtMs, pending: { atMs, value } },',
    to: '    state: { lastEmitAtMs: state.lastEmitAtMs, pending: state.pending },',
  },
  {
    id: 'M52',
    file: 'apps/desktop/src/main/katago/coalesce.ts',
    what: 'hold a tick even exactly one interval after the last emission',
    from: 'state.lastEmitAtMs === null || atMs - state.lastEmitAtMs >= intervalMs',
    to: 'state.lastEmitAtMs === null || atMs - state.lastEmitAtMs > intervalMs',
  },
  {
    id: 'M53',
    file: 'apps/desktop/src/main/katago/coalesce.ts',
    what: 'stamp the flush with the hold moment, doubling the steady-state rate',
    from: '  return {\n    state: { lastEmitAtMs: atMs, pending: null },\n    emit: state.pending.value,\n  }',
    to: '  return {\n    state: { lastEmitAtMs: state.pending.atMs, pending: null },\n    emit: state.pending.value,\n  }',
  },
  {
    id: 'M54',
    file: 'apps/desktop/src/main/katago/coalesce.ts',
    what: 'leave the stale flush timer armed after an immediate emission',
    from: '        if (cancelTimer !== null) {\n          cancelTimer()\n          cancelTimer = null\n        }',
    to: '',
  },
  // --- perspective.ts: what flips, when, and what must never move ------------
  {
    id: 'M55',
    file: 'apps/desktop/src/main/katago/perspective.ts',
    what: 'flip winrate too (double-counting the side-to-move perspective)',
    from: '    scoreLead: -result.scoreLead,',
    to: '    winrate: 1 - result.winrate,\n    scoreLead: -result.scoreLead,',
  },
  {
    id: 'M56',
    file: 'apps/desktop/src/main/katago/perspective.ts',
    what: 'negate when BLACK is to move instead of White',
    from: "  if (playerToMove === 'black') {",
    to: "  if (playerToMove === 'white') {",
  },
  {
    id: 'M57',
    file: 'apps/desktop/src/main/katago/perspective.ts',
    what: 'negate the root scoreLead but not the candidates’',
    from: '    candidates: result.candidates.map((candidate) => ({\n      ...candidate,\n      scoreLead: -candidate.scoreLead,\n    })),',
    to: '    candidates: result.candidates,',
  },
  // --- session.ts: supersede, id correlation, terminated replies, adaptation --
  {
    id: 'M58',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'supersede without terminating the prior focus query',
    from: '    terminateCurrentFocus()\n    options.send(encodeAnalysisRequest(query))',
    to: '    options.send(encodeAnalysisRequest(query))',
  },
  {
    id: 'M59',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'issue the debounced cursor under a fresh id, breaking the eager-id contract',
    from: '        issueFocus(held.queryId, held.moveNumber)',
    to: '        issueFocus(nextFocusId(), held.moveNumber)',
  },
  {
    id: 'M61',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'skip the perspective adaptation on the emission path',
    from: '      const normalized = normalizeAnalysisResult(result, entry.player)\n      entry.coalescer.offer(normalized)',
    to: '      const normalized = result\n      entry.coalescer.offer(normalized)',
  },
  // --- locate.ts: the script-override discriminator --------------------------
  {
    id: 'M62',
    file: 'apps/desktop/src/main/katago/locate.ts',
    what: 'match the script-extension discriminator case-sensitively (.TS launches raw)',
    from: 'const SCRIPT_EXTENSIONS = /\\.(?:ts|mts|cts|mjs|cjs|js)$/i',
    to: 'const SCRIPT_EXTENSIONS = /\\.(?:ts|mts|cts|mjs|cjs|js)$/',
  },
  // --- sweep.ts: the ledger's ordering, skip sets, bounds, and wire identity ---
  {
    id: 'M63',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 'resume highest-first (the graph would fill from the end of the game)',
    from: '  for (let move = 0; move <= ledger.moveCount; move += 1) {',
    to: '  for (let move = ledger.moveCount; move >= 0; move -= 1) {',
  },
  {
    id: 'M64',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 're-issue failed moves forever (resume ignores the failed set)',
    from: '    if (!ledger.completed.has(move) && !ledger.failed.has(move)) return move',
    to: '    if (!ledger.completed.has(move)) return move',
  },
  {
    id: 'M65',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 'let markSweepComplete pollute the ledger with out-of-range moves',
    from: '  if (move >= 0 && move <= ledger.moveCount) ledger.completed.add(move)',
    to: '  ledger.completed.add(move)',
  },
  {
    id: 'M66',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 'let markSweepFailed pollute the ledger with out-of-range moves',
    from: '  if (move >= 0 && move <= ledger.moveCount) ledger.failed.add(move)',
    to: '  ledger.failed.add(move)',
  },
  {
    id: 'M67',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 'shift the sweep wire id off by one',
    from: '  return `${SWEEP_QUERY_PREFIX}${String(moveNumber)}`',
    to: '  return `${SWEEP_QUERY_PREFIX}${String(moveNumber + 1)}`',
  },
  {
    id: 'M68',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 'never sweep the position after the last move (off-by-one resume)',
    from: '  for (let move = 0; move <= ledger.moveCount; move += 1) {',
    to: '  for (let move = 0; move < ledger.moveCount; move += 1) {',
  },
  {
    id: 'M69',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 'raise the fixed sweep visit cap toward the focus default',
    from: 'export const SWEEP_MAX_VISITS = 100',
    to: 'export const SWEEP_MAX_VISITS = 500',
  },
  {
    id: 'M70',
    file: 'apps/desktop/src/main/katago/sweep.ts',
    what: 'halve the sweep concurrency window',
    from: 'export const SWEEP_CONCURRENCY = 8',
    to: 'export const SWEEP_CONCURRENCY = 4',
  },
  // --- session.ts: the sweep mechanics (concurrency, prefix, resume, tiers) ---
  {
    id: 'M71',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'ask the engine for ownership on sweep queries',
    from: '    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: false,',
    to: '    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: true,',
  },
  {
    id: 'M72',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'subscribe sweep queries to streaming reports',
    from: '    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: false,\n  }',
    to: '    maxVisits: SWEEP_MAX_VISITS,\n    includeOwnership: false,\n    reportDuringSearchEvery: 0.1,\n  }',
  },
  {
    id: 'M73',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'sweep at the focus visit cap instead of the fixed one',
    from: '    maxVisits: SWEEP_MAX_VISITS,',
    to: '    maxVisits: 500,',
  },
  {
    id: 'M74',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'emit partial sweep ticks instead of dropping them',
    from: "          log.debug('dropping partial sweep tick', { id: wireId })\n          return\n        }",
    to: "          log.debug('dropping partial sweep tick', { id: wireId })\n        }",
  },
  {
    id: 'M75',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 're-issue malformed sweep moves forever (skip the failed mark)',
    from: '            markSweepFailed(sweep.ledger, entry.moveNumber)\n',
    to: '',
  },
  {
    id: 'M76',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'never mark sweep completions (the ledger resume would redo finished work)',
    from: '        markSweepComplete(sweep.ledger, entry.moveNumber)\n',
    to: '',
  },
  {
    id: 'M77',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'issue sweep queries under the focus id prefix',
    from: '      const id = sweepQueryId(move)',
    to: '      const id = `${FOCUS_QUERY_PREFIX}${String(move)}`',
  },
  {
    id: 'M78',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'widen the sweep window past the concurrency bound',
    from: '      sweep.inFlight.size < SWEEP_CONCURRENCY &&',
    to: '      sweep.inFlight.size < SWEEP_CONCURRENCY + 5 &&',
  },
  {
    id: 'M79',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'keep the old sweep running across setGame',
    from: '    setGame(next, atMove) {\n      cancelHeldCursor()\n      stopSweep(true)\n',
    to: '    setGame(next, atMove) {\n      cancelHeldCursor()\n',
  },
  {
    id: 'M80',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'let a cursor move kill the sweep (the tiers must terminate independently)',
    from: '    setCursor(moveNumber) {\n      if (game === null) {',
    to: '    setCursor(moveNumber) {\n      stopSweep(true)\n      if (game === null) {',
  },
  {
    id: 'M81',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 're-issue failed moves within the pump window (drop the failed skip)',
    from: '      if (sweep.ledger.completed.has(move) || sweep.ledger.failed.has(move)) continue',
    to: '      if (sweep.ledger.completed.has(move)) continue',
  },
  {
    id: 'M82',
    file: 'apps/desktop/src/main/katago/session.ts',
    what: 'skip the perspective adaptation on sweep emissions',
    from: '        const normalized = normalizeAnalysisResult(result, entry.player)\n        options.onResult(normalized)',
    to: '        options.onResult(result)',
  },
  // --- adapter.ts: the branch projection (line following, options, density) ---
  {
    id: 'M83',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'consume a variationPath element at every multi-child node, not only at branch points with usable alternatives',
    from: '    if (branchAlternatives(node, boardSize).length >= 2) {',
    to: '    if (node.children.length >= 2) {',
  },
  {
    id: 'M84',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'default an unlisted branch choice to child 1 instead of the mainline',
    from: '      childIndex = chosen ?? 0',
    to: '      childIndex = chosen ?? 1',
  },
  {
    id: 'M85',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'accept an out-of-range variation path (truncated line instead of an error)',
    from: '      if (!Number.isInteger(childIndex) || childIndex >= node.children.length) {',
    to: '      if (false) {',
  },
  {
    id: 'M86',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'report branch options at the departure index instead of the arrival index',
    from: '    const index = applied + (hasMove ? 1 : 0)',
    to: '    const index = applied',
  },
  {
    id: 'M87',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'number branch options by display ordinal instead of SGF child index',
    from: '          index: offer.childIndex,',
    to: '          index: options.length,',
  },
  {
    id: 'M88',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'drop the branch option labels',
    from: '        const label = getComment(offer.child)',
    to: '        const label = undefined',
  },
  {
    id: 'M89',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'leave the branches array sparse (holes cross IPC as null)',
    from: '  for (let index = 0; index < branches.length; index += 1) {\n    branches[index] ??= []\n  }',
    to: '',
  },
  {
    id: 'M90',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'count a branch alternative twice',
    from: '      count += 1',
    to: '      count += 2',
  },
  {
    id: 'M91',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'always follow the first child (variationPath becomes a no-op)',
    from: '    const next = node.children[childIndex]',
    to: '    const next = node.children[0]',
  },
  {
    id: 'M92',
    file: 'apps/desktop/src/main/sgf/adapter.ts',
    what: 'ignore the variationPath entirely in toGame',
    from: '  const line = followLine(root, options.variationPath ?? [], meta.boardSize)',
    to: '  const line = followLine(root, [], meta.boardSize)',
  },
  // --- config.ts: added with the real-engine gate (v1.18 thread model) -----
  {
    id: 'M93',
    file: 'apps/desktop/src/main/katago/config.ts',
    what: 'starve the sweep tier (round the per-position share down, not up)',
    from: '  const threadsPerPosition = Math.max(1, Math.ceil(threads / 2))',
    to: '  const threadsPerPosition = Math.max(1, Math.floor(threads / 2))',
  },
  // --- backoff.ts: added at the final gate (its header claims this coverage)
  {
    id: 'M94',
    file: 'apps/desktop/src/main/katago/backoff.ts',
    what: 'never trip the circuit breaker (restart forever against a broken driver)',
    from: '  if (inWindow >= MAX_ATTEMPTS_PER_WINDOW) {',
    to: '  if (inWindow >= Number.MAX_SAFE_INTEGER) {',
  },
  {
    id: 'M95',
    file: 'apps/desktop/src/main/katago/backoff.ts',
    what: 'count expired attempts toward the breaker (the window never forgives)',
    from: '  const inWindow = attemptTimes.filter((at) => nowMs - at < RETRY_WINDOW_MS).length',
    to: '  const inWindow = attemptTimes.filter((at) => nowMs - at >= RETRY_WINDOW_MS).length',
  },
]

interface SuiteResult {
  total: number
  failed: number
  ok: boolean
}

function runSuite(project: string, filter: string): SuiteResult {
  let output: string
  let ok: boolean
  try {
    output = execFileSync(
      'pnpm',
      ['vitest', 'run', '--project', project, filter, '--reporter', 'basic'],
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

function run(): { total: number; failed: number; ok: boolean } {
  // Protocol layer + the M2 lifecycle's pure modules + the SGF branch
  // projection, summed. A mutation that breaks collection in any suite changes
  // the total and is INVALID.
  const core = runSuite('core', 'test/katago')
  const desktop = runSuite('desktop', 'test/unit/katago')
  // The branch-projection mutants (M83–M92) live in `main/sgf/adapter.ts`,
  // which the katago suites never load — without this third run they would
  // report "caught" against suites that never executed the mutated code.
  const adapter = runSuite('desktop', 'test/unit/sgf-adapter')
  return {
    total: core.total + desktop.total + adapter.total,
    failed: core.failed + desktop.failed + adapter.failed,
    ok: core.ok && desktop.ok && adapter.ok,
  }
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
