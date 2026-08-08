import { AppError, type BoardSize, type Coord, type Player } from '@gomentor/shared'
import { fromGtp, toGtp } from '../board/coords'
import { GTP_FAILURE_PREFIX, GTP_SUCCESS_PREFIX, GTP_COMMANDS } from './commands'

/**
 * Pure GTP encoder and decoder. No process management, no transport.
 *
 * Written before `main/katago/process.ts` on purpose (`design.md` §Operational):
 * getting protocol correctness settled in a layer that needs no child process
 * means M2's risk is confined to process lifecycle.
 *
 * The parts of GTP that are easy to get wrong and are handled here explicitly:
 *
 * - **A response ends at a blank line, not a newline.** Responses are
 *   multi-line (`showboard`, `list_commands`), so a reader that treats the first
 *   newline as the end truncates them. `parseResponse` takes a whole block.
 * - **Control characters must be stripped, tabs become spaces.** The spec
 *   requires it, and an engine writing a stray `\r` on Windows would otherwise
 *   change how a line parses.
 * - **`=` and `?` may carry an optional id**, echoed from the request. Ignoring
 *   the id makes concurrent requests unmatchable.
 * - **A pass is the literal `pass`**, not an empty vertex, and `resign` is a
 *   third case distinct from both.
 */

/** A parsed GTP response. `ok: false` is a protocol-level failure, not a throw. */
export type GtpResponse =
  | { readonly ok: true; readonly id: number | null; readonly body: string }
  | { readonly ok: false; readonly id: number | null; readonly error: string }

/** A move in GTP terms. `pass` and `resign` are not coordinates. */
export type GtpMove =
  | { readonly kind: 'play'; readonly coord: Coord }
  | { readonly kind: 'pass' }
  | { readonly kind: 'resign' }

/**
 * Strips what GTP forbids and normalises whitespace.
 *
 * Per the spec: remove control characters other than newline, convert tabs to
 * spaces, and discard everything from `#` to end of line. Applied before any
 * parsing, so no later step has to wonder whether it is looking at a comment or
 * a stray carriage return.
 */
export function sanitiseLine(line: string): string {
  let out = ''
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\t') {
      out += ' '
      continue
    }
    // Comments run to end of line. Checked before the control-character filter
    // so a commented-out control character is dropped with the comment.
    if (char === '#') break
    // Keep newline; drop other C0 controls and DEL.
    if (char === '\n') {
      out += char
      continue
    }
    if (code < 0x20 || code === 0x7f) continue
    out += char
  }
  return out
}

/**
 * Encodes a command, optionally with an id.
 *
 * The id matters for anything concurrent: GTP echoes it back, and it is the only
 * way to attribute a response to a request when more than one is outstanding.
 */
export function encodeCommand(
  command: string,
  args: readonly (string | number)[] = [],
  id?: number,
): string {
  const parts = [...args.map((arg) => String(arg))]
  const head = id === undefined ? command : `${String(id)} ${command}`
  const line = [head, ...parts].join(' ')
  // Sanitised on the way out too: an argument carrying a newline would inject a
  // second command, and a caller building a comment string should not be able to
  // truncate its own request.
  const clean = sanitiseLine(line).replace(/\n/g, ' ').trim()
  return `${clean}\n`
}

/** `play black D4`. Colour comes first, per the spec. */
export function encodePlay(
  player: Player,
  move: GtpMove,
  size: BoardSize,
  id?: number,
): string {
  return encodeCommand(GTP_COMMANDS.play, [player, encodeMove(move, size)], id)
}

export function encodeGenmove(player: Player, id?: number): string {
  return encodeCommand(GTP_COMMANDS.genmove, [player], id)
}

/**
 * Komi as a decimal.
 *
 * `String(6.5)` gives `6.5`, but `String(6)` gives `6` — and some engines reject
 * an integer where they expect a float. `toFixed(1)` keeps one decimal always.
 */
export function encodeKomi(komi: number, id?: number): string {
  return encodeCommand(GTP_COMMANDS.komi, [komi.toFixed(1)], id)
}

