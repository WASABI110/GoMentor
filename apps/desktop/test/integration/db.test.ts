import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAppError } from '@gomentor/shared'
import { openDatabase, openLibraryDatabase } from '../../src/main/db/connection'
import { MIGRATIONS, migrate, type Migration } from '../../src/main/db/migrate'
import { tempDbPath } from './test-db'

/**
 * The SQLite foundation (M4 Stage 1): migration discipline and connection
 * policy, against real database files in temp directories.
 *
 * What is load-bearing:
 *
 * - **a failing migration rolls back completely** — schema *and* the
 *   `user_version` marker. If the version moved while the tables did not, the
 *   next start would skip the migration and every later one, silently
 *   stranding the schema below what the code expects.
 * - **the registry covers the migrations directory.** An unregistered `.sql`
 *   file is a migration that exists but never runs — the drift this asserts
 *   cannot happen for a missing file (the import fails the build) but can for
 *   a forgotten registry entry.
 * - **a damaged file is a state, not a crash**: quarantined, preserved, and the
 *   app gets a fresh database (the settings.ts precedent).
 */

interface Handle {
  file: string
  cleanup: () => void
}

let handle: Handle

beforeEach(() => {
  handle = tempDbPath()
})

afterEach(() => {
  handle.cleanup()
})

function userVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

function tables(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}

/** Catches and returns, so assertions can pin the typed `code`, not the prose. */
function catchCode(attempt: () => unknown): unknown {
  try {
    attempt()
  } catch (error) {
    return error
  }
  return undefined
}

const M1: Migration = {
  version: 1,
  name: '0001_test_init',
  sql: 'CREATE TABLE one (x)',
}
const M2: Migration = {
  version: 2,
  name: '0002_test_next',
  sql: 'CREATE TABLE two (x)',
}

describe('migrate', () => {
  it('applies the shipped registry to a fresh database and stamps user_version', () => {
    const db = new Database(handle.file)
    const version = migrate(db)

    expect(version).toBe(MIGRATIONS.length)
    expect(userVersion(db)).toBe(MIGRATIONS.length)
    // The three tables the M4 design names — asserted by name, so a migration
    // that silently stops creating one of them fails here rather than in a
    // Stage 2 test that assumes it exists.
    expect(tables(db)).toContain('games')
    expect(tables(db)).toContain('analysis')
    expect(tables(db)).toContain('batch_state')
    db.close()
  })

  it('is idempotent: migrating an already-migrated database is a no-op', () => {
    const first = new Database(handle.file)
    migrate(first, [M1])
    const schemaAfterFirst = tables(first)
    first.close()

    const second = new Database(handle.file)
    // Same registry again — what a second app start does.
    const version = migrate(second, [M1])

    expect(version).toBe(1)
    expect(userVersion(second)).toBe(1)
    expect(tables(second)).toEqual(schemaAfterFirst)
    second.close()
  })

  it('applies future migrations in order after an earlier run', () => {
    const first = new Database(handle.file)
    migrate(first, [M1])
    first.close()

    const second = new Database(handle.file)
    const version = migrate(second, [M1, M2])

    expect(version).toBe(2)
    expect(tables(second)).toContain('two')
    second.close()
  })

  it('rolls back a failing migration, leaving user_version unchanged', () => {
    const bad: Migration = {
      version: 2,
      name: '0002_test_bad',
      sql: 'CREATE TABLE half (x); CREATE TABLE not valid sql at all',
    }
    const db = new Database(handle.file)

    const error = catchCode(() => migrate(db, [M1, bad]))

    // The typed code, not message prose (`settings.test.ts`'s rule).
    expect(isAppError(error) && error.code).toBe('DB_MIGRATION_FAILED')
    // The marker must still say 1: the failed migration must be retried (after
    // a fix), not skipped as if it had applied. And its partial table —
    // `db.exec` runs statements in sequence, so `half` existed inside the
    // transaction — must not have survived the rollback.
    expect(userVersion(db)).toBe(1)
    expect(tables(db)).not.toContain('half')
    db.close()
  })

  it('rejects a non-contiguous registry instead of skipping a version', () => {
    const db = new Database(handle.file)

    const error = catchCode(() => migrate(db, [M1, { ...M2, version: 3 }]))

    expect(isAppError(error) && error.code).toBe('DB_MIGRATION_FAILED')
    if (isAppError(error)) {
      expect(error.context).toEqual({
        applied: 1,
        expected: 2,
        found: 3,
        migration: '0002_test_next',
      })
    }
    expect(userVersion(db)).toBe(1)
    db.close()
  })

  it('registers every file in migrations/ and nothing else', () => {
    // The drift guard: an unregistered migration file never runs, and the
    // import-based registry cannot notice on its own. This is the same shape
    // as the IPC channel meta-test — the list must match the source of truth.
    const files = readdirSync(
      join(__dirname, '..', '..', 'src', 'main', 'db', 'migrations'),
    )
      .filter((name) => name.endsWith('.sql'))
      .sort()
    const registered = MIGRATIONS.map((migration) => `${migration.name}.sql`).sort()

    expect(files).toEqual(registered)
    // And the versions are unique, or the sort-and-skip in the runner would
    // silently drop one of them.
    expect(new Set(MIGRATIONS.map((m) => m.version)).size).toBe(MIGRATIONS.length)
  })
})

