/**
 * The fake KataGo child process. **Not a module to import** — see `fake-katago.ts`.
 *
 * A real program, spawned as a real child, reading real stdin and writing real
 * stdout. `design.md` chose this over a mock deliberately: the things that break in
 * engine integration are pipes, response framing, and exit handling, and a mock
 * object exercises none of them — it tests the mock. It speaks GTP by default
 * and the analysis protocol with `--mode=analysis` — GTP because it is trivial
 * to fake honestly, analysis because that is what M2's process layer spawns —
 * so the fake stays a transport exercise instead of becoming a second engine
 * implementation.
 *
 * ## What this deliberately is not
 *
 * **It does not play Go.** `genmove` returns vertices from a fixed cycle; it does
 * not look at the board, does not avoid occupied points, and does not know a legal
 * move from an illegal one. That is the point. A fake that computed moves would be
 * a Go engine under test, and any bug in it would surface as a mysterious failure
 * in whatever was actually being tested. Determinism is worth more here than
 * plausibility, and there is no `Math.random` anywhere in this file.
 *
 * What it *is* precise about is the protocol: the `\n\n` block terminator, the
 * optional echoed id with no space after the prefix, multi-line bodies, the
 * distinction between `=` and `?`, and exit behaviour.
 *
 * ## Why it can be made to misbehave
 *
 * A harness that only ever succeeds cannot test the failure paths, and those are
 * the paths that matter: `ENGINE_CRASHED`, `ENGINE_START_TIMEOUT`,
 * `ENGINE_QUERY_FAILED`. So the faults are first-class, selected by argv:
 *
 *   --crash-after=N     exit(3) after answering N commands (GTP) or emitting N
 *                       response lines (analysis)
 *   --exit-code=N       what `quit` (and --crash-after) exits with; default 0 / 3
 *   --hang-on=CMD       GTP: read the command, answer nothing, ever.
 *                       Analysis: matches when the request id CONTAINS the value
 *   --hang-on-query     analysis mode: hang on every analysis query
 *   --garbage-on=CMD    GTP: answer with a line that is not a GTP response at all.
 *                       Analysis: same, when the request id contains the value
 *   --unterminated-on=CMD  (GTP only) answer without the blank line, so the block never closes
 *   --delay-ms=N        wait N ms before each response
 *   --stderr-noise      write to stderr on startup, as real engines do
 *   --stderr-lines=N    write N extra stderr lines at startup (throttle testing)
 *   --no-startup-banner suppress the stderr banner
 *   --mode=analysis     speak the analysis protocol instead of GTP (below)
 *                       The positional `analysis` also selects analysis mode —
 *                       the env-override path (`GOMENTOR_KATAGO_BINARY`) cannot
 *                       carry flags, and the service always passes the
 *                       subcommand, so the positional alone must be enough.
 *
 * Two analysis-mode faults are env-selected for the same reason (the e2e
 * launches the fake through `GOMENTOR_KATAGO_BINARY`, which names a file, not
 * a command line):
 *
 *   FAKE_KATAGO_OWNERSHIP_SHORT   when set, queries whose id contains the
 *                       value ('*' matches all) answer includeOwnership with
 *                       an array one point short — B4's wrong-length rejection,
 *                       which no argv can reach in the env-override path.
 *   FAKE_KATAGO_DELAY_MS  when set to a positive integer, every analysis
 *                       response waits that long before being written. The
 *                       sweep e2e uses this to make a whole-record sweep fill
 *                       the winrate graph *progressively* instead of
 *                       instantly, so a spec can watch points appear; no argv
 *                       flag can reach the env-override launch path.
 *   FAKE_KATAGO_CRASH_ONCE_AFTER / FAKE_KATAGO_CRASH_MARKER  crash after N
 *                       responses — but only on the spawn that found the
 *                       marker absent, which is also the spawn that writes
 *                       it. The crash-recovery e2e needs exactly one crash
 *                       followed by a healthy respawn, and every respawn is
 *                       the same binary with the same env; the marker file is
 *                       how the fake tells its own launches apart.
 *
 * ## Analysis-mode terminate semantics (Stage 5)
 *
 * A query read but not yet answered is *pending*; answers drain through a
 * serialised queue (one response per delay, in issue order — true
 * concurrency would make the sweep e2e's "fills progressively" timing
 * assumptions meaningless). A terminate for a pending query models KataGo's
 * documented behaviour (Analysis_Engine.md, fetched 2026-09-05): the query
 * still concludes with **exactly one final reply** carrying
 * `isDuringSearch: false`, and nothing after. A terminate for an already
 * answered query is ignored, and a query under `--hang-on`/`--hang-on-query`
 * never becomes pending — a wedged engine processes nothing, which is what
 * the watchdog exists to detect.
 *
 * ## Analysis mode (`--mode=analysis`)
 *
 * M2's process layer spawns `katago analysis -config <cfg> -model <net>`, so
 * the fake accepts and ignores that argv shape (`analysis`, `-config`,
 * `-model`, `-override-config`) and then speaks newline-delimited JSON on
 * stdin/stdout instead of GTP: one request object per line, one response
 * object per line, `{id, action: 'terminate'}` cancels a query. Responses are
 * canned and **seeded by request content** — same request, same bytes, every
 * run — because determinism is what makes a fake usable in an assertion.
 *
 * What the fake still deliberately is not: an engine. The canned response
 * carries a rootInfo, two quarter-board candidates, and an ownership array
 * sized from the request, but no search results. Its job is to give the
 * production framing and parsing real bytes to chew on — `splitJsonLines` and
 * `parseAnalysisResponse` decide what those bytes mean.
 *
 * `--unterminated-on` is GTP-only: analysis mode has no block terminator to
 * withhold. Hanging and garbage have analysis-mode semantics (see above) and
 * exist for the crash/hang recovery tests (B5/B6 groundwork).
 */
