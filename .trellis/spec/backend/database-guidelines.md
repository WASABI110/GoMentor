# Database Guidelines

> Database patterns and conventions for this project. Authored M4 Stage 1 (2026-09) when the library store moved from an in-memory `Map` to SQLite; every rule below is a fact the Stage 1 implementation and tests proved, not preference.

---

## Overview

- **Driver: better-sqlite3, pinned at 12.4.1**, synchronous API, called only from the Electron main process. The main process is the sole holder of the database, and its IPC style is request/response — a synchronous driver keeps handlers straight-line read-or-write with no connection pool and no async/transaction interleaving. Do not wrap calls in `async` "for consistency"; blurring where transactions begin and end is the one thing this layer exists to keep crisp.
- **Why not v13:** it publishes no prebuilt binaries — every install compiles from source and demands a platform toolchain. 12.4.1 is the last release whose assets cover `node-v127/v137` and `electron-v130` on all three CI platforms.
- **Why the pin matters twice:** better-sqlite3 binds V8 directly (not N-API), so `node_modules` holds ONE binding at a time. The repo runs the module under both Node (vitest) and Electron (dev/e2e/packaging); `apps/desktop/scripts/sqlite-abi.ts` swaps the installed binding per runtime, and every entry point (`dev`, `e2e`, `package`) plus the desktop vitest `globalSetup` (`test/ensure-node-sqlite.setup.ts`) runs it first. `pnpm rebuild better-sqlite3` is NOT the flow — it rebuilds for local Node and ignores the prebuilds cache.
- **File location:** `dbFile()` in `apps/desktop/src/main/paths.ts` → `<userData>/library.db`. The database is a derived index: the SGF files are the source of truth, so a damaged database is quarantined (`<name>.corrupt`, nothing destroyed) and the app starts fresh rather than refusing to launch (`openLibraryDatabase` in `src/main/db/connection.ts`).

## Pragmas (set in `openDatabase`, in this order, before migrations)

1. `journal_mode = WAL` — first, because it changes the on-disk journal format; a later switch mid-session would rewrite what earlier statements saw. WAL is also what makes the synchronous style coexist with crash safety.
2. `foreign_keys = ON` — off by default in SQLite; the analysis/batch tables' integrity story is `ON DELETE CASCADE` from `games`, which silently does nothing without it.
3. `synchronous = NORMAL` — in WAL mode this still cannot corrupt the database; it can lose the last commits of a power cut, which for a re-importable library plus a resumable batch ledger is the right throughput trade.

## Migrations

- Numbered `.sql` files in `src/main/db/migrations/` (`0001_init.sql` → version 1), registered **explicitly** in `MIGRATIONS` (`src/main/db/migrate.ts`) — bundlers cannot directory-scan, and the explicit list plus the coverage meta-test cannot silently skip a file.
- Applied by `migrate()` inside `openDatabase`, each in its own `db.transaction` (`BEGIN`/`COMMIT`/`ROLLBACK`), with progress recorded in SQLite's native `user_version` header — writing it inside the transaction rolls it back with the schema changes (verified by test: a failing migration leaves `user_version` untouched).
- **Ordering is a gap check, not a sort-and-hope:** each migration must be exactly `current + 1`; a jump fails loudly with `DB_MIGRATION_FAILED` rather than silently skipping.
- **Append-only discipline, same as the error-code enum:** a later migration may add tables/columns/indexes but never renames or drops what an earlier one created. A shipped migration has run on user machines; editing it in place makes `user_version` a lie.
- `.sql` files are inlined at build time via vite's `?raw` suffix; the ambient declaration lives in `src/main/db/migrations-env.ts`, imported for its side effect by `migrate.ts` so every tsconfig project that compiles it (including the test project, which does not include `src/main/**`) sees the module type.

## Schema Conventions (as proven by `0001_init.sql`)

- `snake_case` columns; a single `TEXT PRIMARY KEY` id column (the content hash — the same dedupe key the old `Map` used, so ids are stable across the storage swap).
- `games` deliberately keeps its implicit `rowid` (i.e. NOT `WITHOUT ROWID`): `list()` breaks most-recent-first ties on `rowid DESC` because a batch import stamps every `imported_at` identically.
- Derived tables reference `games(id)` with `ON DELETE CASCADE` — invalidation of analysis/ledger rows on game delete or content-hash change happens in the store's delete-then-insert transaction, never in callers.
- Tri-state manual flags are `INTEGER NULL` (NULL = unset, 1/0 = set), not a BOOLEAN default — "unset, let inference decide" must be representable.
- The `sgf` column is a `BLOB` holding `serialiseToBytes(collection)` — never a TEXT of the game. Encoding-preserving bytes are the whole point: a Shift_JIS record must come back in its original codepage, and a string column would silently rewrite it as UTF-8.

