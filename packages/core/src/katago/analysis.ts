import {
  AppError,
  type AnalysisResult,
  type BoardSize,
  type Coord,
  type MoveInfo,
  type Ownership,
  type Player,
} from '@gomentor/shared'
import { fromGtp, toGtp } from '../board/coords'
import type { KataGoRuleset } from './commands'

/**
 * KataGo analysis-engine protocol: newline-delimited JSON, request in, one or
 * more responses out.
 *
 * This is a **different protocol from GTP**, not a variant of it, which is why it
 * lives in its own module. `design.md` §Alternatives chose it as primary: one
 * response carries winrate, score lead, ownership, and the principal variation
 * together, and requests carry an `id` so several can be in flight — GTP's
 * lockstep model fights both.
 *
 * Pure encoders and decoders. Process management is M2's `main/katago/process.ts`.
 */

/** What to analyse. Moves are the game record; `analyzeTurns` selects positions. */
export interface AnalysisQuery {
  readonly id: string
  readonly boardSize: BoardSize
  readonly komi: number
  readonly rules: KataGoRuleset
  /** Alternating from the first player, as `[player, coord | null]`. */
  readonly moves: readonly { player: Player; coord: Coord | null }[]
  /** Handicap or problem setup, applied before `moves`. */
  readonly initialStones?: readonly { player: Player; coord: Coord }[]
  readonly maxVisits: number
  /** Which turns to report. Omitted means the final position only. */
  readonly analyzeTurns?: readonly number[]
  readonly includeOwnership?: boolean
  /**
   * Emit a partial result every N centiseconds. Streaming progress is why this
   * exists — the UI shows a winrate that firms up rather than a spinner.
   */
  readonly reportDuringSearchEvery?: number
}

/**
 * Builds the request object.
 *
 * A `pass` is the string `"pass"` in the moves array, not an omitted entry — the
 * engine needs it to keep the turn parity right, and dropping it would silently
 * hand the move to the wrong colour.
 */
export function buildAnalysisRequest(query: AnalysisQuery): Record<string, unknown> {
  if (query.maxVisits < 1) {
    throw new AppError('ENGINE_QUERY_FAILED', 'maxVisits must be at least 1', {
      context: { maxVisits: query.maxVisits },
    })
  }

  const request: Record<string, unknown> = {
    id: query.id,
    moves: query.moves.map((move) => [
      colourToken(move.player),
      move.coord === null ? 'pass' : vertex(move.coord, query.boardSize),
    ]),
    rules: query.rules,
    komi: query.komi,
    boardXSize: query.boardSize,
    boardYSize: query.boardSize,
    maxVisits: query.maxVisits,
  }

  if (query.initialStones !== undefined && query.initialStones.length > 0) {
    request.initialStones = query.initialStones.map((stone) => [
      colourToken(stone.player),
      vertex(stone.coord, query.boardSize),
    ])
  }
  if (query.analyzeTurns !== undefined && query.analyzeTurns.length > 0) {
    request.analyzeTurns = [...query.analyzeTurns]
  }
  if (query.includeOwnership === true) request.includeOwnership = true
  if (query.reportDuringSearchEvery !== undefined) {
    request.reportDuringSearchEvery = query.reportDuringSearchEvery
  }

  return request
}

/** One request per line — that is the framing the engine expects on stdin. */
export function encodeAnalysisRequest(query: AnalysisQuery): string {
  return `${JSON.stringify(buildAnalysisRequest(query))}\n`
}

/** Builds a cancellation for an in-flight query. */
export function encodeTerminateRequest(id: string): string {
  return `${JSON.stringify({ id, action: 'terminate' })}\n`
}

/**
 * Splits a stdout buffer into complete JSON lines plus a remainder.
 *
 * The remainder matters: a read can land mid-line, and parsing a half-object
 * would either throw or — worse with a lenient parser — produce a truncated
 * result that looks valid.
 */
