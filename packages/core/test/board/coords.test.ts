import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  AppError,
  BOARD_SIZES,
  GTP_COLUMNS,
  isAppError,
  type BoardSize,
} from '@gomentor/shared'
import {
  CoordError,
  computeGeometry,
  coordsEqual,
  fromGtp,
  fromIndex,
  fromPixel,
  fromSgf,
  neighbours,
  toGtp,
  toIndex,
  toPixel,
  toSgf,
} from '../../src/board/coords'
import { decodePointList } from '../../src/sgf/props'

/**
 * A7: round-trip identity across all board sizes, with the GTP `I`-skip
 * genuinely exercised.
 *
 * Property-based rather than example-based because the bug space is every
 * point on every board size. Examples reliably miss the `I` boundary and the
 * vertical flip — the two things that actually break.
 */

/** Every coordinate on a given board. Exhaustive, not sampled. */
function allCoords(size: BoardSize): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out.push({ x, y })
  }
  return out
}

const coordArb = (size: BoardSize) =>
  fc.record({
    x: fc.integer({ min: 0, max: size - 1 }),
    y: fc.integer({ min: 0, max: size - 1 }),
  })

describe('SGF round-trip', () => {
  for (const size of BOARD_SIZES) {
    it(`is the identity for every point on ${String(size)}x${String(size)}`, () => {
      // Exhaustive: every intersection, not a random sample.
      for (const coord of allCoords(size)) {
        const round = fromSgf(toSgf(coord, size), size)
        expect(
          round,
          `${JSON.stringify(coord)} on ${String(size)}x${String(size)}`,
        ).toEqual(coord)
      }
    })

    it(`is the identity under property-based generation on ${String(size)}x${String(size)}`, () => {
      fc.assert(
        fc.property(coordArb(size), (coord) => {
          expect(fromSgf(toSgf(coord, size), size)).toEqual(coord)
        }),
        { numRuns: 200 },
      )
    })
  }

  it('treats the empty string as a pass, not a coordinate', () => {
    expect(fromSgf('', 19)).toBeNull()
  })

  it('treats legacy "tt" as a pass on boards up to 19x19', () => {
    // Conflating this with a real point is a known historical bug.
    expect(fromSgf('tt', 19)).toBeNull()
    expect(fromSgf('tt', 9)).toBeNull()
  })

  it('uses no letter-skipping, unlike GTP', () => {
    // SGF's 9th column is 'i'. GTP's is 'J'. This is the crux of the bug class.
    expect(toSgf({ x: 8, y: 0 }, 19)).toBe('ia')
    expect(fromSgf('ia', 19)).toEqual({ x: 8, y: 0 })
  })

  it('maps the documented example dp → (3,15)', () => {
    expect(fromSgf('dp', 19)).toEqual({ x: 3, y: 15 })
    expect(toSgf({ x: 3, y: 15 }, 19)).toBe('dp')
  })

  it('rejects out-of-bounds and malformed input', () => {
    expect(() => fromSgf('zz', 19)).toThrow(CoordError)
    expect(() => fromSgf('a', 19)).toThrow(CoordError)
    expect(() => fromSgf('abc', 19)).toThrow(CoordError)
    // Valid on 19x19 but off-board on 9x9.
    expect(() => fromSgf('kk', 9)).toThrow(CoordError)
  })
})

