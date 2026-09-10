import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSgf } from '@gomentor/core/sgf/parser'
import { serialiseToBytes } from '@gomentor/core/sgf/serializer'
import { isAppError, type GameSummary } from '@gomentor/shared'
import { contentHash, toGame } from '../../src/main/sgf/adapter'
import {
  createGameStore,
  type GameStore,
  type StoredGame,
} from '../../src/main/library/store'
import { openDatabase, type SqliteDatabase } from '../../src/main/db/connection'
import { createTestDb, type TestDb } from './test-db'

/**
 * The DB-backed `GameStore` (M4 Stage 1): behavioural equivalence with the
 * in-memory `Map` it replaced, plus the persistence properties the Map could
 * not have.
 *
 * The M1 store was built behind an interface precisely so this swap would not
 * change every handler — which means the honest test of the swap is that the
 * store's own contract behaves exactly as the Map version did (same ordering,
 * same re-put semantics, same delete/clear results), and that the two things
 * a database adds — survival across a close/reopen, and cascading
 * invalidation of derived rows — actually hold.
 *
 * Byte-exactness is asserted against a real corpus file, not a synthetic
 * string: A5 is a claim about files in the wild, and a fixture built for this
 * test would prove the test's assumptions rather than the property.
 */

const FIXTURE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'core',
  'test',
  'fixtures',
  'sgf',
  'gnugo-9x9-1-pass.sgf',
)

const SGF_A = '(;GM[1]FF[4]CA[UTF-8]SZ[19]PB[Black]PW[White];B[pd];W[dp])'
const SGF_B = '(;GM[1]FF[4]CA[UTF-8]SZ[19]PB[Rin]PW[Kato];B[qc];W[cp];B[qp])'

function entry(
  sgf: string | Uint8Array,
  id: string,
  importedAt: string,
  hash = contentHash(sgf),
): StoredGame {
  const collection = parseSgf(sgf)
  return {
    game: toGame(collection, { id, source: 'import', importedAt, contentHash: hash }),
    collection,
  }
}

/** Stage 2's writers do this through the batch layer; here the rows go in directly. */
function insertAnalysisRow(
  db: SqliteDatabase,
  gameId: string,
  moveNumber: number,
): void {
  db.prepare(
    "INSERT INTO analysis (game_id, move_number, player, winrate, score_lead, winrate_loss) VALUES (?, ?, 'black', 0.5, 0.0, 0.01)",
  ).run(gameId, moveNumber)
}

function insertBatchRow(db: SqliteDatabase, gameId: string): void {
  db.prepare(
    "INSERT INTO batch_state (game_id, status, updated_at) VALUES (?, 'done', '2026-09-09T00:00:00.000Z')",
  ).run(gameId)
}

function analysisCount(db: SqliteDatabase, gameId: string): number {
  return (
    db.prepare('SELECT count(*) AS n FROM analysis WHERE game_id = ?').get(gameId) as {
      n: number
    }
  ).n
}

let testDb: TestDb
let store: GameStore

beforeEach(() => {
  testDb = createTestDb()
  store = createGameStore(testDb.db)
})

afterEach(() => {
  testDb.cleanup()
})

describe('stored-shape equivalence', () => {
  it('put/get round-trips the game projection and the collection', () => {
    const a = entry(SGF_A, 'a', '2026-09-09T01:00:00.000Z')
    store.put(a)

    const got = store.get('a')

    expect(got?.game).toEqual(a.game)
    // Compare through the serialised form, not `toEqual` on the ASTs: node
    // ids come from a module-level counter in the parser (identity within
    // one parse tree), so two parses of the same source never deep-equal.
    // The serialised bytes are the user-visible property and carry no ids.
    expect(serialiseToBytes(got!.collection)).toEqual(serialiseToBytes(a.collection))
  })

  it('get returns undefined for an unknown id', () => {
    expect(store.get('nope')).toBeUndefined()
  })

  it('round-trips a real corpus file byte-for-byte', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE))
    const a = entry(bytes, 'fixture', '2026-09-09T01:00:00.000Z')
    store.put(a)

    const got = store.get('fixture')
    if (got === undefined) throw new Error('fixture game not found after put')

    // The store's whole reason for keeping the AST: what comes back must
    // serialise to the same bytes that went in (A5), variations and unknown
    // properties included.
    expect(serialiseToBytes(got.collection)).toEqual(bytes)
  })
})

describe('listing, size, and deletion', () => {
  it('lists most-recent-first by import time', () => {
    store.put(entry(SGF_A, 'old', '2026-09-01T00:00:00.000Z'))
    store.put(entry(SGF_B, 'new', '2026-09-09T00:00:00.000Z'))

    const ids = store.list().map((summary: GameSummary) => summary.id)

    expect(ids).toEqual(['new', 'old'])
  })

  it('breaks import-time ties by reverse insertion, like the Map did', () => {
    // A batch import stamps every entry identically — the reason the Map
    // version ordered on insertion, not timestamps. Same stamp here.
    const stamp = '2026-09-09T00:00:00.000Z'
    store.put(entry(SGF_A, 'first', stamp))
    store.put(entry(SGF_B, 'second', stamp))

    const ids = store.list().map((summary) => summary.id)

    expect(ids).toEqual(['second', 'first'])
  })

  it('summaries carry the fields the library panel renders', () => {
    store.put(entry(SGF_B, 'b', '2026-09-09T00:00:00.000Z'))

    const [summary] = store.list()

    expect(summary).toMatchObject({
      id: 'b',
      moveCount: 3,
      boardSize: 19,
      source: 'import',
      blackName: 'Rin',
      whiteName: 'Kato',
    })
  })

  it('has/size track puts and deletes', () => {
    expect(store.size).toBe(0)
    expect(store.has('a')).toBe(false)

    store.put(entry(SGF_A, 'a', '2026-09-09T00:00:00.000Z'))
    store.put(entry(SGF_B, 'b', '2026-09-09T00:00:00.000Z'))
    expect(store.size).toBe(2)
    expect(store.has('a')).toBe(true)

    expect(store.delete('a')).toBe(true)
    expect(store.delete('a')).toBe(false)
    expect(store.size).toBe(1)
    expect(store.has('a')).toBe(false)
    expect(store.get('a')).toBeUndefined()
  })

  it('clear empties everything', () => {
    store.put(entry(SGF_A, 'a', '2026-09-09T00:00:00.000Z'))
    store.put(entry(SGF_B, 'b', '2026-09-09T00:00:00.000Z'))

    store.clear()

    expect(store.size).toBe(0)
    expect(store.list()).toEqual([])
  })
})