## Query Patterns

- **Prepared statements once, at store construction** (`createGameStore`): better-sqlite3 parses SQL at prepare time, and every store method is a hot path (the library list renders on every app start).
- **Multi-statement mutations go through `db.transaction`** — e.g. the store's put is delete-then-insert when the content hash changed; wrapped in one transaction a crash mid-sequence rolls back to the old row instead of leaving the game lost or its analysis orphaned. Never issue the parts from separate call sites.
- **Test databases are real files in temp dirs**, not `:memory:` — the behaviours under test (close/reopen survival, corrupt-file quarantine) need a real path. `test/integration/test-db.ts` provides `createTestDb`/`tempDbPath` with the `maxRetries` cleanup dance (Windows holds a lock on a just-closed file for milliseconds) and a `close`/`cleanup` split: a reopen test closes the connection WITHOUT deleting the file, and `cleanup` is idempotent for afterEach.

## Common Mistakes (measured, Stage 1)

- **Test fixtures that were fine under the `Map` die under SQLite.** Two shapes, both seen in Stage 1:
  1. A helper that builds its default store eagerly above a spread (`{ store: storeWith([]), ...overrides }`) — the default's `clear()` wipes the shared database *after* the caller's store was built. With per-call `Map`s the clear was harmless; with one shared database it deletes the caller's games. Default lazily: `store: overrides.store ?? storeWith([])`.
  2. A hand-built `SgfCollection` with `roots: []` — serialises to zero bytes, so `get()` re-parses empty input and throws `SGF_EMPTY`. The store serialises on put and re-parses on get; fixtures must be real, parseable SGF (e.g. `parseSgf('(;GM[1]FF[4]CA[UTF-8]SZ[19])')`).
- **Never deep-equal two parsed SGF ASTs.** Node ids come from a module-level counter in the parser (identity within one parse tree), so two parses of the same source differ by `id`. Compare through `serialiseToBytes` — ids are not serialised, so the bytes are deterministic.
- **A native-module test failure after `pnpm e2e` is a stale binding, not broken code.** `e2e` installs the Electron ABI; the next `pnpm test` fails at the first DB open with `NODE_MODULE_VERSION`. The vitest `globalSetup` exists precisely to make `pnpm test` self-correcting — do not "fix" it by hand-swapping binaries.
- **`pnpm rebuild better-sqlite3` verifies nothing in this repo.** Under `neverBuiltDependencies` (root `package.json`) it is a ~0.6s no-op. The only real check is the probe gate: `pnpm exec tsx apps/desktop/scripts/sqlite-abi.ts node` (or `electron`). Likewise do not trust a bare `require('better-sqlite3')` as a binding check — the binding loads lazily at first `new Database` (sqlite-abi.ts documents the measurement).

## Measured Behaviours Worth Not Forgetting (gomentor-verify, 2026-09-10)

- **SQLite does NOT discard a self-consistent foreign WAL — it replays it** (measured: fresh file + planted foreign `-wal` → the foreign row appears, `integrity_check` still `ok`). After quarantining a damaged database, a stale sidecar that survives beside the new file would silently resurrect the damaged content. Quarantine therefore renames sidecars with the evidence and *deletes* any that cannot be renamed, before the fresh open. Never write "SQLite discards a mismatched WAL" anywhere.
- **A `user_version` above the registry is a downgrade, and it opens silently.** Append-only discipline makes it survivable (old code reads only what it knows; the library is a derived index), so `openDatabase` logs a warning and opens anyway — but the signal must exist. Recovery paths that pass quietly are how real defects hide.
- **Quarantine guards the startup path only.** Runtime corruption (valid header, torn b-tree) passes `openDatabase` — migrations touch only `sqlite_master` — and surfaces later as an untyped `SqliteError` → `IPC_HANDLER_FAILED` at whatever handler hits it. That is a defensible scope boundary (the user quarantines by renaming the file, then re-imports); it is written down here so nobody "discovers" it as a surprise.
- **If quarantine itself fails (rename blocked), the app cannot start and there is no window** — the rethrow is a `whenReady` rejection. The failure is logged via electron-log before the throw; that log line is the entire UX, deliberately (the alternative — launching without a library store — would break every handler that depends on one).