export function splitJsonLines(buffer: string): { lines: string[]; remainder: string } {
  const normalised = buffer.replace(/\r\n/g, '\n')
  const parts = normalised.split('\n')
  // The last element is either an incomplete line or empty when the buffer ended
  // on a newline. Either way it is not yet a complete line.
  const remainder = parts.pop() ?? ''
  return { lines: parts.filter((line) => line.trim() !== ''), remainder }
}

/**
 * Parses one response line into an `AnalysisResult`.
 *
 * `gameId` and `moveNumber` are supplied by the caller, not read from the
 * response: KataGo echoes only the `id` it was given, and inventing a mapping
 * from it here would push a parsing convention into the protocol layer.
 *
 * Throws `ENGINE_QUERY_FAILED` when the line is not a usable response. This is
 * the one place where an exception is right: a caller that got a malformed line
 * has nothing to display, and a zeroed result would render as a real 50% winrate.
 */
export function parseAnalysisResponse(
  line: string,
  context: { gameId: string; moveNumber: number; player: Player; boardSize: BoardSize },
): AnalysisResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    // The line itself is not logged — engine output can be long, and this
    // context reaches a log sink.
    throw new AppError('ENGINE_QUERY_FAILED', 'analysis response is not valid JSON', {
      context: { length: line.length },
    })
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('ENGINE_QUERY_FAILED', 'analysis response is not an object')
  }

  const response = raw as Record<string, unknown>

  // KataGo reports its own errors in-band. Surfacing the field name but not the
  // message keeps an engine-controlled string out of our error envelope.
  if (typeof response.error === 'string') {
    throw new AppError(
      'ENGINE_QUERY_FAILED',
      'the engine reported an error for this query',
      {
        context: { queryId: stringOr(response.id, '') },
      },
    )
  }
  if (typeof response.warning === 'string' && response.moveInfos === undefined) {
    throw new AppError(
      'ENGINE_QUERY_FAILED',
      'the engine returned a warning and no analysis',
      {
        context: { queryId: stringOr(response.id, '') },
      },
    )
  }

  const rootInfo = asRecord(response.rootInfo)
  const moveInfos = Array.isArray(response.moveInfos) ? response.moveInfos : []

  const candidates: MoveInfo[] = moveInfos
    .map((entry, index) => parseMoveInfo(entry, index, context.boardSize))
    .filter((entry): entry is MoveInfo => entry !== null)

  // Root winrate when present, else the best candidate's. A position with no
  // candidates and no rootInfo is not analysable, and 0.5 would be a fabricated
  // "even game".
  const rootWinrate = finiteOr(rootInfo?.winrate, null)
  const winrate = rootWinrate ?? candidates[0]?.winrate ?? null
  if (winrate === null) {
    throw new AppError('ENGINE_QUERY_FAILED', 'analysis response carries no winrate')
  }

  const ownership = parseOwnership(response.ownership, context.boardSize)

  return {
    queryId: stringOr(response.id, ''),
    gameId: context.gameId,
    moveNumber: context.moveNumber,
    player: context.player,
    winrate: clamp01(winrate),
    scoreLead: finiteOr(rootInfo?.scoreLead, null) ?? candidates[0]?.scoreLead ?? 0,
    visits: Math.max(0, Math.trunc(finiteOr(rootInfo?.visits, null) ?? 0)),
    candidates,
    ...(ownership === null ? {} : { ownership }),
    // `isDuringSearch: true` marks a streaming partial. Absent means final.
    complete: response.isDuringSearch !== true,
  }
}

