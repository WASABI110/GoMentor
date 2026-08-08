import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { Position } from '../../src/board/position'
import { hashPosition, stoneKey, toggleStone, withTurn } from '../../src/board/zobrist'

/**
 * Zobrist hashing.
 *
 * Two distinct things are tested here, and conflating them is how this kind of
 * hash quietly breaks:
 *
 * 1. **Algebraic properties** (property-based). XOR self-inverse, order
 *    independence, collision behaviour.
 * 2. **Stability of specific values** (golden values). The pattern index in M3
 *    persists these numbers to disk, so a change of seed or generator must fail
 *    loudly rather than invalidate stored rows while still appearing to work.
 *
 * The golden values below are therefore **a persistence format**, not a
 * convenience snapshot. Regenerating them to make a red test green is a data
 * migration.
 */

const SIZES: BoardSize[] = [9, 13, 19]

function coordArb(size: BoardSize): fc.Arbitrary<Coord> {
  return fc.record({
    x: fc.integer({ min: 0, max: size - 1 }),
    y: fc.integer({ min: 0, max: size - 1 }),
  })
}

const playerArb: fc.Arbitrary<Player> = fc.constantFrom('black', 'white')

describe('golden values', () => {
  /**
   * If one of these fails, the question to ask is not "what should the new
   * value be" but "was the table meant to change". A deliberate change means
   * migrating or rebuilding whatever index stored the old numbers.
   */
  it('produces stable stone keys', () => {
    expect(stoneKey({ x: 0, y: 0 }, 'black', 19).toString(16)).toBe('b9f81b82d2b37edc')
    expect(stoneKey({ x: 0, y: 0 }, 'white', 19).toString(16)).toBe('296e12f01d2c2d46')
    expect(stoneKey({ x: 18, y: 18 }, 'white', 19).toString(16)).toBe(
      '8bd88f4dbb2e5e0a',
    )
  })

  it('produces stable empty-board hashes per size', () => {
    expect(hashPosition(Position.empty(9)).toString(16)).toBe('32e641be4faa96bf')
    expect(hashPosition(Position.empty(13)).toString(16)).toBe('48f4b6078ec8b313')
    expect(hashPosition(Position.empty(19)).toString(16)).toBe('9f67f6372cc4f0e1')
  })

  it('produces a stable hash for a position with a stone', () => {
    const position = Position.empty(19).place({ x: 3, y: 3 }, 'black').position
    expect(hashPosition(position).toString(16)).toBe('84fff37b1fc513ec')
    expect(withTurn(hashPosition(position), 'white').toString(16)).toBe(
      '9fab243e87c4d539',
    )
  })

  it('keeps every key non-zero and distinct', () => {
    // A zero key is invisible under XOR, and a duplicate makes two different
    // positions hash the same. Either is a silent correctness failure.
    const seen = new Set<string>()
    for (const size of SIZES) {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          for (const player of ['black', 'white'] as const) {
            const key = stoneKey({ x, y }, player, size)
            expect(key, `key for (${String(x)},${String(y)}) ${player}`).not.toBe(0n)
            seen.add(key.toString(16))
          }
        }
      }
    }
    // 19x19 dominates; smaller boards reuse the same keys by design, so the
    // distinct count is exactly the 19x19 table.
    expect(seen.size).toBe(19 * 19 * 2)
  })

  it('fits every key in 64 bits', () => {
    const limit = 1n << 64n
    for (let y = 0; y < 19; y += 1) {
      for (let x = 0; x < 19; x += 1) {
        expect(stoneKey({ x, y }, 'black', 19)).toBeLessThan(limit)
        expect(stoneKey({ x, y }, 'black', 19)).toBeGreaterThan(0n)
      }
    }
  })
})

describe('board sizes do not collide', () => {
  it('hashes empty boards of different sizes differently', () => {
    // Without a per-size salt these would all be 0n, so every empty board would
    // look like every other — and in the pattern index, a 9x9 corner shape
    // would match a 19x19 one.
    const hashes = SIZES.map((size) => hashPosition(Position.empty(size)))
    expect(new Set(hashes.map(String)).size).toBe(SIZES.length)
  })

  it('hashes the same stone placement differently across sizes', () => {
    const placed = SIZES.map((size) =>
      hashPosition(Position.empty(size).place({ x: 2, y: 2 }, 'black').position),
    )
    expect(new Set(placed.map(String)).size).toBe(SIZES.length)
  })
})