describe('openDatabase', () => {
  it('enables WAL and foreign keys', () => {
    const db = openDatabase(handle.file)

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('creates missing parent directories', () => {
    const nested = join(handle.file, '..', 'a', 'b', 'library.db')

    const db = openDatabase(nested)

    expect(db.open).toBe(true)
    db.close()
  })

  it('opens a file written by a newer version, leaving its version untouched', () => {
    // Downgrade: user_version above the registry maximum (a file written by
    // a newer app, or a registry regression in this one). Append-only
    // discipline makes this survivable — old code reads only what it knows —
    // so the open must succeed and must NOT rewrite the version marker. The
    // warning log is the signal requirement; it is visible in test output as
    // the scoped main:db JSON line, but the behavioural pin here is that the
    // file survives exactly as the newer version left it.
    const first = openDatabase(handle.file)
    first.pragma('user_version = 9000')
    first.close()

    const second = openDatabase(handle.file)

    expect(second.open).toBe(true)
    expect(userVersion(second)).toBe(9000)
    second.close()
  })

  it('throws a typed DB_CORRUPT for a file that is not a database', () => {
    writeFileSync(handle.file, 'this is not a sqlite database, not even a little')

    const error = catchCode(() => openDatabase(handle.file))

    expect(isAppError(error) && error.code).toBe('DB_CORRUPT')
  })
})

describe('openLibraryDatabase (the startup path)', () => {
  it('quarantines a damaged file, preserves it, and starts fresh', () => {
    const garbage = Buffer.from('truncated journal, torn pages, no header')
    writeFileSync(handle.file, garbage)

    const db = openLibraryDatabase(handle.file)

    // The app still gets a working, fully migrated database.
    expect(db.open).toBe(true)
    expect(userVersion(db)).toBe(MIGRATIONS.length)
    expect(
      (db.prepare('SELECT count(*) AS n FROM games').get() as { n: number }).n,
    ).toBe(0)
    db.close()

    // Nothing was destroyed: the damaged bytes are exactly where they were,
    // under a name a support request can attach.
    expect(existsSync(`${handle.file}.corrupt`)).toBe(true)
    expect(readFileSync(`${handle.file}.corrupt`)).toEqual(garbage)
  })

  it('propagates non-corrupt failures rather than quarantining', () => {
    // A directory in the file's place fails for a different reason than
    // corruption (SQLITE_CANTOPEN → DB_OPEN_FAILED); openLibraryDatabase must
    // not paper over it with a fresh start, or every open failure would
    // silently discard the library.
    mkdirSync(handle.file)

    const error = catchCode(() => openLibraryDatabase(handle.file))

    expect(isAppError(error) && error.code).toBe('DB_OPEN_FAILED')
  })
})