describe('GTP round-trip', () => {
  for (const size of BOARD_SIZES) {
    it(`is the identity for every point on ${String(size)}x${String(size)}`, () => {
      for (const coord of allCoords(size)) {
        const round = fromGtp(toGtp(coord, size), size)
        expect(
          round,
          `${JSON.stringify(coord)} on ${String(size)}x${String(size)}`,
        ).toEqual(coord)
      }
    })

    it(`is the identity under property-based generation on ${String(size)}x${String(size)}`, () => {
      fc.assert(
        fc.property(coordArb(size), (coord) => {
          expect(fromGtp(toGtp(coord, size), size)).toEqual(coord)
        }),
        { numRuns: 200 },
      )
    })
  }

  describe('the I-skip', () => {
    // This block is the reason A7 is a stage-gate criterion. A coords test
    // that never crosses 'I' has not tested the thing that breaks.

    it('never emits the letter I for any point on any board size', () => {
      for (const size of BOARD_SIZES) {
        for (const coord of allCoords(size)) {
          expect(
            toGtp(coord, size),
            `${JSON.stringify(coord)} on ${String(size)}`,
          ).not.toMatch(/I/)
        }
      }
    })

    it('rejects I as an input column', () => {
      expect(() => fromGtp('I4', 19)).toThrow(CoordError)
      expect(() => fromGtp('i4', 19)).toThrow(CoordError)
    })

    it('maps H → 7 and J → 8, with no index consumed by I', () => {
      // The exact off-by-one that the skip exists to create.
      expect(fromGtp('H1', 19)).toEqual({ x: 7, y: 18 })
      expect(fromGtp('J1', 19)).toEqual({ x: 8, y: 18 })
      expect(toGtp({ x: 7, y: 18 }, 19)).toBe('H1')
      expect(toGtp({ x: 8, y: 18 }, 19)).toBe('J1')
    })

    it('diverges from SGF exactly at column index 8', () => {
      // Below the skip the two systems agree on letter position; at and above
      // it they do not. Asserting both sides pins the boundary.
      for (let x = 0; x < 8; x++) {
        const gtpLetter = toGtp({ x, y: 18 }, 19)[0]
        const sgfLetter = toSgf({ x, y: 18 }, 19)[0]
        expect(gtpLetter?.toLowerCase()).toBe(sgfLetter)
      }
      for (let x = 8; x < 19; x++) {
        const gtpLetter = toGtp({ x, y: 18 }, 19)[0]
        const sgfLetter = toSgf({ x, y: 18 }, 19)[0]
        expect(gtpLetter?.toLowerCase()).not.toBe(sgfLetter)
      }
    })

    it('has an I-free column alphabet of exactly 19 letters', () => {
      expect(GTP_COLUMNS).not.toContain('I')
      expect(GTP_COLUMNS.length).toBe(19)
    })
  })

  describe('the vertical flip', () => {
    it('puts row 1 at the bottom of the board', () => {
      // y=0 is our top; GTP row 1 is the bottom. Both extremes asserted.
      expect(toGtp({ x: 0, y: 0 }, 19)).toBe('A19')
      expect(toGtp({ x: 0, y: 18 }, 19)).toBe('A1')
      expect(fromGtp('A19', 19)).toEqual({ x: 0, y: 0 })
      expect(fromGtp('A1', 19)).toEqual({ x: 0, y: 18 })
    })

    it('flips relative to board size, not a constant', () => {
      // A hardcoded 19 here would silently break 9x9 and 13x13.
      expect(toGtp({ x: 0, y: 0 }, 9)).toBe('A9')
      expect(toGtp({ x: 0, y: 0 }, 13)).toBe('A13')
    })
  })

  it('treats "pass" as a pass, case-insensitively', () => {
    expect(fromGtp('pass', 19)).toBeNull()
    expect(fromGtp('PASS', 19)).toBeNull()
    expect(fromGtp('  Pass  ', 19)).toBeNull()
  })

  it('maps the documented example D4 → (3,15) on 19x19', () => {
    expect(fromGtp('D4', 19)).toEqual({ x: 3, y: 15 })
    expect(toGtp({ x: 3, y: 15 }, 19)).toBe('D4')
  })

  it('rejects out-of-bounds and malformed input', () => {
    expect(() => fromGtp('A20', 19)).toThrow(CoordError)
    expect(() => fromGtp('A0', 19)).toThrow(CoordError)
    expect(() => fromGtp('U1', 19)).toThrow(CoordError)
    expect(() => fromGtp('44', 19)).toThrow(CoordError)
    expect(() => fromGtp('', 19)).toThrow(CoordError)
    // Valid on 19x19, off-board on 9x9.
    expect(() => fromGtp('A10', 9)).toThrow(CoordError)
  })
})

describe('cross-system consistency', () => {
  it('SGF and GTP agree on the same intersection for every point', () => {
    // Independent conversions of one coord must describe the same place.
    for (const size of BOARD_SIZES) {
      for (const coord of allCoords(size)) {
        const viaSgf = fromSgf(toSgf(coord, size), size)
        const viaGtp = fromGtp(toGtp(coord, size), size)
        expect(
          coordsEqual(viaSgf, viaGtp),
          `disagreement at ${JSON.stringify(coord)}`,
        ).toBe(true)
      }
    }
  })
})