import { existsSync, writeFileSync } from 'node:fs'
import { GTP_COMMANDS, KATAGO_COMMANDS } from '@gomentor/core/katago/commands'
import { splitJsonLines } from '@gomentor/core/katago/analysis'
import { toGtp } from '@gomentor/core/board/coords'
import type { BoardSize } from '@gomentor/shared'

/** Parsed argv. Unknown flags are rejected rather than ignored. */
interface Faults {
  mode: 'gtp' | 'analysis'
  crashAfter: number | null
  exitCode: number | null
  hangOn: string | null
  hangOnQuery: boolean
  garbageOn: string | null
  unterminatedOn: string | null
  delayMs: number
  stderrNoise: boolean
  stderrLines: number
  startupBanner: boolean
}

function parseFaults(argv: readonly string[]): Faults {
  const faults: Faults = {
    mode: argv.includes('--mode=analysis') ? 'analysis' : 'gtp',
    crashAfter: null,
    exitCode: null,
    hangOn: null,
    hangOnQuery: false,
    garbageOn: null,
    unterminatedOn: null,
    delayMs: 0,
    stderrNoise: false,
    stderrLines: 0,
    startupBanner: true,
  }

  // Indexed, not `for..of`: `-config`/`-model`/`-override-config` take their
  // value as the *next* argv entry, and the loop must skip it — a path value
  // would otherwise fall into the unknown-argument rejection below.
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const [flag, rawValue] = arg.split('=', 2)
    switch (flag) {
      case '--mode':
        // Only `analysis` exists; an unknown mode is a typo, not a default.
        if (rawValue !== 'analysis') {
          process.stderr.write(`fake-katago: unknown mode ${arg}\n`)
          process.exit(2)
        }
        break
      case '--crash-after':
        faults.crashAfter = toInt(rawValue, arg)
        break
      case '--exit-code':
        faults.exitCode = toInt(rawValue, arg)
        break
      case '--hang-on':
        faults.hangOn = requireValue(rawValue, arg)
        break
      case '--hang-on-query':
        faults.hangOnQuery = true
        break
      case '--garbage-on':
        faults.garbageOn = requireValue(rawValue, arg)
        break
      case '--unterminated-on':
        faults.unterminatedOn = requireValue(rawValue, arg)
        break
      case '--delay-ms':
        faults.delayMs = toInt(rawValue, arg)
        break
      case '--stderr-noise':
        faults.stderrNoise = true
        break
      case '--stderr-lines':
        faults.stderrLines = toInt(rawValue, arg)
        break
      case '--no-startup-banner':
        faults.startupBanner = false
        break
      case 'analysis':
        // The real binary's subcommand, which the service always passes. The
        // positional alone also selects analysis mode: the env-override path
        // (`GOMENTOR_KATAGO_BINARY`) names a file and cannot carry
        // `--mode=analysis`, so without this the service's faithful
        // `analysis -config … -model …` argv would be rejected as unknown.
        faults.mode = 'analysis'
        break
      case '-config':
      case '-model':
      case '-override-config':
        // Real-katago CLI flags the service passes. The value is the next
        // argv entry; skip it so a strict parser does not reject a faithful
        // command line.
        index += 1
        break
      default:
        // Rejected, not ignored. A typo'd fault flag would otherwise produce a
        // perfectly healthy engine and a test that passes for the wrong reason —
        // asserting a crash never happened because the crash was never armed.
        process.stderr.write(`fake-katago: unknown argument ${arg}\n`)
        process.exit(2)
    }
  }

  return faults
}

