import { GTP_COLUMNS, SGF_COLUMNS, type BoardSize, type Coord } from '@gomentor/shared'

/**
 * Coordinate conversions between the four systems this app touches.
 *
 * The canonical form is `Coord { x, y }`, zero-indexed from the **top-left**.
 * Everything converts through it; no conversion goes directly between two
 * non-canonical forms.
 *
 * The three systems it converts to:
 *
 * - **SGF**: two lowercase letters, `a`-`s`, column then row, from top-left.
 *   Does not skip any letter. `dp` is column 3, row 15.
 * - **GTP**: an uppercase column letter plus a 1-based row number counted from
 *   the **bottom**. Crucially, **GTP skips `I`** — columns run
 *   A B C D E F G H J K L M N O P Q R S T. So `J4` is column index 8, not 9.
 * - **Pixel**: for canvas rendering, with device-pixel-ratio awareness handled
 *   by the caller.
 *
 * The `I`-skip and the vertical flip are why this module is property-tested
 * over every point on every board size rather than a handful of examples.
 */

/**
 * A coordinate that cannot be converted.
 *
 * Carries a `code` like every other error in the app (`error-handling.md`:
 * "Every error crossing a boundary has a `code`"). The code is `BOARD_` and not
 * `SGF_` because this module is `board/`: it is reached from GTP move encoding,
 * canvas geometry, and flat-index conversion, none of which involve a file. An
 * earlier version hardcoded `SGF_INVALID_PROPERTY` here, which made
 * `encodeMove({x:12,y:3}, 9)` report a malformed *file* — and since the renderer
 * translates `code` through the `errors` i18n namespace, that is not a
 * mislabelled log line but wrong text shown to the user.
 *
 * Deliberately **not** a subclass of `AppError`: `isAppError` is an `instanceof`
 * check, and `props.ts` relies on this *not* matching so that a bad coordinate
 * inside an SGF file is re-thrown as `SGF_INVALID_PROPERTY`. That conversion is
 * what keeps the file case correct while this default stays board-level; making
 * this an `AppError` would silently turn it off and split one malformed-file
 * failure across two codes.
 *
 * Messages here are bounded (`describeCoordValue`) because callers pass raw file
 * text straight in — `fromSgf(rawPropertyValue)` — and `props.ts` attaches this
 * as `cause`. `AppError.toEnvelope()` strips `cause`, so the renderer is safe,
 * but `logging-guidelines.md:54` logs `cause` in main, and line 76 puts SGF
 * content out of bounds for logging at any level. An unbounded value quoted here
 * was reaching that log: a 4000-character `AB[…]` produced a 4058-character
 * `cause` message carrying the file's text verbatim.
 */
export class CoordError extends Error {
  readonly code: 'BOARD_INVALID_COORD'

  constructor(message: string) {
    super(message)
    this.name = 'CoordError'
    this.code = 'BOARD_INVALID_COORD'
  }
}

/**
 * Caps a value quoted in a `CoordError`.
 *
 * Same rule and same reasoning as `sgf/diagnostic.ts`, kept local rather than
 * imported: `board/` must not depend on `sgf/`, since coordinates are also
 * converted for GTP vertices that never came from a file. A legal SGF point is
 * 2 characters and a GTP vertex at most 3, so 8 is already generous; anything
 * longer is the anomaly itself and its length is the useful fact.
 */
function describeCoordValue(value: string): string {
  return value.length <= 8
    ? JSON.stringify(value)
    : `<${String(value.length)} characters>`
}

function assertInBounds(coord: Coord, size: BoardSize): void {
  if (
    !Number.isInteger(coord.x) ||
    !Number.isInteger(coord.y) ||
    coord.x < 0 ||
    coord.y < 0 ||
    coord.x >= size ||
    coord.y >= size
  ) {
    throw new CoordError(
      `coord (${String(coord.x)},${String(coord.y)}) is outside a ${String(size)}x${String(size)} board`,
    )
  }
}

// ---------------------------------------------------------------------------
// SGF
// ---------------------------------------------------------------------------

/** `{x:3,y:15}` → `"dp"`. */
export function toSgf(coord: Coord, size: BoardSize): string {
  assertInBounds(coord, size)
  const col = SGF_COLUMNS[coord.x]
  const row = SGF_COLUMNS[coord.y]
  if (col === undefined || row === undefined) {
    throw new CoordError(`no SGF letter for (${String(coord.x)},${String(coord.y)})`)
  }
  return `${col}${row}`
}

/**
 * `"dp"` → `{x:3,y:15}`.
 *
 * An empty string is a **pass** in SGF, and so is `"tt"` on boards up to 19x19
 * in older files. Both return `null` — a pass is not a coordinate, and
 * conflating it with (0,0) or (19,19) is a real historical bug.
 */
export function fromSgf(value: string, size: BoardSize): Coord | null {
  if (value === '') return null
  // 'tt' is the legacy pass encoding, valid only when it is off-board.
  if (value === 'tt' && size <= 19) return null

  if (value.length !== 2) {
    throw new CoordError(
      `SGF coordinate must be 2 chars, got ${describeCoordValue(value)}`,
    )
  }

  const x = SGF_COLUMNS.indexOf(value[0] ?? '')
  const y = SGF_COLUMNS.indexOf(value[1] ?? '')
  if (x < 0 || y < 0) {
    throw new CoordError(`invalid SGF coordinate ${describeCoordValue(value)}`)
  }

  const coord = { x, y }
  assertInBounds(coord, size)
  return coord
}

