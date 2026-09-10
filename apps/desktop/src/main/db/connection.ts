import Database, { SqliteError } from 'better-sqlite3'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { AppError, isAppError } from '@gomentor/shared'
import { scoped } from '../logger'
import { migrate, maxMigrationVersion } from './migrate'

/**
 * The SQLite connection: open, configure, migrate, and — at the startup call
 * site — quarantine a damaged file rather than refusing to launch.
 *
 * ## Why better-sqlite3 and why synchronous
 *
 * The main process is the sole holder of the database, and its IPC style is
 * request/response (`register.ts` handlers are synchronous functions returning
 * envelopes). A synchronous driver means a handler is a straight-line
 * read-or-write with no `await`, no connection pool, and no async/transaction
 * interleaving — an async wrapper would only blur where transactions begin and
 * end, which is the one boundary this layer exists to keep crisp. The
 * trade-off (blocking the main process during I/O) is acceptable because the
 * queries are index-backed and millisecond-scale; SQLite is in-process, so
 * there is no network latency to hide behind async.
 *
 * ## The native-module ABI dance (measured, 2026-09-09)
 *
 * better-sqlite3 binds directly against V8, not N-API: it ships one prebuilt
 * binary per ABI (`node-v137` for Node 24, `electron-v130` for Electron 33),
 * and `node_modules` can hold only one at a time. The repo runs the module
 * under both runtimes — vitest under plain Node, `pnpm e2e` / `pnpm dev` /
 * packaging under Electron — so `apps/desktop/scripts/sqlite-abi.ts` swaps
 * the installed binding to match the runtime about to execute, and every entry
 * point that loads the app (`dev`, `e2e`, `package`) and the desktop vitest
 * project (`globalSetup`) run it first. `pnpm rebuild better-sqlite3` is NOT
 * part of this flow and not a substitute: under `neverBuiltDependencies` in
 * root `package.json` it is a no-op (~0.6s, no build), so the only mechanism
 * that ever installs a binding here is `sqlite-abi.ts`.
 *
 * v13.x of the package publishes no prebuilt binaries at all (every install
 * compiles from source and needs a platform toolchain), which is why the
 * dependency is pinned to 12.4.1 — the last release whose assets cover
 * node-v127/v137 and electron-v130 on all three CI platforms.
 */

const logger = scoped('main:db')

/** The one connection type that crosses this module's boundary. */
export type SqliteDatabase = Database.Database

/** SQLite error codes that mean "this file is not a usable database". */
const CORRUPT_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT'])

/** The last path segment only: this travels in error context, and the full path can carry a username. */
function basename(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] ?? file
}

function toAppError(error: unknown, file: string): AppError {
  if (isAppError(error)) return error // migration failures arrive pre-typed
  const code =
    error instanceof SqliteError && CORRUPT_CODES.has(error.code)
      ? 'DB_CORRUPT'
      : 'DB_OPEN_FAILED'
  return new AppError(code, 'Could not open the library database', {
    cause: error,
    context: { file: basename(file) },
  })
}

/**
 * Opens (creating if absent) the database at `file`, applies pragmas and
 * migrations, and returns the connection. Throws `AppError` with a `DB_` code
 * on failure; callers decide policy — `openLibraryDatabase` is the forgiving
 * spelling the app startup uses.
 */
export function openDatabase(file: string): SqliteDatabase {
  // The parent must exist before SQLite will create the file. `userData`
  // always does, but tests point this at fresh temp directories and the
  // packaged app runs before anything else has written there.
  mkdirSync(dirname(file), { recursive: true })

  let db: SqliteDatabase
  try {
    db = new Database(file)
  } catch (error) {
    throw toAppError(error, file)
  }

  try {
    // WAL before anything else: it changes the journal format on disk, and a
    // later switch mid-session would rewrite what earlier statements saw.
    // WAL is what lets the synchronous style coexist with crash safety —
    // commits are appended to the write-ahead log and checkpointed, so a
    // power cut mid-write cannot tear the database.
    db.pragma('journal_mode = WAL')
    // Off by default in SQLite, and the analysis/batch tables are worthless
    // without it: their whole integrity story is ON DELETE CASCADE from games.
    db.pragma('foreign_keys = ON')
    // The SQLite default (FULL) fsyncs per commit; NORMAL fsyncs at
    // checkpoints. In WAL mode NORMAL still cannot corrupt the database — it
    // can lose the last commits of a power cut, which for a re-importable
    // library plus a resumable batch ledger is the right trade for the
    // throughput batch analysis needs.
    db.pragma('synchronous = NORMAL')
    // Downgrade is a state worth a log line, not an error: a file written by
    // a newer app opens fine under append-only schema discipline (old code
    // reads only the tables and columns it knows), and the library is a
    // derived index either way. What it must not be is silent — recovery
    // paths that pass quietly are how real defects hide (the WAL-replay
    // quarantine lesson above).
    const fileVersion = db.pragma('user_version', { simple: true }) as number
    const supportedVersion = maxMigrationVersion()
    if (fileVersion > supportedVersion) {
      logger.warn('library database was written by a newer version; opening anyway', {
        file: basename(file),
        fileVersion,
        supportedVersion,
      })
    }
    migrate(db)
  } catch (error) {
    db.close()
    throw toAppError(error, file)
  }

  return db
}

/**
 * The startup path: a damaged database is a state, not a crash.
 *
 * A user's library is re-importable (the SGF files still exist wherever they
 * came from; the database is a derived index), and an app that refuses to
 * launch because one file is damaged is a worse outcome than an app that
 * starts empty with a warning. The damaged file is renamed to `<name>.corrupt`
 * — nothing is destroyed, exactly the `settings.ts` precedent, so a support
 * request can still attach the evidence.
 */
export function openLibraryDatabase(file: string): SqliteDatabase {
  try {
    return openDatabase(file)
  } catch (error) {
    if (!isAppError(error) || error.code !== 'DB_CORRUPT') throw error

    logger.failure(
      'library database is damaged; quarantining and starting fresh',
      error,
    )
    try {
      renameSync(file, `${file}.corrupt`)
    } catch (renameError) {
      // Without the rename there is no fresh start to be had — the same file
      // would fail the same way on retry. Surface it as the open failure it
      // is, and leave an electron-log entry: this rethrow becomes a
      // `whenReady` rejection with no window, so the log is the only trace.
      logger.failure('could not quarantine the damaged database', renameError, {
        file: basename(file),
      })
      throw new AppError(
        'DB_OPEN_FAILED',
        'Could not move the damaged database aside',
        {
          cause: renameError,
          context: { file: basename(file) },
        },
      )
    }
    // Stale WAL/SHM sidecars from the damaged file must not survive beside
    // the fresh database: measured (2026-09-10, gomentor-verify), SQLite does
    // NOT discard a self-consistent foreign WAL — it replays it over the new
    // file, silently resurrecting the damaged content while
    // `integrity_check` still reports ok. Move them with the evidence when
    // possible; when a sidecar cannot be renamed (a handle still open), the
    // stale log is precisely the thing that must not be replayed — delete it
    // instead. Best-effort: failure here is not worth failing the launch
    // over, but the fresh open below must never see these bytes.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${file}${suffix}`
      try {
        renameSync(sidecar, `${file}.corrupt${suffix}`)
      } catch {
        try {
          rmSync(sidecar, { force: true, maxRetries: 5, retryDelay: 50 })
        } catch {
          // Absent, or locked by a scanner — nothing more to try.
        }
      }
    }

    const fresh = openDatabase(file)
    logger.warn('started on a fresh library database', { file: basename(file) })
    return fresh
  }
}