export function encodeBoardsize(size: BoardSize, id?: number): string {
  return encodeCommand(GTP_COMMANDS.boardsize, [size], id)
}

/** `pass` and `resign` are literals; a coordinate goes through `toGtp`. */
export function encodeMove(move: GtpMove, size: BoardSize): string {
  switch (move.kind) {
    case 'pass':
      return 'pass'
    case 'resign':
      return 'resign'
    case 'play':
      return toGtp(move.coord, size)
  }
}

/**
 * Decodes a vertex.
 *
 * Case-insensitive because engines are inconsistent about it, and `pass` arrives
 * as `pass` or `PASS` depending on the engine.
 *
 * Returns `null` for an unrecognisable vertex rather than throwing: this parses
 * engine output, and one malformed line should be reportable by the caller
 * without unwinding a whole analysis.
 */
export function decodeMove(value: string, size: BoardSize): GtpMove | null {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'pass') return { kind: 'pass' }
  if (trimmed === 'resign') return { kind: 'resign' }
  // `fromGtp` throws a CoordError on an unparseable vertex, and it has already
  // consumed the `pass` case above. Converting the throw here is what makes the
  // documented contract true: `null` means "not a vertex I can use", from either
  // a malformed letter or an out-of-bounds row.
  try {
    const coord = fromGtp(trimmed, size)
    return coord === null ? null : { kind: 'play', coord }
  } catch {
    return null
  }
}

/**
 * Parses one complete response block.
 *
 * `block` is everything up to (not including) the terminating blank line. A
 * caller reading a stream must do that framing itself — which is the transport's
 * job, and why this function does not accept a partial buffer and guess.
 *
 * Throws only when the block is not a GTP response at all. A `?` failure is a
 * successful parse of a failed command, and is returned, not thrown: the caller
 * decides whether `? unknown command` is fatal.
 */
export function parseResponse(block: string): GtpResponse {
  const clean = sanitiseLine(block)
  const trimmed = clean.replace(/^\s+/, '')

  const prefix = trimmed[0]
  if (prefix !== GTP_SUCCESS_PREFIX && prefix !== GTP_FAILURE_PREFIX) {
    throw new AppError('ENGINE_QUERY_FAILED', 'response does not start with = or ?', {
      // The first 40 characters only: engine output can be long, and this
      // context is logged.
      context: { head: trimmed.slice(0, 40) },
    })
  }

  const rest = trimmed.slice(1)
  // An id, when present, immediately follows the prefix with no space: `=12 ok`.
  const idMatch = /^(\d+)/.exec(rest)
  const id = idMatch === null ? null : Number(idMatch[1])
  const afterId = idMatch === null ? rest : rest.slice(idMatch[0].length)

  // A single leading space separates the prefix/id from the body. Only one is
  // consumed — `showboard` output is space-aligned and further spaces are data.
  const body = afterId.startsWith(' ') ? afterId.slice(1) : afterId

  return prefix === GTP_SUCCESS_PREFIX
    ? { ok: true, id, body: body.replace(/\s+$/, '') }
    : { ok: false, id, error: body.trim() }
}

/**
 * Splits a stream buffer into complete response blocks plus a remainder.
 *
 * Framing is the one thing a caller cannot skip and cannot easily get right by
 * hand: GTP terminates a response with a **blank line**, and both `\n\n` and
 * `\r\n\r\n` occur in the wild. The remainder is whatever follows the last
 * complete block, to be prepended to the next read.
 */
export function splitResponseBlocks(buffer: string): {
  blocks: string[]
  remainder: string
} {
  const normalised = buffer.replace(/\r\n/g, '\n')
  const blocks: string[] = []
  let start = 0

  for (;;) {
    const end = normalised.indexOf('\n\n', start)
    if (end === -1) break
    blocks.push(normalised.slice(start, end))
    start = end + 2
  }

  return { blocks, remainder: normalised.slice(start) }
}

/**
 * Parses `list_commands` output — one command per line.
 *
 * Used to decide whether the engine is KataGo before sending a `kata-*` command,
 * rather than sending one and interpreting the failure.
 */
