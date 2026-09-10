import { parseSgf } from '@gomentor/core/sgf/parser'
import { serialiseToBytes } from '@gomentor/core/sgf/serializer'
import type { SgfCollection } from '@gomentor/core/sgf/ast'
import { AppError, type Game, type GameSummary } from '@gomentor/shared'
import { toSummary } from '../sgf/adapter'
import type { SqliteDatabase } from '../db/connection'

/**
 * The game store, backed by SQLite since M4.
 *
 * M1 shipped an in-memory `Map` behind this interface precisely so that
 * persistence would be a change of implementation, not a change of every
 * handler — and so that the handler tests could run without a database. The
 * original seven methods (`put/get/has/list/delete/clear/size`) keep their
 * signatures unchanged; M4 adds only the two `isMineOverride` accessors below.
 * The tests now open a real database in a temp directory instead, which is a
 * stronger equivalence proof than the Map ever offered: the same tests passed
 * against both backends.
 *
 * ## Why the AST is serialised into the `sgf` column
 *
 * `Game` is a lossy projection: no variations, no unknown properties, no
 * per-property whitespace. A5 requires a file to survive a round-trip
 * byte-for-byte, so `sgf:serialize` has to write from the AST. The column
 * therefore holds `serialiseToBytes(collection)` — the encoding-preserving
 * serializer, not the string form, because a Shift_JIS or GB18030 record must
 * come back out in its original codepage, and a string column value would
 * have silently rewritten it as UTF-8 — the exact "wrong but looks right"
 * defect `serialiseToBytes` exists to prevent. `get()` re-parses the bytes
 * through the normal BOM/`CA`-honouring path. Byte-exactness of the round
 * trip is the A5 property the corpus tests already pin; the store test
 * asserts the stronger consequence directly (`put` → `get` → serialise
 * equals the bytes that went in). Storing the AST as JSON instead would be
 * several times larger per game and would create a second serialised form of
 * a game record, which is exactly the drift this module prevents.
 *
 * ## `list()` ordering: most-recent-first, deterministically
 *
 * The Map version relied on insertion order reversed — no timestamp involved,
 * because a batch import stamps every `importedAt` identically. The SQL
 * version orders by `imported_at DESC` (the same intent) with `rowid DESC` as
 * the tie-break: within one import batch, later inserts still list first, so
 * the observable order matches the Map's. `rowid` is why `games` is not
 * `WITHOUT ROWID`.
 *
 * ## Re-import semantics (same id, `put` twice)
 *
 * - Same `contentHash` (the `sgf:parse` re-put of known content): the row is
 *   updated in place; `is_mine_override` and analysis rows are untouched.
 * - Different `contentHash` (same id, new content): the row is deleted first,
 *   which cascades to `analysis` and `batch_state` — the invalidation rule
 *   Stage 2's batch layer relies on, implemented here so it cannot be
 *   forgotten there. The re-inserted row takes a new `rowid`, i.e. it moves to
 *   the front of `list()` where the Map version kept its old slot. The import
 *   handler dedupes on hash before ever calling `put`, so this path is not
 *   reachable through IPC today; the behaviour is defined so that a future
 *   caller inherits the safe version.
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
  /**
   * The manual "this game is / is not mine" mark (M4). `undefined` = unset,
   * and name matching decides. Readers: Stage 3's `mine` predicate consumers;
   * writers: a Stage 4 IPC handler. A pure data accessor — the priority rule
   * (override beats names) lives in `core/profile/mine.ts`, not here.
   */
  getIsMineOverride(id: string): boolean | undefined
  setIsMineOverride(id: string, value: boolean | undefined): void
}

interface GameRow {
  id: string
  content_hash: string
  sgf: Uint8Array
  game_json: string
  is_mine_override: number | null
  imported_at: string
}

export function createGameStore(db: SqliteDatabase): GameStore {
  // Prepared once: better-sqlite3 parses SQL at prepare time, and every method
  // below is a hot path (the library list renders on every app start).
  const selectRow = db.prepare<[string], GameRow>('SELECT * FROM games WHERE id = ?')
  const selectExists = db.prepare<[string], { one: number }>(
    'SELECT 1 AS one FROM games WHERE id = ?',
  )
  const selectList = db.prepare<[], { game_json: string }>(
    'SELECT game_json FROM games ORDER BY imported_at DESC, rowid DESC',
  )
  const selectOverride = db.prepare<[string], { is_mine_override: number | null }>(
    'SELECT is_mine_override FROM games WHERE id = ?',
  )
  const countAll = db.prepare<[], { total: number }>(
    'SELECT count(*) AS total FROM games',
  )

  // `is_mine_override` is deliberately absent from the DO UPDATE set: a
  // re-put of known content must not clear the user's manual mark, and the
  // insert value is NULL so a first put starts unset.
  const upsertRow = db.prepare<{
    id: string
    content_hash: string
    sgf: Uint8Array
    game_json: string
    imported_at: string
  }>(
    `INSERT INTO games (id, content_hash, sgf, game_json, is_mine_override, imported_at)
     VALUES (@id, @content_hash, @sgf, @game_json, NULL, @imported_at)
     ON CONFLICT(id) DO UPDATE SET
       content_hash = excluded.content_hash,
       sgf = excluded.sgf,
       game_json = excluded.game_json,
       imported_at = excluded.imported_at`,
  )
  const deleteRow = db.prepare('DELETE FROM games WHERE id = ?')
  const deleteAll = db.prepare('DELETE FROM games')
  const updateOverride = db.prepare(
    'UPDATE games SET is_mine_override = ? WHERE id = ?',
  )

  // The hash-change path must delete-then-insert atomically, or a crash
  // between the two loses the game outright instead of invalidating analysis.
  const putRow = db.transaction((entry: StoredGame, sgf: Uint8Array): void => {
    const existing = selectRow.get(entry.game.id)
    if (existing !== undefined && existing.content_hash !== entry.game.contentHash) {
      deleteRow.run(entry.game.id) // cascades to analysis + batch_state
    }
    upsertRow.run({
      id: entry.game.id,
      content_hash: entry.game.contentHash,
      sgf,
      game_json: JSON.stringify(entry.game),
      imported_at: entry.game.importedAt,
    })
  })

  return {
    put(entry) {
      putRow(entry, serialiseToBytes(entry.collection))
    },
    get(id) {
      const row = selectRow.get(id)
      if (row === undefined) return undefined
      return {
        game: JSON.parse(row.game_json) as Game,
        collection: parseSgf(row.sgf),
      }
    },
    has(id) {
      return selectExists.get(id) !== undefined
    },
    list() {
      // Summaries derive from the stored projection via the same `toSummary`
      // the import path used — one definition of what a summary row is.
      return selectList.all().map((row) => toSummary(JSON.parse(row.game_json) as Game))
    },
    delete(id) {
      return deleteRow.run(id).changes > 0
    },
    clear() {
      deleteAll.run()
    },
    getIsMineOverride(id) {
      const value = selectOverride.get(id)?.is_mine_override
      return value === undefined || value === null ? undefined : value === 1
    },
    setIsMineOverride(id, value) {
      // Throws on an unknown id rather than no-op: a silent no-op would hide
      // a wiring bug behind an apparently-successful mark.
      if (
        updateOverride.run(value === undefined ? null : value ? 1 : 0, id).changes === 0
      ) {
        throw new AppError('LIBRARY_NOT_FOUND', 'no such game', {
          context: { gameId: id },
        })
      }
    },
    get size() {
      return countAll.get()?.total ?? 0
    },
  }
}
