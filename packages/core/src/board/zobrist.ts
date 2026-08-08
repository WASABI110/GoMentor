import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { toIndex, CoordError } from './coords'
import type { Position } from './position'

/**
 * Zobrist hashing for board positions.
 *
 * Two consumers, with different needs:
 *
 * - **Superko detection.** Needs cheap incremental updates: XOR a key in when a
 *   stone appears, XOR the same key out when it is captured. Recomputing a
 *   whole-board hash per move would be O(n²) over a game.
 * - **M3's pattern index.** Needs the hash of a given position to be **the same
 *   number next month, in a different process, on a different machine** —
 *   because the index is persisted to disk. A hash that shifts between runs
 *   silently invalidates every stored row while still looking like it works.
 *
 * That second requirement is why the key table is generated from a **fixed
 * seed** by a PRNG defined here, rather than from `Math.random()` or anything
 * platform-supplied. `zobrist.test.ts` pins several table entries and whole
 * position hashes to literal values, so changing the seed or the generator
 * fails loudly instead of corrupting an index.
 *
 * Consequence worth stating plainly: **the golden values in that test are a
 * persistence format.** Changing them is a data migration, not a test update.
 */

const MASK = (1n << 64n) - 1n

/**
 * splitmix64. Chosen because it is a handful of lines with no state beyond a
 * single integer, so the table is reproducible by anyone reading this file —
 * which matters more here than statistical quality, and its quality is ample
 * for hashing anyway.
 */
function splitmix64(seed: bigint): () => bigint {
  let state = seed & MASK
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK
    let z = state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK
    return (z ^ (z >> 31n)) & MASK
  }
}

/** Arbitrary but fixed. See the note above: this value is part of a format. */
const SEED = 0x676f6d656e746f72n // "gomentor" in ASCII

const MAX_SIZE = 19
const POINTS = MAX_SIZE * MAX_SIZE

/**
 * Keys are laid out `[point][colour]` for the largest board, and smaller boards
 * index into the same table. That makes the tables consistent but means a 9x9
 * position and a 19x19 one could otherwise collide, since both start at flat
 * index 0 — hence the per-size salt below.
 */
const { stoneKeys, sizeSalt, turnKey } = ((): {
  stoneKeys: readonly bigint[]
  sizeSalt: ReadonlyMap<number, bigint>
  turnKey: bigint
} => {
  const next = splitmix64(SEED)
  const keys: bigint[] = []
  for (let i = 0; i < POINTS * 2; i += 1) keys.push(next())

  // Drawn after the stone keys so that adding a board size later cannot shift
  // any existing stone key and invalidate stored hashes.
  const salt = new Map<number, bigint>()
  for (const size of [9, 13, 19]) salt.set(size, next())

  return { stoneKeys: keys, sizeSalt: salt, turnKey: next() }
})()

function colourOffset(player: Player): 0 | 1 {
  return player === 'black' ? 0 : 1
}

/** The key for one stone. Exported so callers can XOR incrementally. */
export function stoneKey(coord: Coord, player: Player, size: BoardSize): bigint {
  const key = stoneKeys[toIndex(coord, size) * 2 + colourOffset(player)]
  if (key === undefined) {
    // Unreachable, and provably so: `toIndex` throws on an out-of-bounds coord,
    // so the largest index reachable here is (18*19+18)*2+1 = 721 against a
    // 722-entry table. Present only because `noUncheckedIndexedAccess` types
    // the lookup as possibly-undefined.
    //
    // Being dead code, no test can reach this line, so the *choice* of error
    // type here is enforced by review rather than by the suite — do not read a
    // green run as evidence about it. What the suite does pin is the premise:
    // `mutate-coord-error.mts`'s Z1 shrinks the table and 7 tests fail, so the
    // table really is large enough for every reachable index.
    //
    // Throwing rather than returning 0n regardless: a zero key is invisible
    // under XOR, so it would make two different positions hash identically.
    // A `CoordError` rather than a bare `Error` because the spec allows no
    // untyped throws — unreachable is not a licence to drop the `code`, since
    // the one thing a caller could still do with this is branch on it.
    throw new CoordError(`no zobrist key for (${String(coord.x)},${String(coord.y)})`)
  }
  return key
}

/**
 * Hash of the stones on the board. Does **not** include whose turn it is or the
 * ko point — see `withTurn` for situational hashing.
 *
 * Positional superko compares this value; the pattern index stores it.
 */
export function hashPosition(position: Position): bigint {
  let hash = sizeSalt.get(position.size) ?? 0n
  const stones = position.toArray()
  for (let index = 0; index < stones.length; index += 1) {
    const stone = stones[index]
    if (stone === null || stone === undefined) continue
    const key = stoneKeys[index * 2 + colourOffset(stone)]
    if (key === undefined) continue
    hash ^= key
  }
  return hash
}

/**
 * Folds the player to move into a hash.
 *
 * The distinction is not academic: *positional* superko compares stone
 * placement alone, *situational* superko treats the same placement with
 * different players to move as different states. Japanese and Chinese rules
 * differ on this, so the choice belongs to the caller rather than being baked
 * into `hashPosition`.
 */
export function withTurn(hash: bigint, player: Player): bigint {
  return player === 'black' ? hash : hash ^ turnKey
}

/**
 * Applies one stone to a hash, incrementally.
 *
 * XOR is its own inverse, so this both adds and removes: call it with the same
 * arguments to undo. That is what makes capture cheap — XOR out each captured
 * stone rather than rebuilding.
 */
export function toggleStone(
  hash: bigint,
  coord: Coord,
  player: Player,
  size: BoardSize,
): bigint {
  return hash ^ stoneKey(coord, player, size)
}
