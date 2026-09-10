import Database from 'better-sqlite3'
import { AppError } from '@gomentor/shared'
// Side-effect import: pulls the `*.sql?raw` ambient module declaration into
// every program that compiles this file. See that module for why.
import './migrations-env'
import init from './migrations/0001_init.sql?raw'

/**
 * The migration runner: applies numbered migrations transactionally, recording
 * progress in SQLite's `user_version`.
 *
 * ## Why `user_version` and not a migrations table
 *
 * It is a header field SQLite maintains natively — reading it is a cached
 * property lookup, and writing it inside a transaction rolls back with that
 * transaction (verified by test: a failing migration leaves `user_version`
 * untouched). A `schema_migrations` table would re-implement the same
 * bookkeeping with more surface to get wrong, and would itself need bootstrapping.
 *
 * ## Ordering is a gap check, not a sort-and-hope
 *
 * Each migration must be exactly `current + 1`. A registry that jumps (a
 * migration file added without being registered, or registered out of order)
 * fails loudly here rather than silently skipping whatever was missed. The
 * companion test asserts the registry covers every file in `migrations/`, so
 * the unregistered-migration drift is caught at test time, not on a user's
 * machine.
 *
 * ## One connection, one runner
 *
 * The main process is the sole holder of the database (single-instance lock in
 * `index.ts`), so there is no concurrent-migration case to handle. If that ever
 * changes, the runner needs a lock before this comment gets deleted, not after.
 */

export interface Migration {
  /** 1-based, zero-padded in the filename (`0001_init.sql` → 1). */
  readonly version: number
  /** The filename without extension — what logs and errors name. */
  readonly name: string
  readonly sql: string
}

/**
 * The registry. Explicit imports rather than a directory scan: bundlers cannot
 * scan (the bundle must be self-contained — the `out/` launch lesson), and an
 * explicit list plus the coverage meta-test cannot silently skip a file.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '0001_init', sql: init },
]

/**
 * The highest version the registry can apply. A file whose `user_version`
 * exceeds this was written by a newer app — a downgrade, survivable under
 * append-only discipline but worth a signal (see `openDatabase`).
 */
export function maxMigrationVersion(
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
}

/**
 * Applies every migration above `user_version`, in order, each inside its own
 * transaction. Returns the resulting version (0 when the registry is empty and
 * nothing applied — a valid state for tests driving synthetic registries).
 */
export function migrate(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  let applied = db.pragma('user_version', { simple: true }) as number

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= applied) continue // already applied — idempotent
    if (migration.version !== applied + 1) {
      throw new AppError('DB_MIGRATION_FAILED', 'migrations are not contiguous', {
        context: {
          applied,
          expected: applied + 1,
          found: migration.version,
          migration: migration.name,
        },
      })
    }

    try {
      // `db.transaction` issues BEGIN/COMMIT/ROLLBACK, and `PRAGMA user_version`
      // participates in the transaction — a failure mid-migration leaves both
      // the schema changes and the version marker rolled back.
      db.transaction(() => {
        db.exec(migration.sql)
        db.pragma(`user_version = ${String(migration.version)}`)
      })()
    } catch (error) {
      throw new AppError('DB_MIGRATION_FAILED', 'a database migration failed', {
        cause: error,
        context: { migration: migration.name, version: migration.version },
      })
    }
    applied = migration.version
  }

  return applied
}