function requireValue(value: string | undefined, arg: string): string {
  if (value === undefined || value === '') {
    process.stderr.write(`fake-katago: ${arg} needs a value (--flag=value)\n`)
    process.exit(2)
  }
  return value
}

function toInt(value: string | undefined, arg: string): number {
  const parsed = Number(requireValue(value, arg))
  if (!Number.isInteger(parsed)) {
    process.stderr.write(`fake-katago: ${arg} needs an integer\n`)
    process.exit(2)
  }
  return parsed
}

/**
 * Board state, tracked only so that `showboard` and `undo` are not lies.
 *
 * `showboard` exists in this fake specifically to produce a **multi-line,
 * space-aligned** body — the response shape that breaks a reader which frames on
 * the first newline or which trims more than the one leading space GTP specifies.
 * For it to be a useful test it has to reflect something, hence the move list.
 */
interface Board {
  size: number
  komi: number
  moves: { player: string; vertex: string }[]
}

const COLUMNS = 'ABCDEFGHJKLMNOPQRST' // no I, per GTP

function showboard(board: Board): string {
  const grid: string[][] = Array.from({ length: board.size }, () =>
    Array.from({ length: board.size }, () => '.'),
  )

  for (const move of board.moves) {
    const vertex = move.vertex.toUpperCase()
    if (vertex === 'PASS' || vertex === 'RESIGN') continue
    const column = COLUMNS.indexOf(vertex[0] ?? '')
    const row = Number(vertex.slice(1))
    if (column < 0 || !Number.isInteger(row)) continue
    if (row < 1 || row > board.size) continue
    // GTP row 1 is the bottom; row 0 of the grid is the top.
    const y = board.size - row
    const cell = grid[y]
    if (cell === undefined) continue
    cell[column] = move.player.toLowerCase().startsWith('b') ? 'X' : 'O'
  }

  const header = `   ${COLUMNS.slice(0, board.size).split('').join(' ')}`
  const rows = grid.map((cells, index) => {
    const label = String(board.size - index).padStart(2, ' ')
    return `${label} ${cells.join(' ')}`
  })

  return [header, ...rows, header].join('\n')
}

/**
 * The vertices `genmove` cycles through.
 *
 * Fixed and deliberately including `pass` and `resign`: those are the two cases
 * `decodeMove` treats as not-a-coordinate, and a fake that only ever returned
 * coordinates would leave both branches unexercised.
 */
const GENMOVE_CYCLE = ['D4', 'Q16', 'D16', 'Q4', 'pass', 'K10', 'resign']

