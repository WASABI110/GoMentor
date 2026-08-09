import type { SgfCollection } from '@gomentor/core/sgf/ast'
import type { Game, GameSummary } from '@gomentor/shared'
import { toSummary } from '../sgf/adapter'

/**
 * In-memory game store for M1.
 *
 * M2 replaces this with SQLite. It is a module with an interface rather than a
 * bare `Map` at a call site so that replacement is a change of implementation
 * rather than a change of every handler — and so the handler tests never depend
 * on a database.
 *
 * ## Why the AST is stored alongside the Game
 *
 * `Game` is a lossy projection: no variations, no unknown properties, no
 * per-property whitespace. A5 requires a file to survive a round-trip
 * byte-for-byte, so `sgf:serialize` has to write from the AST. Storing only the
 * `Game` and reconstructing SGF from `moves` would produce a file that opens
 * fine and has quietly lost the user's variations — the exact "wrong but looks
 * right" shape the verification model exists to catch.
 *
 * ## Deduplication
 *
 * Keyed by `contentHash`, over the original bytes. Two files differing only in a
 * comment are different files a user may legitimately want both of, so the hash
 * is over the source rather than over the projection — see `adapter.ts`.
 */

export interface StoredGame {
  game: Game
  /** Retained for byte-exact serialisation. Never sent over IPC. */
  collection: SgfCollection
}

export interface GameStore {
  put(entry: StoredGame): void
  get(id: string): StoredGame | undefined
  has(id: string): boolean
  list(): GameSummary[]
  delete(id: string): boolean
  clear(): void
  readonly size: number
}

export function createGameStore(): GameStore {
  // Insertion-ordered, which `list()` relies on — see the note there.
  const games = new Map<string, StoredGame>()

  return {
    put(entry) {
      games.set(entry.game.id, entry)
    },
    get(id) {
      return games.get(id)
    },
    has(id) {
      return games.has(id)
    },
    list() {
      // Most-recent-first. `Map` iterates in insertion order, so reversing gives
      // recency without storing a timestamp — and `importedAt` would be the
      // wrong sort key anyway, since a batch import stamps them all identically.
      return [...games.values()].reverse().map((entry) => toSummary(entry.game))
    },
    delete(id) {
      return games.delete(id)
    },
    clear() {
      games.clear()
    },
    get size() {
      return games.size
    },
  }
}
