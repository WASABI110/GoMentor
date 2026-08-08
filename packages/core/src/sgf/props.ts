import {
  AppError,
  isAppError,
  type BoardSize,
  type Coord,
  type GameResult,
  type Player,
} from '@gomentor/shared'
import { z } from 'zod'
import { fromSgf, toIndex } from '../board/coords'
import { getProperty, getRawValue, type NodeMove, type SgfNode } from './ast'
import { describeNumeric, describeValue } from './diagnostic'

/**
 * Typed accessors over the raw AST.
 *
 * This is the decode half of the A5 boundary. `parser.ts` keeps every value
 * exactly as written — `\]` stays `\]` — so that serialisation can reproduce
 * the original bytes. Interpretation happens here instead, per property, on
 * demand. Nothing in this file mutates the AST, so reading a game never
 * changes what writing it back produces.
 *
 * Two conventions, both deliberate:
 *
 * 1. **A malformed value reads as absent, not as an exception.** Real files
 *    carry `RE[?]`, mojibake in `RE`, and `KM[0.500000]`. A library import that
 *    throws on the first odd metadata field is useless against a real
 *    collection, and metadata is not load-bearing — a game with an
 *    unparseable result is still a game.
 *
 * 2. **Except where a wrong answer is worse than no answer.** An off-board
 *    move or an unsupported board size throws, because silently dropping them
 *    yields a board position that differs from the file's while looking
 *    perfectly valid. `gogui-invalidmove.sgf` in the corpus is exactly this
 *    case: `B[rs]` on a 9x9 board.
 *
 * zod does the validating rather than hand-rolled range checks, so the bounds
 * here and the bounds the IPC layer enforces cannot drift apart.
 */

// ---------------------------------------------------------------------------
// Value decoding (SGF data types)
// ---------------------------------------------------------------------------

/**
 * Decodes an SGF `Text` or `SimpleText` value.
 *
 * Three rules, and the first is the one implementations get wrong:
 *
 * - A backslash before a newline is a **soft line break**: it disappears
 *   entirely, joining the two lines. This is how long comments wrap without
 *   introducing a real newline.
 * - A backslash before anything else yields that character literally, which is
 *   how `]` and `\` survive inside a value.
 * - Whitespace other than a newline becomes a space. For `SimpleText`, hard
 *   newlines become spaces too; for `Text` they are preserved.
 *
 * The four linebreak spellings (LF, CR, CRLF, LFCR) each count as one break.
 */
function decodeTextValue(raw: string, kind: 'text' | 'simple'): string {
  let out = ''
  let i = 0

  /** Consumes a linebreak at `i`, treating CRLF/LFCR as a single one. */
  const consumeBreak = (): void => {
    const first = raw[i]
    i += 1
    const second = raw[i]
    if ((first === '\r' && second === '\n') || (first === '\n' && second === '\r'))
      i += 1
  }

  while (i < raw.length) {
    const char = raw[i]

    if (char === '\\') {
      const next = raw[i + 1]
      // A trailing backslash is malformed; dropping it is the least surprising
      // reading and matches what other tools do.
      if (next === undefined) break
      if (next === '\n' || next === '\r') {
        i += 1
        consumeBreak()
        continue
      }
      // FF[4] §3.2, verbatim: "Any char following '\' is inserted verbatim
      // (exception: whitespaces still have to be converted to space!)". The
      // exception is easy to miss — the escape says "verbatim" and stops there
      // — so `\<TAB>` is a space, not a tab. Newline is already handled above
      // as a soft line break, which is the *other* escaped-whitespace rule.
      out += /\s/.test(next) ? ' ' : next
      i += 2
      continue
    }

    if (char === '\n' || char === '\r') {
      consumeBreak()
      out += kind === 'text' ? '\n' : ' '
      continue
    }

    // Tabs and vertical tabs become spaces in both types.
    out += char === undefined ? '' : /\s/.test(char) ? ' ' : char
    i += 1
  }

  return out
}

/** Multi-line value: `C`, `GC`. Hard newlines survive. */
export function decodeText(raw: string): string {
  return decodeTextValue(raw, 'text')
}