async function main(): Promise<void> {
  const faults = parseFaults(process.argv.slice(2))
  if (faults.mode === 'analysis') {
    await runAnalysis(faults)
    return
  }

  const board: Board = { size: 19, komi: 7.5, moves: [] }

  let answered = 0
  let genmoveIndex = 0

  if (faults.stderrNoise) {
    // Real engines chatter on stderr. A reader that merges stderr into stdout
    // will try to parse this as a response and fail.
    process.stderr.write('fake-katago: OpenCL device 0 initialised (not really)\n')
  }
  writeStderrBurst(faults)
  if (faults.startupBanner) {
    process.stderr.write('fake-katago ready\n')
  }

  const write = async (payload: string): Promise<void> => {
    if (faults.delayMs > 0) await delay(faults.delayMs)
    process.stdout.write(payload)
  }

  /** `= body\n\n`, or `=<id> body\n\n` when the request carried one. */
  const respond = async (
    id: string | null,
    body: string,
    ok = true,
    terminated = true,
  ): Promise<void> => {
    const prefix = ok ? '=' : '?'
    // No space between prefix and id — `parseResponse` reads the digits
    // immediately after the prefix, and `= 12 body` would make 12 part of the body.
    const head = id === null ? prefix : `${prefix}${id}`
    await write(`${head} ${body}${terminated ? '\n\n' : '\n'}`)
  }

  for await (const line of readLines(process.stdin)) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    const tokens = trimmed.split(/\s+/)
    // GTP allows an optional leading integer id, echoed in the response.
    const first = tokens[0] ?? ''
    const hasId = /^\d+$/.test(first)
    const id = hasId ? first : null
    const command = (hasId ? tokens[1] : tokens[0]) ?? ''
    const args = tokens.slice(hasId ? 2 : 1)

    if (faults.hangOn === command) {
      // Read and never answer. The socket stays open, which is what distinguishes
      // a timeout from a closed pipe — a test for `ENGINE_START_TIMEOUT` needs the
      // process alive and silent, not dead.
      continue
    }

    if (faults.garbageOn === command) {
      await write('this is not a GTP response\n\n')
      answered += 1
      if (shouldCrash(faults, answered)) exitWith(faults, 3)
      continue
    }

    const terminated = faults.unterminatedOn !== command

    switch (command) {
      case GTP_COMMANDS.protocolVersion:
        await respond(id, '2', true, terminated)
        break
      case GTP_COMMANDS.name:
        await respond(id, 'fake-katago', true, terminated)
        break
      case GTP_COMMANDS.version:
        await respond(id, '0.0.0-fake', true, terminated)
        break
      case GTP_COMMANDS.listCommands:
        // Multi-line on purpose — this is the response that catches a reader
        // framing on the first newline instead of on a blank line.
        await respond(id, SUPPORTED.join('\n'), true, terminated)
        break
      case GTP_COMMANDS.knownCommand:
        await respond(
          id,
          SUPPORTED.includes(args[0] ?? '') ? 'true' : 'false',
          true,
          terminated,
        )
        break
      case GTP_COMMANDS.boardsize: {
        const size = Number(args[0])
        if (!Number.isInteger(size) || size < 2 || size > 25) {
          await respond(id, 'unacceptable size', false, terminated)
          break
        }
        board.size = size
        board.moves = []
        await respond(id, '', true, terminated)
        break
      }
      case GTP_COMMANDS.clearBoard:
        board.moves = []
        await respond(id, '', true, terminated)
        break
      case GTP_COMMANDS.komi: {
        const komi = Number(args[0])
        if (!Number.isFinite(komi)) {
          await respond(id, 'syntax error', false, terminated)
          break
        }
        board.komi = komi
        await respond(id, '', true, terminated)
        break
      }
      case GTP_COMMANDS.play: {
        const player = args[0] ?? ''
        const vertex = args[1] ?? ''
        if (player === '' || vertex === '') {
          await respond(id, 'syntax error', false, terminated)
          break
        }
        board.moves.push({ player, vertex })
        await respond(id, '', true, terminated)
        break
      }
      case GTP_COMMANDS.genmove: {
        // Cycles a fixed list. Plays no Go — see the note at the top of the file.
        const vertex = GENMOVE_CYCLE[genmoveIndex % GENMOVE_CYCLE.length] ?? 'pass'
        genmoveIndex += 1
        board.moves.push({ player: args[0] ?? 'black', vertex })
        await respond(id, vertex, true, terminated)
        break
      }
      case GTP_COMMANDS.undo:
        if (board.moves.length === 0) {
          await respond(id, 'cannot undo', false, terminated)
          break
        }
        board.moves.pop()
        await respond(id, '', true, terminated)
        break
      case GTP_COMMANDS.showboard:
        await respond(id, showboard(board), true, terminated)
        break
      case GTP_COMMANDS.finalScore:
        await respond(id, 'B+0.5', true, terminated)
        break
      case KATAGO_COMMANDS.analyze:
        // One `kata-analyze`-shaped line. Enough for `parseAnalyzeLine` to have
        // real input; not a search.
        await respond(
          id,
          'info move D4 visits 100 winrate 0.5123 scoreLead 0.5 order 0 pv D4 Q16 ' +
            'info move Q16 visits 50 winrate 0.4900 scoreLead -0.2 order 1 pv Q16 D4',
          true,
          terminated,
        )
        break
      case GTP_COMMANDS.quit:
        await respond(id, '', true, terminated)
        exitWith(faults, 0)
        return
      default:
        // The exact GTP spelling. A caller distinguishing "engine is not KataGo"
        // from "engine is broken" branches on this text.
        await respond(id, 'unknown command', false, terminated)
        break
    }

    answered += 1
    if (shouldCrash(faults, answered)) exitWith(faults, 3)
  }

  // stdin closed without `quit`. Real engines exit; so does this.
  exitWith(faults, 0)
}