// ---------------------------------------------------------------------------
// GTP
// ---------------------------------------------------------------------------

/**
 * `{x:3,y:15}` on 19x19 → `"D4"`.
 *
 * Two transformations at once: the column letter skips `I`, and the row is
 * 1-based counted from the bottom, so it inverts y.
 */
export function toGtp(coord: Coord, size: BoardSize): string {
  assertInBounds(coord, size)
  const col = GTP_COLUMNS[coord.x]
  if (col === undefined) {
    throw new CoordError(`no GTP column for x=${String(coord.x)}`)
  }
  // GTP row 1 is the bottom of the board; our y=0 is the top.
  const row = size - coord.y
  return `${col}${String(row)}`
}

/** `"D4"` on 19x19 → `{x:3,y:15}`. `"pass"` (any case) → `null`. */
export function fromGtp(value: string, size: BoardSize): Coord | null {
  const trimmed = value.trim()
  if (trimmed.toLowerCase() === 'pass') return null

  const match = /^([A-Za-z])(\d{1,2})$/.exec(trimmed)
  if (!match) {
    throw new CoordError(`invalid GTP coordinate ${describeCoordValue(value)}`)
  }

  const letter = (match[1] ?? '').toUpperCase()
  // indexOf against the I-skipping alphabet is what makes 'I' rejected and
  // 'J' map to 8 rather than 9.
  const x = GTP_COLUMNS.indexOf(letter)
  if (x < 0) {
    throw new CoordError(
      `invalid GTP column ${describeCoordValue(letter)} — note GTP skips 'I'`,
    )
  }

  const row = Number.parseInt(match[2] ?? '', 10)
  const y = size - row

  const coord = { x, y }
  assertInBounds(coord, size)
  return coord
}

// ---------------------------------------------------------------------------
// Pixel
// ---------------------------------------------------------------------------

export interface BoardGeometry {
  /** Distance from the canvas edge to the first line, in CSS px. */
  padding: number
  /** Distance between adjacent lines, in CSS px. */
  spacing: number
}

/**
 * Computes geometry that fits `size` lines into `available` CSS px, reserving
 * a margin for coordinate labels and the outer stones' overhang.
 */
export function computeGeometry(available: number, size: BoardSize): BoardGeometry {
  if (available <= 0) {
    throw new CoordError(`available space must be positive, got ${String(available)}`)
  }
  // Half a cell at each edge for stone overhang, plus a cell for labels.
  const cells = size + 1
  const spacing = available / cells
  return { padding: spacing, spacing }
}

/** Board intersection → canvas centre point, in CSS px. */
export function toPixel(
  coord: Coord,
  size: BoardSize,
  geometry: BoardGeometry,
): { px: number; py: number } {
  assertInBounds(coord, size)
  return {
    px: geometry.padding + coord.x * geometry.spacing,
    py: geometry.padding + coord.y * geometry.spacing,
  }
}

/**
 * Canvas point → nearest intersection, or `null` if the click landed further
 * than half a cell away (so clicks outside the grid do not place stones).
 */
export function fromPixel(
  px: number,
  py: number,
  size: BoardSize,
  geometry: BoardGeometry,
): Coord | null {
  const x = Math.round((px - geometry.padding) / geometry.spacing)
  const y = Math.round((py - geometry.padding) / geometry.spacing)

  if (x < 0 || y < 0 || x >= size || y >= size) return null

  // Reject a click that rounded to an intersection but is not actually near it.
  const nearest = toPixel({ x, y }, size, geometry)
  const dx = px - nearest.px
  const dy = py - nearest.py
  if (Math.hypot(dx, dy) > geometry.spacing / 2) return null

  return { x, y }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Row-major index into a flat board array. Used by ownership maps. */
export function toIndex(coord: Coord, size: BoardSize): number {
  assertInBounds(coord, size)
  return coord.y * size + coord.x
}

export function fromIndex(index: number, size: BoardSize): Coord {
  if (!Number.isInteger(index) || index < 0 || index >= size * size) {
    throw new CoordError(
      `index ${String(index)} out of range for ${String(size)}x${String(size)}`,
    )
  }
  return { x: index % size, y: Math.floor(index / size) }
}

/** Orthogonal neighbours, clipped to the board. Order is stable: N, E, S, W. */
export function neighbours(coord: Coord, size: BoardSize): Coord[] {
  assertInBounds(coord, size)
  const candidates = [
    { x: coord.x, y: coord.y - 1 },
    { x: coord.x + 1, y: coord.y },
    { x: coord.x, y: coord.y + 1 },
    { x: coord.x - 1, y: coord.y },
  ]
  return candidates.filter((c) => c.x >= 0 && c.y >= 0 && c.x < size && c.y < size)
}

export function coordsEqual(a: Coord | null, b: Coord | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y
}