describe('algebraic properties', () => {
  it('is self-inverse under toggle', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SIZES), playerArb, (size, player) => {
        fc.assert(
          fc.property(coordArb(size), (coord) => {
            const base = hashPosition(Position.empty(size))
            const once = toggleStone(base, coord, player, size)
            expect(toggleStone(once, coord, player, size)).toBe(base)
          }),
          { numRuns: 20 },
        )
      }),
      { numRuns: 10 },
    )
  })

  it('is independent of the order stones are added', () => {
    // The property that makes incremental updates safe: reaching a position by
    // a different move order must give the same hash, or superko detection
    // depends on how the game got there.
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            coord: fc.record({
              x: fc.integer({ min: 0, max: 8 }),
              y: fc.integer({ min: 0, max: 8 }),
            }),
            player: playerArb,
          }),
          {
            minLength: 2,
            maxLength: 12,
            selector: (s) => `${String(s.coord.x)},${String(s.coord.y)}`,
          },
        ),
        (placements) => {
          const forward = placements.reduce(
            (hash, { coord, player }) => toggleStone(hash, coord, player, 9),
            0n,
          )
          const backward = [...placements]
            .reverse()
            .reduce(
              (hash, { coord, player }) => toggleStone(hash, coord, player, 9),
              0n,
            )
          expect(forward).toBe(backward)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('matches incremental updates against a full recompute', () => {
    // The real invariant behind superko: XORing stones in one at a time must
    // land on the same number as hashing the finished board.
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            x: fc.integer({ min: 0, max: 8 }),
            y: fc.integer({ min: 0, max: 8 }),
          }),
          {
            minLength: 1,
            maxLength: 15,
            selector: (c) => `${String(c.x)},${String(c.y)}`,
          },
        ),
        (coords) => {
          // Annotated rather than `as Player`: inside an object literal the
          // ternary widens to `string`, and eslint flags the assertion as
          // unnecessary while tsc rejects the code without it.
          const placements: { coord: Coord; player: Player }[] = coords.map(
            (coord, index) => ({
              coord,
              player: index % 2 === 0 ? 'black' : 'white',
            }),
          )

          const position = Position.empty(9).setup(placements)
          const incremental = placements.reduce(
            (hash, { coord, player }) => toggleStone(hash, coord, player, 9),
            hashPosition(Position.empty(9)),
          )

          expect(incremental).toBe(hashPosition(position))
        },
      ),
      { numRuns: 100 },
    )
  })

  it('distinguishes colour at the same point', () => {
    fc.assert(
      fc.property(coordArb(19), (coord) => {
        expect(stoneKey(coord, 'black', 19)).not.toBe(stoneKey(coord, 'white', 19))
      }),
      { numRuns: 50 },
    )
  })

  it('changes the hash when the player to move changes', () => {
    const base = hashPosition(Position.empty(19))
    expect(withTurn(base, 'black')).not.toBe(withTurn(base, 'white'))
  })

  it('leaves the black-to-move hash equal to the bare position hash', () => {
    // Deliberate: black-to-move is the default, so a positional hash and a
    // situational one agree there. Documented rather than incidental.
    const base = hashPosition(Position.empty(19))
    expect(withTurn(base, 'black')).toBe(base)
  })
})

describe('hashing real play', () => {
  it('returns to the prior hash after a capture undoes a stone', () => {
    /**
     * The case that motivates incremental hashing. White plays into a shape
     * where black immediately recaptures; the board returns to a previous
     * arrangement, and the hash must return with it — this is exactly what
     * superko detection reads.
     */
    const setup: { coord: Coord; player: Player }[] = [
      { coord: { x: 2, y: 0 }, player: 'white' },
      { coord: { x: 1, y: 1 }, player: 'white' },
      { coord: { x: 2, y: 2 }, player: 'white' },
      { coord: { x: 3, y: 0 }, player: 'black' },
      { coord: { x: 4, y: 1 }, player: 'black' },
      { coord: { x: 3, y: 2 }, player: 'black' },
      { coord: { x: 3, y: 1 }, player: 'white' },
    ]
    const start = Position.empty(9).setup(setup)

    const afterBlack = start.place({ x: 2, y: 1 }, 'black')
    expect(afterBlack.captured).toEqual([{ x: 3, y: 1 }])

    // Hash of the board with black at (2,1) and white's stone gone.
    const hashAfter = hashPosition(afterBlack.position)

    // Reconstruct the same arrangement by a different route and compare.
    const rebuilt = Position.empty(9).setup([
      ...setup.filter((s) => !(s.coord.x === 3 && s.coord.y === 1)),
      { coord: { x: 2, y: 1 }, player: 'black' },
    ])
    expect(hashPosition(rebuilt)).toBe(hashAfter)
  })

  it('gives a different hash to positions differing by one stone', () => {
    const a = Position.empty(19).place({ x: 3, y: 3 }, 'black').position
    const b = Position.empty(19).place({ x: 3, y: 3 }, 'white').position
    const c = Position.empty(19).place({ x: 15, y: 3 }, 'black').position
    expect(new Set([a, b, c].map((p) => hashPosition(p).toString(16))).size).toBe(3)
  })

  it('has no collisions across a full game replay', () => {
    // Not a proof of collision resistance — a sanity check that nothing
    // pathological (all keys equal, salt swamping the stones) is happening.
    let position = Position.empty(9)
    const seen = new Set<string>([hashPosition(position).toString(16)])
    const moves: [number, number][] = [
      [2, 2],
      [6, 6],
      [2, 6],
      [6, 2],
      [4, 4],
      [3, 3],
      [5, 5],
      [1, 1],
      [7, 7],
      [0, 0],
      [8, 8],
      [4, 0],
      [0, 4],
      [8, 4],
      [4, 8],
    ]
    moves.forEach(([x, y], index) => {
      position = position.place({ x, y }, index % 2 === 0 ? 'black' : 'white').position
      seen.add(hashPosition(position).toString(16))
    })
    expect(seen.size).toBe(moves.length + 1)
  })
})