/**
 * Widened to `string[]` deliberately. `Object.values` of the command constants
 * gives a literal union, and this list is used for two *string* jobs — the
 * `list_commands` body and a `known_command` membership test whose whole point is
 * answering `false` for a command that is not in the union. Narrowing the argument
 * instead would make `known_command foo` untypeable, which is the case that matters.
 */
const SUPPORTED: readonly string[] = [
  ...Object.values(GTP_COMMANDS),
  KATAGO_COMMANDS.analyze,
]

function shouldCrash(faults: Faults, answered: number): boolean {
  return faults.crashAfter !== null && answered >= faults.crashAfter
}

function exitWith(faults: Faults, fallback: number): never {
  process.exit(faults.exitCode ?? fallback)
}

/**
 * `--stderr-lines=N`: the flood the throttle exists for. Real engines produce
 * this volume during tuning/startup; a fake that only ever wrote one line
 * could not distinguish "throttled" from "nothing to throttle".
 */
function writeStderrBurst(faults: Faults): void {
  for (let index = 0; index < faults.stderrLines; index += 1) {
    process.stderr.write(`fake-katago: noise line ${String(index)}\n`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Deterministic non-cryptographic hash, so the canned response is seeded by
 * request content without `Math.random` — the same request must produce the
 * same bytes on every run, or assertions against it are assertions against
 * chance.
 */
function hashString(text: string): number {
  let hash = 0
  for (const ch of text) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }
  return hash
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * The canned analysis response. Enough shape for the production parser to
 * exercise every field: a rootInfo (so `winrate`/`scoreLead` come from the
 * root, not a candidate), two candidates on quarter-board points (always
 * legal for the board size, unlike fixed vertices would be on a 9×9), an
 * ownership array sized from the request when asked for one, and no
 * `isDuringSearch` (so the parser reports a complete result).
 */
function cannedAnalysisResponse(
  request: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const sizeX = intOr(request['boardXSize'], 19)
  const sizeY = intOr(request['boardYSize'], 19)
  const maxVisits = Math.max(1, intOr(request['maxVisits'], 100))
  const seed = hashString(`${id}:${JSON.stringify(request['moves'] ?? null)}`)

  // Candidate points scale with the board so they are always on it. The
  // coords module is the authority on vertex spelling (the GTP `I`-skip
  // among other things) — the fake borrows it rather than re-deriving.
  const boardSize: BoardSize = sizeX === 9 || sizeX === 13 || sizeX === 19 ? sizeX : 19
  const quarter = Math.floor(boardSize / 4)
  const first = toGtp({ x: quarter, y: quarter }, boardSize)
  const second = toGtp(
    { x: boardSize - 1 - quarter, y: boardSize - 1 - quarter },
    boardSize,
  )

  const winrate = (500 + (seed % 100)) / 1000 // 0.500..0.599
  const scoreLead = (seed % 21) / 2 - 5 // -5.0..5.0 in 0.5 steps

  const response: Record<string, unknown> = {
    id,
    rootInfo: {
      visits: maxVisits,
      winrate: round4(winrate),
      scoreLead: round4(scoreLead),
    },
    moveInfos: [
      {
        move: first,
        visits: Math.max(1, Math.floor((maxVisits * 2) / 3)),
        winrate: round4(Math.min(1, winrate + 0.01)),
        scoreLead: round4(scoreLead + 0.5),
        order: 0,
        pv: [first, second],
      },
      {
        move: second,
        visits: Math.max(1, Math.floor(maxVisits / 3)),
        winrate: round4(Math.max(0, winrate - 0.02)),
        scoreLead: round4(scoreLead - 0.5),
        order: 1,
        pv: [second, first],
      },
    ],
  }
  if (request['includeOwnership'] === true) {
    // Sized from the request, not the fallback board: ownership length is a
    // protocol property (`parseOwnership` rejects a wrong-length array), so a
    // fake that "corrected" it to 19² would hide B4's entire failure class.
    const length = Math.max(0, sizeX) * Math.max(0, sizeY)
    // `FAKE_KATAGO_OWNERSHIP_SHORT` (env, because the env-override launch path
    // cannot pass argv): queries whose id contains the value — or all queries
    // for '*' — answer one point short, driving the wrong-length rejection
    // through the real parse path end-to-end.
    const shortOn = process.env['FAKE_KATAGO_OWNERSHIP_SHORT']
    const shorted =
      shortOn !== undefined &&
      shortOn !== '' &&
      (shortOn === '*' || id.includes(shortOn))
    response['ownership'] = Array.from(
      { length: shorted ? Math.max(1, length - 1) : length },
      (_, index) => ((index % 7) - 3) / 12,
    )
  }
  return response
}

/**
 * Analysis mode: newline-delimited JSON on stdin/stdout, the protocol
 * `packages/core/src/katago/analysis.ts` encodes. One response line per
 * request. Terminate semantics, answer queueing, and the crash-once env pair
 * are documented in the file header (§Analysis-mode terminate semantics).
 *
 * stdin is framed with the production `splitJsonLines`, never a local copy
 * (implement.md Stage 2): the fake's job is to give the real framing and
 * parsing code real bytes to chew on, and a private splitter here could
 * silently diverge from the reader it feeds.
 */
async function runAnalysis(faults: Faults): Promise<void> {
  /**
   * Query ids already given their mandated terminate final reply. There is
   * deliberately NO "answered" set: sweep query ids are reused across
   * records by contract (`sweep:<move>`), so a client legitimately re-sends
   * an id this process has answered before — for a different game — and a
   * real engine answers a duplicate id like any other request.
   */
  const terminated = new Set<string>()
  /**
   * Queries read but not yet answered. A terminate for one of these produces
   * exactly one final reply (`isDuringSearch: false`) — KataGo's documented
   * behaviour — and cancels the queued answer.
   */
  const pending = new Map<
    string,
    { readonly request: Record<string, unknown>; cancel: () => void }
  >()
  let responses = 0
  /** Latched when the crash threshold is reached: stop answering, drain, exit. */
  let crashing = false
  /** Serialised answer queue — see the header for why it is not concurrent. */
  let answerChain: Promise<void> = Promise.resolve()

  if (faults.stderrNoise) {
    // Real engines chatter on stderr. A reader that merged stderr into stdout
    // will try to parse this as a response and fail.
    process.stderr.write('fake-katago: Eigen backend initialised (not really)\n')
  }
  writeStderrBurst(faults)
  if (faults.startupBanner) {
    // Deliberately carries no version number: the service's version scan is
    // best-effort, and the fake is how "banner without a version" is tested.
    process.stderr.write('fake-katago ready (analysis)\n')
  }

  // Env-selected delay (see the header): the sweep e2e needs the fake to take
  // measurable time per response so the graph visibly fills. argv
  // `--delay-ms` says the same thing for the integration launches.
  const envDelay = Number(process.env['FAKE_KATAGO_DELAY_MS'] ?? 0)
  const delayMs = Number.isInteger(envDelay) && envDelay > 0 ? envDelay : faults.delayMs

  // The one-shot crash pair (header): argv cannot reach the env-override
  // launch path, and the service respawns the same binary with the same env —
  // the marker file is the only thing that distinguishes spawn 1 from spawn 2.
  let crashAfter = faults.crashAfter
  const marker = process.env['FAKE_KATAGO_CRASH_MARKER']
  const onceAfter = readEnvCount('FAKE_KATAGO_CRASH_ONCE_AFTER')
  if (
    crashAfter === null &&
    onceAfter !== null &&
    marker !== undefined &&
    marker !== ''
  ) {
    if (existsSync(marker)) {
      // A previous spawn already took the crash; this one is the healthy
      // respawn the recovery tests want.
    } else {
      writeFileSync(marker, 'crashed\n', 'utf8')
      crashAfter = onceAfter
    }
  }

  function writeLine(text: string): void {
    process.stdout.write(`${text}\n`)
    responses += 1
    if (crashAfter !== null && responses >= crashAfter && !crashing) {
      crashing = true
      // Drain margin, measured the hard way in Stage 5 crash-recovery work:
      // `process.exit` in the same tick as a pipe write can truncate the
      // write on Windows, and then the "crash mid-analysis" test fails for a
      // framing reason instead of exercising recovery. No further answers are
      // scheduled once `crashing` latches, so exactly `crashAfter` responses
      // reach the parent, deterministically.
      setTimeout(() => exitWith(faults, 3), 25)
    }
  }

  function queueAnswer(record: Record<string, unknown>, id: string): void {
    let cancelled = false
    pending.set(id, {
      request: record,
      cancel: () => {
        cancelled = true
      },
    })
    answerChain = answerChain.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            pending.delete(id)
            if (cancelled || crashing) {
              resolve()
              return
            }
            writeLine(JSON.stringify(cannedAnalysisResponse(record, id)))
            resolve()
          }, delayMs)
        }),
    )
  }

  function handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '' || crashing) return

    let request: unknown
    try {
      request = JSON.parse(trimmed)
    } catch {
      writeLine('{"id":"","error":"could not parse request"}')
      return
    }
    if (typeof request !== 'object' || request === null) {
      writeLine('{"id":"","error":"request is not an object"}')
      return
    }
    const record = request as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'] : ''

    if (record['action'] === 'terminate') {
      const entry = pending.get(id)
      if (entry === undefined) return
      // KataGo's documented terminate behaviour: the query still concludes
      // with exactly one final reply, marked not-during-search. The answer it
      // would have given is cancelled — the reply stands in for it.
      entry.cancel()
      pending.delete(id)
      terminated.add(id)
      writeLine(
        JSON.stringify({
          ...cannedAnalysisResponse(entry.request, id),
          isDuringSearch: false,
        }),
      )
      return
    }
    if (terminated.has(id)) return
    if (faults.hangOnQuery) return
    if (faults.hangOn !== null && id.includes(faults.hangOn)) return

    if (faults.garbageOn !== null && id.includes(faults.garbageOn)) {
      // Names the id so the reader can attribute the garbage to its query —
      // an unparseable line that answers nothing in particular is ignorable
      // chatter; one that answers *this* query is a protocol failure.
      writeLine(`this is not a JSON analysis response for id ${id}`)
      return
    }

    queueAnswer(record, id)
  }

  let stdinBuffer = ''
  // `process.stdin` yields `any` chunks by default; the AsyncIterable cast is
  // what keeps `chunk` typed through the loop (the GTP path gets the same
  // treatment via readLines' parameter type).
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    stdinBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const framed = splitJsonLines(stdinBuffer)
    stdinBuffer = framed.remainder
    for (const line of framed.lines) handleLine(line)
  }
  // A final unterminated line is still a request worth answering: the real
  // engine treats EOF's buffered bytes the same way. Any queued answers die
  // with the process — stdin EOF is the shutdown signal, not a flush request.
  if (stdinBuffer.trim() !== '') handleLine(stdinBuffer)

  // Stdin closed without an explicit quit — the analysis engine's normal
  // shutdown signal.
  exitWith(faults, 0)
}