describe('re-put semantics (put twice on one id)', () => {
  it('same content updates the row without touching derived data', () => {
    const a = entry(SGF_A, 'a', '2026-09-01T00:00:00.000Z')
    store.put(a)
    store.setIsMineOverride('a', true)
    insertAnalysisRow(testDb.db, 'a', 1)
    insertBatchRow(testDb.db, 'a')

    // The sgf:parse re-put path: same id, same content, the original game
    // projection. Derived rows and the user's manual mark must survive.
    store.put(a)

    expect(store.size).toBe(1)
    expect(store.getIsMineOverride('a')).toBe(true)
    expect(analysisCount(testDb.db, 'a')).toBe(1)
    expect(store.get('a')?.game.importedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('changed content invalidates analysis and ledger rows', () => {
    store.put(entry(SGF_A, 'a', '2026-09-01T00:00:00.000Z'))
    insertAnalysisRow(testDb.db, 'a', 1)
    insertAnalysisRow(testDb.db, 'a', 2)
    insertBatchRow(testDb.db, 'a')

    // Same id, different content hash: the stored game is replaced and the
    // derived rows are gone — the invalidation Stage 2's batch layer relies on.
    store.put(entry(SGF_B, 'a', '2026-09-09T00:00:00.000Z'))

    expect(store.size).toBe(1)
    expect(analysisCount(testDb.db, 'a')).toBe(0)
    expect(
      (
        testDb.db.prepare('SELECT count(*) AS n FROM batch_state').get() as {
          n: number
        }
      ).n,
    ).toBe(0)
    expect(store.get('a')?.game.moves.length).toBe(3) // SGF_B's projection
  })

  it('delete cascades to the analysis rows (foreign keys are really on)', () => {
    store.put(entry(SGF_A, 'a', '2026-09-09T00:00:00.000Z'))
    insertAnalysisRow(testDb.db, 'a', 1)
    insertAnalysisRow(testDb.db, 'a', 2)

    store.delete('a')

    expect(analysisCount(testDb.db, 'a')).toBe(0)
  })
})

describe('is_mine_override accessors', () => {
  it('defaults to unset', () => {
    store.put(entry(SGF_A, 'a', '2026-09-09T00:00:00.000Z'))

    expect(store.getIsMineOverride('a')).toBeUndefined()
    expect(store.getIsMineOverride('unknown')).toBeUndefined()
  })

  it('sets, flips, and clears the tri-state', () => {
    store.put(entry(SGF_A, 'a', '2026-09-09T00:00:00.000Z'))

    store.setIsMineOverride('a', true)
    expect(store.getIsMineOverride('a')).toBe(true)

    store.setIsMineOverride('a', false)
    expect(store.getIsMineOverride('a')).toBe(false)

    // Back to unset — name matching decides again.
    store.setIsMineOverride('a', undefined)
    expect(store.getIsMineOverride('a')).toBeUndefined()
  })

  it('throws a typed error for an unknown id rather than no-op', () => {
    let caught: unknown
    try {
      store.setIsMineOverride('unknown', true)
    } catch (error) {
      caught = error
    }

    expect(isAppError(caught) && caught.code).toBe('LIBRARY_NOT_FOUND')
  })
})

describe('persistence (what the Map could not do)', () => {
  it('survives a close and a reopen on the same file', () => {
    store.put(entry(SGF_A, 'a', '2026-09-01T00:00:00.000Z'))
    store.put(entry(SGF_B, 'b', '2026-09-09T00:00:00.000Z'))
    store.setIsMineOverride('a', true)
    const file = testDb.file

    // Close but do NOT delete the file — deleting is what `cleanup` is for.
    // The whole test is what survives this close followed by a fresh open.
    testDb.close()
    const reopened = openDatabase(file)
    const store2 = createGameStore(reopened)

    // The unit-level half of C1: import → exit → relaunch → the library is
    // still there, in order, with the user's marks intact.
    expect(store2.size).toBe(2)
    expect(store2.list().map((summary) => summary.id)).toEqual(['b', 'a'])
    // Serialised-bytes equality, not AST deep-equality: parser node ids come
    // from a module-level counter, so two parses of one source differ by id.
    expect(serialiseToBytes(store2.get('a')!.collection)).toEqual(
      serialiseToBytes(parseSgf(SGF_A)),
    )
    expect(store2.getIsMineOverride('a')).toBe(true)

    reopened.close()
  })
})