describe('flat index round-trip', () => {
  for (const size of BOARD_SIZES) {
    it(`is the identity on ${String(size)}x${String(size)}`, () => {
      for (const coord of allCoords(size)) {
        expect(fromIndex(toIndex(coord, size), size)).toEqual(coord)
      }
    })
  }

  it('is row-major, matching KataGo ownership arrays', () => {
    expect(toIndex({ x: 0, y: 0 }, 19)).toBe(0)
    expect(toIndex({ x: 1, y: 0 }, 19)).toBe(1)
    expect(toIndex({ x: 0, y: 1 }, 19)).toBe(19)
    expect(toIndex({ x: 18, y: 18 }, 19)).toBe(360)
  })

  it('rejects out-of-range indices', () => {
    expect(() => fromIndex(361, 19)).toThrow(CoordError)
    expect(() => fromIndex(-1, 19)).toThrow(CoordError)
    expect(() => fromIndex(1.5, 19)).toThrow(CoordError)
  })
})

describe('pixel round-trip', () => {
  const geometry = computeGeometry(760, 19)

  it('recovers the coordinate from its own centre point', () => {
    for (const coord of allCoords(19)) {
      const { px, py } = toPixel(coord, 19, geometry)
      expect(fromPixel(px, py, 19, geometry)).toEqual(coord)
    }
  })

  it('tolerates a click near an intersection', () => {
    const { px, py } = toPixel({ x: 4, y: 4 }, 19, geometry)
    const nudge = geometry.spacing * 0.3
    expect(fromPixel(px + nudge, py, 19, geometry)).toEqual({ x: 4, y: 4 })
  })

  it('rejects a click that is not near any intersection', () => {
    // Rounding alone would snap this to a point; the distance check must not.
    const a = toPixel({ x: 4, y: 4 }, 19, geometry)
    const b = toPixel({ x: 5, y: 5 }, 19, geometry)
    const midX = (a.px + b.px) / 2
    const midY = (a.py + b.py) / 2
    expect(fromPixel(midX, midY, 19, geometry)).toBeNull()
  })

  it('rejects clicks outside the grid', () => {
    expect(fromPixel(-100, -100, 19, geometry)).toBeNull()
    expect(fromPixel(10_000, 10_000, 19, geometry)).toBeNull()
  })

  it('scales with available space and board size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 4000 }),
        fc.constantFrom(...BOARD_SIZES),
        (available, size) => {
          const geo = computeGeometry(available, size)
          for (const coord of [
            { x: 0, y: 0 },
            { x: size - 1, y: size - 1 },
          ]) {
            const { px, py } = toPixel(coord, size, geo)
            expect(fromPixel(px, py, size, geo)).toEqual(coord)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('rejects non-positive available space', () => {
    expect(() => computeGeometry(0, 19)).toThrow(CoordError)
    expect(() => computeGeometry(-5, 19)).toThrow(CoordError)
  })
})

describe('neighbours', () => {
  it('returns 4 for a centre point, 3 for an edge, 2 for a corner', () => {
    expect(neighbours({ x: 9, y: 9 }, 19)).toHaveLength(4)
    expect(neighbours({ x: 0, y: 9 }, 19)).toHaveLength(3)
    expect(neighbours({ x: 0, y: 0 }, 19)).toHaveLength(2)
    expect(neighbours({ x: 18, y: 18 }, 19)).toHaveLength(2)
  })

  it('never returns an off-board point, on any size', () => {
    for (const size of BOARD_SIZES) {
      for (const coord of allCoords(size)) {
        for (const n of neighbours(coord, size)) {
          expect(n.x).toBeGreaterThanOrEqual(0)
          expect(n.y).toBeGreaterThanOrEqual(0)
          expect(n.x).toBeLessThan(size)
          expect(n.y).toBeLessThan(size)
        }
      }
    }
  })

  it('is symmetric: if b neighbours a, a neighbours b', () => {
    for (const coord of allCoords(9)) {
      for (const n of neighbours(coord, 9)) {
        expect(neighbours(n, 9).some((c) => coordsEqual(c, coord))).toBe(true)
      }
    }
  })
})

describe('coordsEqual', () => {
  it('treats two passes as equal and a pass as unequal to a point', () => {
    expect(coordsEqual(null, null)).toBe(true)
    expect(coordsEqual(null, { x: 0, y: 0 })).toBe(false)
    expect(coordsEqual({ x: 0, y: 0 }, null)).toBe(false)
    expect(coordsEqual({ x: 3, y: 4 }, { x: 3, y: 4 })).toBe(true)
    expect(coordsEqual({ x: 3, y: 4 }, { x: 4, y: 3 })).toBe(false)
  })
})

describe('CoordError does not leak file content', () => {
  /**
   * `fromSgf` is called with raw property values straight out of a file, and
   * `props.ts` attaches the resulting `CoordError` as `cause` on an `AppError`.
   * `toEnvelope()` strips `cause`, so the renderer never sees it — but
   * `logging-guidelines.md:54` logs `cause` in main, and line 76 puts SGF
   * content out of bounds for logging at any level. So the message itself has to
   * be bounded, not just the envelope.
   */
  it('bounds the message for an oversized coordinate value', () => {
    const secret = 'PRIVATE-NOTE-' + 'x'.repeat(4000)

    let caught: unknown
    try {
      fromSgf(secret, 19)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CoordError)
    const { message } = caught as CoordError
    expect(message).not.toContain('PRIVATE')
    expect(message).not.toContain('xxxx')
    expect(message.length).toBeLessThan(80)
    // The length is kept, because at that size it is the useful fact.
    expect(message).toContain('4013')
  })

  it('still quotes a short value, which is the whole diagnostic', () => {
    // The counterweight: bounding must not become redaction of the thing worth
    // reporting. `zz` is what the user needs to see.
    let caught: unknown
    try {
      fromSgf('zz', 19)
    } catch (error) {
      caught = error
    }
    expect((caught as CoordError).message).toContain('zz')
  })

  it('carries a board-level code, not an SGF one', () => {
    // Every error in the app carries a domain-prefixed code
    // (`error-handling.md`). The prefix must match *this* module's domain:
    // `coords.ts` is `board/`, and its callers include GTP encoding and canvas
    // geometry, which have no file involved. An earlier version hardcoded
    // `SGF_INVALID_PROPERTY` here, so a geometry bug told the user their file was
    // malformed — the renderer translates `code` via i18n, so a wrong code is
    // wrong UI text, not just a wrong log line.
    let caught: unknown
    try {
      fromGtp('not-a-vertex', 19)
    } catch (error) {
      caught = error
    }
    expect((caught as CoordError).code).toBe('BOARD_INVALID_COORD')
  })

  it('keeps the SGF code on the SGF path, via props.ts', () => {
    // The other half of the same rule, and the reason the board-level default is
    // safe: when the coordinate *did* come from a file, `props.ts` converts, so
    // the user still gets a malformed-file code. Both halves are needed —
    // asserting only the board code would let someone "fix" the conversion away.
    let caught: unknown
    try {
      decodePointList(['zz'], 19)
    } catch (error) {
      caught = error
    }
    expect(isAppError(caught)).toBe(true)
    expect((caught as AppError).code).toBe('SGF_INVALID_PROPERTY')
  })

  it('is not an AppError, so props.ts keeps converting it', () => {
    // Load-bearing negative: `isAppError` is an instanceof check, and
    // `decodePointEntry` relies on this returning false. If `CoordError` ever
    // becomes an `AppError` subclass, that conversion silently stops and a bad
    // coordinate in a file escapes with `BOARD_INVALID_COORD`.
    let caught: unknown
    try {
      fromSgf('zz', 19)
    } catch (error) {
      caught = error
    }
    expect(isAppError(caught)).toBe(false)
  })

  it('reports a board code from callers that never touch a file', () => {
    // The concrete reason the code had to move out of the `SGF_` family. None of
    // these three involve a file: geometry is canvas layout, `fromIndex` is a
    // flat-array conversion, and `toGtp` is engine encoding. With the old
    // hardcoded code, every one of them told the user their SGF was malformed.
    const codes = [
      () => computeGeometry(0, 19),
      () => fromIndex(500, 19),
      () => toGtp({ x: 12, y: 3 }, 9),
    ].map((fn) => {
      try {
        fn()
        return 'no throw'
      } catch (error) {
        return (error as CoordError).code
      }
    })
    expect(codes).toEqual([
      'BOARD_INVALID_COORD',
      'BOARD_INVALID_COORD',
      'BOARD_INVALID_COORD',
    ])
  })
})
