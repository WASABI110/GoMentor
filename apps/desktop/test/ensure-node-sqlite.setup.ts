import { ensureSqliteAbi } from '../scripts/sqlite-abi'

/**
 * Desktop vitest `globalSetup`: the better-sqlite3 binding must load under
 * plain Node before any test imports the store.
 *
 * `node_modules` holds one binding at a time and the app entry points install
 * the Electron one (`scripts/sqlite-abi.ts` — the ABI story is documented
 * there and in `main/db/connection.ts`). Without this, running `pnpm test`
 * after `pnpm e2e` fails inside the first DB open with NODE_MODULE_VERSION —
 * an error that points at the tests rather than at the stale binding. This
 * makes `pnpm test` self-correcting instead: probe (~100ms when already
 * correct), swap when not.
 *
 * It is a `globalSetup` rather than a hook because module imports — including
 * `better-sqlite3` via the store — resolve when test files load, before any
 * `beforeAll` could run.
 */
export default function ensureNodeSqliteBinding(): Promise<void> {
  return ensureSqliteAbi('node')
}