/** Single-line value: `PB`, `EV`, `RE`, and most metadata. */
export function decodeSimpleText(raw: string): string {
  return decodeTextValue(raw, 'simple')
}

/**
 * Expands a `Point` or compressed point list entry.
 *
 * FF[4] allows `[aa:cc]` for a rectangle, which real editors emit for large
 * setups. An implementation that reads only single points silently loses most
 * of a handicap or problem diagram.
 *
 * Off-board coordinates are re-thrown as `SGF_INVALID_PROPERTY`, matching
 * `getMove`. `fromSgf` raises `CoordError`, whose own code is
 * `BOARD_INVALID_COORD` — correct for its module, wrong here, because at this
 * layer the coordinate came out of a file and the file is what is malformed.
 * Letting it escape would mean the same failure surfaces as `SGF_INVALID_PROPERTY`
 * from `B[rs]` and `BOARD_INVALID_COORD` from `AB[rs]`, so a caller branching on
 * the code would miss half the cases and the user would see board-bug text for a
 * bad file.
 */
function decodePointEntry(raw: string, size: BoardSize): Coord[] {
  try {
    return decodePointEntryUnchecked(raw, size)
  } catch (error) {
    if (isAppError(error)) throw error
    // `describeValue` on both the message and the context: `toEnvelope` strips
    // `cause`, but it forwards `message` verbatim and cannot strip it, so an
    // unbounded value quoted here is an unbounded envelope.
    const shown = describeValue(raw)
    throw new AppError(
      'SGF_INVALID_PROPERTY',
      `point ${JSON.stringify(shown)} is not on the board`,
      { cause: error, context: { value: shown } },
    )
  }
}

function decodePointEntryUnchecked(raw: string, size: BoardSize): Coord[] {
  const separator = raw.indexOf(':')
  if (separator < 0) {
    const single = fromSgf(raw, size)
    return single === null ? [] : [single]
  }

  const from = fromSgf(raw.slice(0, separator), size)
  const to = fromSgf(raw.slice(separator + 1), size)
  if (from === null || to === null) {
    throw new AppError(
      'SGF_INVALID_PROPERTY',
      `malformed point range ${JSON.stringify(describeValue(raw))}`,
    )
  }

  const out: Coord[] = []
  // Corners may be given in either order — `[cc:aa]` is the same rectangle.
  for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y += 1) {
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x += 1) {
      out.push({ x, y })
    }
  }
  return out
}

/**
 * Expands every value of a point-list property (`AB`, `AW`, `AE`, `TR`, ...).
 *
 * Duplicates are removed. The spec forbids them, but files written by editors
 * that merge setups do contain them, and a caller placing stones would
 * otherwise do redundant work or miscount.
 */