export function parseCommandList(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * One candidate from a `kata-analyze` line.
 *
 * Deliberately not `MoveInfo` from `@gomentor/shared`: that type is the analysis
 * *engine's* richer output and its `winrate` is schema-constrained to 0..1,
 * while `kata-analyze` reports whatever the engine printed. Converting happens
 * where a caller has decided what to do with an out-of-range value, not here.
 */
export interface AnalyzeCandidate {
  coord: Coord | null
  visits: number
  winrate: number
  scoreLead: number
  order: number
  pv: (Coord | null)[]
}

/**
 * Parses a `kata-analyze` line into candidate moves.
 *
 * The format is flat key/value pairs, with `info` starting each candidate and
 * `move`, `visits`, `winrate`, `scoreLead`, `order`, `pv` inside it. `pv` is
 * last in each block and runs to the next `info` — which is why this scans
 * rather than splitting on a delimiter.
 *
 * Returns an empty array for a line with no candidates. An engine that is still
 * warming up emits those, and treating one as an error would surface a spurious
 * failure at the start of every analysis.
 */
export function parseAnalyzeLine(line: string, size: BoardSize): AnalyzeCandidate[] {
  const clean = sanitiseLine(line).trim()
  if (clean === '') return []

  const tokens = clean.split(/\s+/)
  const candidates: AnalyzeCandidate[] = []

  let current: Record<string, string[]> | null = null
  let key: string | null = null

  const flush = (): void => {
    if (current === null) return
    const move = current.move?.[0]
    const parsed = move === undefined ? null : decodeMove(move, size)
    // A candidate whose own vertex will not parse is dropped, not pushed with a
    // `null` coord: `null` means pass here, so keeping it would turn a garbled
    // vertex into a recommendation to pass.
    if (parsed === null) {
      current = null
      return
    }
    candidates.push({
      coord: parsed.kind === 'play' ? parsed.coord : null,
      visits: numberFrom(current.visits),
      winrate: numberFrom(current.winrate),
      scoreLead: numberFrom(current.scoreLead),
      order: numberFrom(current.order),
      pv: parsePv(current.pv, size),
    })
    current = null
  }

  for (const token of tokens) {
    if (token === 'info') {
      flush()
      current = {}
      key = null
      continue
    }
    if (current === null) continue

    // A known key starts a new field; anything else is a value appended to the
    // current one. `pv` is the only multi-value field, but treating them all
    // uniformly means an unrecognised multi-value field cannot corrupt the next.
    if (KNOWN_ANALYZE_KEYS.has(token)) {
      key = token
      current[key] = []
      continue
    }
    if (key !== null) current[key]?.push(token)
  }
  flush()

  return candidates
}

/**
 * Decodes a pv, **truncating** at the first vertex that will not parse.
 *
 * Truncation rather than a `null` placeholder, for the same reason as above:
 * `null` in a pv is a pass, so substituting it for a garbled vertex inserts a
 * move that was never suggested and flips the colour of every move after it. A
 * short variation is honest; a wrong one is a fabricated continuation.
 */
function parsePv(values: string[] | undefined, size: BoardSize): (Coord | null)[] {
  const out: (Coord | null)[] = []
  for (const vertex of values ?? []) {
    const decoded = decodeMove(vertex, size)
    if (decoded === null || decoded.kind === 'resign') break
    out.push(decoded.kind === 'play' ? decoded.coord : null)
  }
  return out
}

/** The keys `kata-analyze` emits that this parser reads or must skip past. */
const KNOWN_ANALYZE_KEYS = new Set([
  'move',
  'visits',
  'utility',
  'winrate',
  'scoreMean',
  'scoreStdev',
  'scoreLead',
  'scoreSelfplay',
  'prior',
  'lcb',
  'utilityLcb',
  'order',
  'pv',
  'pvVisits',
  'ownership',
  'isSymmetryOf',
  'weight',
])

/**
 * First value as a number, or 0.
 *
 * 0 rather than throwing: a missing field in one candidate of a streaming
 * analysis should not discard the candidates that did parse. The caller sees a
 * candidate with 0 visits, which is visibly not a real recommendation.
 */
function numberFrom(values: string[] | undefined): number {
  const raw = values?.[0]
  if (raw === undefined) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}
