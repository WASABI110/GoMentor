import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqliteDatabase } from '../../src/main/db/connection'

/**
 * A real database in a real temp directory, for the DB-backed store and
 * migration tests.
 *
 * In-memory (`:memory:`) would not do: the behaviours under test include
 * what survives a close and a reopen on the same file — the unit-level half
 * of C1. The `maxRetries` dance on cleanup is the same one the e2e harness
 * uses: Windows can hold a lock on a just-closed file for a few milliseconds.
 *
 * `close` and `cleanup` are separate and both idempotent: a reopen test must
 * close the connection WITHOUT deleting the file, and its `afterEach` then
 * cleans up a directory whose database was written by two connections.
 */

export interface TestDb {
  db: SqliteDatabase
  /** The database file path — pass to a reopen. */
  file: string
  /** Close the connection; the file remains on disk. Idempotent. */
  close: () => void
  /** Close the connection (if open) and delete the temp dir. Idempotent. */
  cleanup: () => void
}

export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'gomentor-db-'))
  const file = join(dir, 'library.db')
  const db = openDatabase(file)
  let open = true
  return {
    db,
    file,
    close: () => {
      if (!open) return
      open = false
      db.close()
    },
    cleanup: () => {
      if (open) {
        open = false
        try {
          db.close()
        } catch {
          // Already closed by the test itself (a reopen test closes before
          // re-opening) — cleanup only cares that the handle is not live.
        }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

/** A temp path (not created) for tests that need to control the file's prior contents. */
export function tempDbPath(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gomentor-db-'))
  return {
    file: join(dir, 'library.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}