export function decodePointList(values: readonly string[], size: BoardSize): Coord[] {
  const seen = new Set<number>()
  const out: Coord[] = []
  for (const value of values) {
    for (const coord of decodePointEntry(value, size)) {
      const index = toIndex(coord, size)
      if (seen.has(index)) continue
      seen.add(index)
      out.push(coord)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Root metadata
// ---------------------------------------------------------------------------

const boardSizeSchema = z.union([z.literal(9), z.literal(13), z.literal(19)])

/**
 * Board size from `SZ`, defaulting to 19 when absent — the SGF default for Go.
 *
 * Throws rather than degrading, and it is the one metadata field that does.
 * Every coordinate in the file is decoded relative to this number, so guessing
 * it wrong does not produce a slightly-wrong game, it produces a different
 * game that still renders.
 */
export function getBoardSize(root: SgfNode): BoardSize {
  const raw = getRawValue(root, 'SZ')
  if (raw === undefined || raw.trim() === '') return 19

  // FF[4] permits `SZ[19:9]` for a rectangular board. Rejected explicitly:
  // GoMentor's rules, scoring, and rendering all assume square.
  if (raw.includes(':')) {
    const [width, height] = raw.split(':')
    if (width?.trim() !== height?.trim()) {
      // Both dimensions described numerically rather than the raw value quoted:
      // `SZ` is a number field, so `19:9` reports as `19:9` while a value
      // carrying file text reports as `<not a number>:<not a number>`. The
      // diagnostic loses nothing — which pair of dimensions was rejected is the
      // entire content — and nothing verbatim from the file reaches a log.
      const shown = `${describeNumeric(width ?? '')}:${describeNumeric(height ?? '')}`
      throw new AppError(
        'SGF_UNSUPPORTED_BOARD_SIZE',
        `rectangular board ${shown} is not supported`,
        {
          context: { size: shown },
        },
      )
    }
  }

  const numeric = Number(
    raw.includes(':') ? raw.slice(0, raw.indexOf(':')).trim() : raw.trim(),
  )
  const parsed = boardSizeSchema.safeParse(numeric)
  if (!parsed.success) {
    // `describeNumeric`, not `describeValue`: a board size that is out of range
    // is fully described by the number itself (`7`, `38`), and one that is not a
    // number at all is fully described by saying so. Quoting up to 16 raw
    // characters here would put file text in an envelope for no diagnostic gain.
    const shown = describeNumeric(raw)
    throw new AppError(
      'SGF_UNSUPPORTED_BOARD_SIZE',
      `board size ${shown} is not 9, 13, or 19`,
      {
        context: { size: shown },
      },
    )
  }
  return parsed.data
}

/** `KM`. Absent or unparseable reads as undefined, not as the 6.5 default. */
export function getKomi(root: SgfNode): number | undefined {
  return decodeReal(getRawValue(root, 'KM'))
}

/**
 * `HA`. Handicap 1 is not a thing, but files contain it; it is returned as
 * written rather than normalised, because the caller placing handicap stones
 * reads `AB` anyway.
 */
export function getHandicap(root: SgfNode): number | undefined {
  const value = decodeReal(getRawValue(root, 'HA'))
  if (value === undefined) return undefined
  const parsed = z.number().int().min(0).max(9).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Shared by `KM`, `HA`, and `TM`. Tolerates `0.500000` and a leading `+`. */
function decodeReal(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  // Number('') is 0 and Number('12abc') is NaN; both must read as absent.
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

function simpleTextOf(root: SgfNode, ident: string): string | undefined {
  const raw = getRawValue(root, ident)
  if (raw === undefined) return undefined
  const decoded = decodeSimpleText(raw).trim()
  // An empty value is absence, not an empty name. `PB[]` should not render as
  // a player with a blank name.
  return decoded === '' ? undefined : decoded
}

export function getPlayerName(root: SgfNode, player: Player): string | undefined {
  return simpleTextOf(root, player === 'black' ? 'PB' : 'PW')
}

export function getPlayerRank(root: SgfNode, player: Player): string | undefined {
  return simpleTextOf(root, player === 'black' ? 'BR' : 'WR')
}

export function getEvent(root: SgfNode): string | undefined {
  return simpleTextOf(root, 'EV')
}

export function getPlace(root: SgfNode): string | undefined {
  return simpleTextOf(root, 'PC')
}

export function getRuleset(root: SgfNode): string | undefined {
  return simpleTextOf(root, 'RU')
}

/**
 * `DT`, returned as a string rather than a Date.
 *
 * SGF dates are a partial-date grammar (`2005-04`, `2005-04-10,11`) and real
 * files violate even that. Parsing to a Date would have to invent a day and a
 * timezone, so the raw form is kept and only obviously-wrong text is rejected.
 */
export function getDate(root: SgfNode): string | undefined {
  const value = simpleTextOf(root, 'DT')
  if (value === undefined) return undefined
  return /^\d{4}(-\d{2}){0,2}/.test(value) ? value : undefined
}

const RESULT_PATTERN = /^([BW])\+(.*)$/i

/**
 * `RE`. `B+13.5`, `W+R`, `W+Resign`, `W+T`, `0`, `Draw`, `Void`, `?`.
 *
 * Everything else — including the mojibake `RE` in the corpus — reads as
 * undefined rather than as `unknown`, so a caller can tell "the file says the
 * outcome is unknown" from "the file's result field is unreadable".
 */
export function getResult(root: SgfNode): GameResult | undefined {
  const value = simpleTextOf(root, 'RE')
  if (value === undefined) return undefined

  const lower = value.toLowerCase()
  if (lower === '0' || lower === 'draw' || lower === 'jigo') {
    return { winner: 'draw', by: 'points' }
  }
  if (lower === '?' || lower === 'void' || lower === 'unknown') {
    return { winner: 'unknown', by: 'unknown' }
  }

  const match = RESULT_PATTERN.exec(value)
  if (match === null) return undefined

  const winner: Player = match[1]?.toUpperCase() === 'B' ? 'black' : 'white'
  const detail = (match[2] ?? '').trim().toLowerCase()

  if (detail.startsWith('r')) return { winner, by: 'resignation' }
  if (detail.startsWith('t')) return { winner, by: 'timeout' }
  if (detail.startsWith('f')) return { winner, by: 'forfeit' }
  if (detail === '') return { winner, by: 'unknown' }

  const score = decodeReal(detail)
  // `W+something-unrecognised` is a readable winner with an unreadable margin,
  // which is still more than nothing.
  return score === undefined
    ? { winner, by: 'unknown' }
    : { winner, score, by: 'points' }
}

// ---------------------------------------------------------------------------
// Node contents
// ---------------------------------------------------------------------------

/**
 * The move in a node, or null if it has none.
 *
 * A pass is `coord: null` — SGF writes it as `B[]`, and older files as `B[tt]`
 * on boards up to 19x19. Both are handled by `fromSgf`.
 *
 * Throws `SGF_INVALID_PROPERTY` on an off-board coordinate. That is not
 * defensive pedantry: `B[rs]` on a 9x9 board appears in the corpus, and the
 * alternatives are to drop the move (the rest of the game then replays onto
 * the wrong position) or to treat it as a pass (which changes whose turn it
 * is). Both produce a plausible-looking wrong board.
 */
export function getMove(node: SgfNode, size: BoardSize): NodeMove | null {
  // B and W in one node is illegal; black wins the tie so the result is at
  // least deterministic.
  const black = getProperty(node, 'B')
  const white = black === undefined ? getProperty(node, 'W') : undefined
  const property = black ?? white
  if (property === undefined) return null

  const player: Player = property === black ? 'black' : 'white'
  const raw = property.values[0] ?? ''

  try {
    return { player, coord: fromSgf(raw.trim(), size) }
  } catch (error) {
    const shown = describeValue(raw)
    throw new AppError(
      'SGF_INVALID_PROPERTY',
      `move ${JSON.stringify(shown)} is not on the board`,
      {
        cause: error,
        context: { ident: describeValue(property.rawIdent), value: shown },
      },
    )
  }
}

/** Setup stones and erasures: `AB`, `AW`, `AE`. */
export function getSetup(
  node: SgfNode,
  size: BoardSize,
): { black: Coord[]; white: Coord[]; erase: Coord[] } {
  return {
    black: decodePointList(getProperty(node, 'AB')?.values ?? [], size),
    white: decodePointList(getProperty(node, 'AW')?.values ?? [], size),
    erase: decodePointList(getProperty(node, 'AE')?.values ?? [], size),
  }
}

/** `PL` — whose turn it is, when the file says so explicitly. */
export function getPlayerToMove(node: SgfNode): Player | undefined {
  const raw = getRawValue(node, 'PL')?.trim().toUpperCase()
  if (raw === 'B' || raw === '1') return 'black'
  if (raw === 'W' || raw === '2') return 'white'
  return undefined
}

/** `C` — the node comment, with escapes and soft line breaks resolved. */
export function getComment(node: SgfNode): string | undefined {
  const raw = getRawValue(node, 'C')
  if (raw === undefined) return undefined
  const decoded = decodeText(raw)
  return decoded === '' ? undefined : decoded
}

/** `N` — a short label for the node, shown in move-tree UI. */
export function getNodeName(node: SgfNode): string | undefined {
  return simpleTextOf(node, 'N')
}