/** A positive integer read from the environment, or null when absent/invalid. */
function readEnvCount(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Yields complete lines from a stream. GTP mode only: analysis mode frames its
 * stdin with the production `splitJsonLines` (see `runAnalysis`), and this
 * hand-rolled splitter stays solely because M1's GTP transport — whose
 * framing is a blank-line block terminator, not newline-delimited JSON — is
 * gate-verified territory a Stage-2 change must not touch.
 *
 * Hand-rolled rather than `node:readline` because the buffering behaviour is the
 * thing under test on the other side of the pipe, and a chunk boundary landing
 * mid-line is exactly the case that must work. This keeps the split visible.
 */
async function* readLines(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index === -1) break
      yield buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
    }
  }
  if (buffer !== '') yield buffer
}

// Not top-level `await`: `apps/desktop/package.json` declares no `"type": "module"`,
// so tsx transforms this file as CJS and top-level await is a *transform* error, not
// a runtime one. The child then dies before reading a byte, and every test against it
// fails with a timeout that looks like a protocol bug. Measured, once.
main().catch((error: unknown) => {
  // Straight to stderr and a non-zero exit, because the parent reports child stderr
  // in its timeout message — that is what turned the above into a one-line diagnosis.
  process.stderr.write(
    `fake-katago: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