function parseMoveInfo(
  entry: unknown,
  fallbackOrder: number,
  size: BoardSize,
): MoveInfo | null {
  const info = asRecord(entry)
  if (info === null) return null

  const move = info.move
  if (typeof move !== 'string') return null

  // `fromGtp` throws on an unparseable vertex and returns null only for `pass`;
  // it also trims and upper-cases. A candidate we cannot place on a board is
  // dropped rather than propagated — one bad vertex should not void a whole
  // analysis, and rendering it at (0,0) would be worse than omitting it.
  const coord = tryFromGtp(move, size)
  if (coord === undefined) return null

  const winrate = finiteOr(info.winrate, null)
  if (winrate === null) return null

  return {
    coord,
    winrate: clamp01(winrate),
    scoreLead: finiteOr(info.scoreLead, null) ?? 0,
    visits: Math.max(0, Math.trunc(finiteOr(info.visits, null) ?? 0)),
    pv: parsePv(info.pv, size),
    order: Math.max(0, Math.trunc(finiteOr(info.order, null) ?? fallbackOrder)),
  }
}

/**
 * Decodes the principal variation, **truncating** at the first vertex that will
 * not parse.
 *
 * Truncation, not `null`-substitution: `null` in a pv means a pass, so mapping a
 * garbled vertex to `null` would insert a move that was never suggested and
 * flip the colour of every move after it. A short pv is honest; a wrong one is
 * a fabricated continuation.
 */
function parsePv(value: unknown, size: BoardSize): (Coord | null)[] {
  if (!Array.isArray(value)) return []
  const out: (Coord | null)[] = []
  for (const vertex of value) {
    if (typeof vertex !== 'string') break
    const coord = tryFromGtp(vertex, size)
    if (coord === undefined) break
    out.push(coord)
  }
  return out
}

/**
 * `fromGtp` with the throw converted to `undefined`.
 *
 * Three outcomes have to stay distinguishable: a coordinate, a pass (`null`),
 * and unparseable (`undefined`). Collapsing the last two is exactly the bug
 * this shape prevents.
 */
function tryFromGtp(vertex: string, size: BoardSize): Coord | null | undefined {
  try {
    return fromGtp(vertex, size)
  } catch {
    return undefined
  }
}

/**
 * Validates the ownership array's length against the board.
 *
 * A wrong-length array is rejected rather than padded: ownership is rendered as
 * a per-point overlay, so a short array would silently shift every value after
 * the gap onto the wrong point — visually plausible and entirely wrong.
 */
function parseOwnership(value: unknown, size: BoardSize): Ownership | null {
  if (!Array.isArray(value)) return null
  const expected = size * size
  if (value.length !== expected) {
    throw new AppError(
      'ENGINE_QUERY_FAILED',
      'ownership array does not match the board size',
      {
        context: { received: value.length, expected },
      },
    )
  }
  return value.map((entry) => {
    const parsed = finiteOr(entry, null)
    // Clamped rather than rejected: the schema's range is -1..1 and a float a
    // hair outside it is a rounding artefact, not a protocol violation.
    return parsed === null ? 0 : Math.min(1, Math.max(-1, parsed))
  })
}

/** KataGo wants `B`/`W`, not our `black`/`white`. */
function colourToken(player: Player): 'B' | 'W' {
  return player === 'black' ? 'B' : 'W'
}

/**
 * `toGtp` with `CoordError` converted to an `AppError`.
 *
 * `CoordError` does carry a code (`BOARD_INVALID_COORD`), but it is not an
 * `AppError`, so it would reach the renderer boundary as an untyped throw. The
 * conversion also says more than a generic coordinate complaint can: on this
 * path the mismatch it catches is a game record replayed against the wrong board
 * size, which is an engine-query failure. The coordinate is safe to name — it is
 * a board position, not user content.
 */
function vertex(coord: Coord, size: BoardSize): string {
  try {
    return toGtp(coord, size)
  } catch {
    throw new AppError(
      'ENGINE_QUERY_FAILED',
      'a move does not fit the requested board size',
      {
        context: { x: coord.x, y: coord.y, boardSize: size },
      },
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function finiteOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The `id` we echo back, or the fallback.
 *
 * A non-string `id` becomes `''` rather than being coerced: `String(undefined)`
 * would produce the literal `"undefined"` as a queryId, which a caller
 * correlating responses to requests could match against nothing while looking
 * like a real value.
 */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
