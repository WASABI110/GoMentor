/**
 * Ensures the installed better-sqlite3 native binding matches a runtime.
 *
 *   tsx scripts/sqlite-abi.ts node      # for vitest / plain-Node tooling
 *   tsx scripts/sqlite-abi.ts electron  # for `dev`, `e2e`, `package`
 *
 * ## Why this exists (measured, 2026-09-09)
 *
 * better-sqlite3 binds directly against V8 rather than N-API, so it ships one
 * prebuilt binary per ABI — `node-v137` (Node 24), `node-v127` (Node 22, CI),
 * `electron-v130` (Electron 33.4.11) — and `node_modules` can hold only one
 * build at a time. This repo legitimately runs the module under both runtimes:
 * vitest under plain Node, and the app (dev, e2e, packaging) under Electron.
 * A mismatch does not fail cleanly; it dies at require time with
 * NODE_MODULE_VERSION deep inside the first DB open.
 *
 * So every entry point runs this script first, and the script is idempotent:
 * it probes whether the installed binding already loads under the requested
 * runtime (a ~100ms spawn) and exits 0 without touching anything when it does.
 *
 * ## Resolution order when a swap is needed
 *
 * 1. `prebuild-install` with the target runtime — which itself prefers, in
 *    order: a tarball already in `<pkg>/prebuilds/`, the npm prebuild cache,
 *    then a GitHub release download.
 * 2. A mirror fetch (npmmirror) into `<pkg>/prebuilds/`, then prebuild-install
 *    again. Some networks truncate GitHub release downloads silently — the
 *    same failure electron-builder.yml documents for the Electron dist — and
 *    the mirror is the fallback that keeps those machines working.
 *
 * The gate is the final probe, not any tool's exit code: the script exits
 * non-zero unless the binding demonstrably loads under the requested runtime.
 *
 * `pnpm rebuild better-sqlite3` is NOT the flow here: it rebuilds for the
 * local Node and re-downloads from scratch, ignoring both the probe and the
 * prebuilds/ cache.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

type Runtime = 'node' | 'electron'
export type { Runtime }

const require = createRequire(import.meta.url)

const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const pkgVersion = (require('better-sqlite3/package.json') as { version: string })
  .version

function fail(message: string): never {
  console.error(`sqlite-abi: ${message}`)
  process.exit(1)
}

function log(message: string): void {
  console.log(`sqlite-abi: ${message}`)
}

/** The installed Electron binary. `require('electron')` is the path string in a plain-Node context. */
function electronExecutable(): string {
  const resolved = require('electron') as unknown
  return typeof resolved === 'string'
    ? resolved
    : fail('could not resolve the electron binary')
}

/** The installed Electron's exact version — what prebuild-install must target. */
function electronVersion(): string {
  return (require('electron/package.json') as { version: string }).version
}

function execFor(runtime: Runtime): { exe: string; env: NodeJS.ProcessEnv } {
  if (runtime === 'node') return { exe: process.execPath, env: process.env }
  // ELECTRON_RUN_AS_NODE boots the same binary as plain Node with Electron's
  // ABI — exactly the environment the main bundle loads better-sqlite3 in.
  return {
    exe: electronExecutable(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }
}

/**
 * True when the installed binding loads under `runtime`. The gate everything
 * below serves.
 *
 * The probe constructs a database, not merely `require`s the package: the
 * binding is loaded lazily at first construction, so a bare require succeeds
 * even with no binding installed at all (measured — `require` passed while
 * `new Database` threw "Could not locate the bindings file").
 */
function probe(runtime: Runtime): boolean {
  const { exe, env } = execFor(runtime)
  const script = `const D = require(${JSON.stringify(pkgDir)}); const d = new D(':memory:'); d.exec('select 1'); d.close()`
  const result = spawnSync(exe, ['-e', script], { env, encoding: 'utf8' })
  return result.status === 0
}

/** Runs prebuild-install inside the package dir for the target runtime. */
function prebuildInstall(runtime: Runtime): void {
  const bin = require.resolve('prebuild-install/bin.js')
  const args = ['--runtime', runtime]
  if (runtime === 'electron') args.push('--target', electronVersion())

  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: pkgDir,
    stdio: 'inherit',
  })
  if (result.error !== undefined)
    fail(`prebuild-install could not run: ${String(result.error)}`)
}

/** The ABI number a prebuild filename carries for the given runtime, measured from the runtime itself. */
function abiOf(runtime: Runtime): string {
  const { exe, env } = execFor(runtime)
  const result = spawnSync(exe, ['-p', 'process.versions.modules'], {
    env,
    encoding: 'utf8',
  })
  const abi = result.stdout.trim()
  return /^\d+$/.test(abi) ? abi : fail(`could not read the ${runtime} ABI`)
}

/**
 * Fetches the prebuilt tarball from the npmmirror CDN into `<pkg>/prebuilds/`,
 * where prebuild-install looks before touching the network.
 */
async function fetchMirrorPrebuild(runtime: Runtime): Promise<boolean> {
  const file = `better-sqlite3-v${pkgVersion}-${runtime}-v${abiOf(runtime)}-${process.platform}-${process.arch}.tar.gz`
  const url = `https://registry.npmmirror.com/-/binary/better-sqlite3/v${pkgVersion}/${file}`

  let response: Response
  try {
    response = await fetch(url)
  } catch {
    return false
  }
  if (!response.ok) return false

  const bytes = Buffer.from(await response.arrayBuffer())
  // gzip magic: a truncated or HTML error page must not be planted as a
  // "local prebuild" that every future prebuild-install run would trust.
  if (bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return false

  mkdirSync(join(pkgDir, 'prebuilds'), { recursive: true })
  writeFileSync(join(pkgDir, 'prebuilds', file), bytes)
  log(`fetched ${file} from the mirror`)
  return true
}

/**
 * The reusable core: makes the binding loadable under `runtime`, or exits the
 * process non-zero. Imported by the desktop vitest `globalSetup` (for `node`)
 * and run as a CLI by the `dev` / `e2e` / `package` scripts (for `electron`).
 */
export async function ensureSqliteAbi(runtime: Runtime): Promise<void> {
  if (probe(runtime)) {
    log(`better-sqlite3 binding already loads under ${runtime}; nothing to do`)
    return
  }

  log(
    `better-sqlite3 binding does not load under ${runtime}; installing the matching prebuild`,
  )
  prebuildInstall(runtime)
  if (probe(runtime)) {
    log(`better-sqlite3 now loads under ${runtime}`)
    return
  }

  log('prebuild-install did not produce a loadable binding; trying the mirror')
  if (await fetchMirrorPrebuild(runtime)) {
    prebuildInstall(runtime)
    if (probe(runtime)) {
      log(`better-sqlite3 now loads under ${runtime} (via mirror)`)
      return
    }
  }

  fail(
    `the better-sqlite3 binding could not be made loadable under ${runtime} ` +
      `(better-sqlite3@${pkgVersion}, platform ${process.platform}-${process.arch})`,
  )
}

// CLI entry. Guarded by argv rather than a separate bin file so the same
// module can be imported (by the vitest globalSetup) without side effects.
const invokedAsCli =
  process.argv[1]?.replace(/\\/g, '/').endsWith('sqlite-abi.ts') ?? false

if (invokedAsCli) {
  const runtime = process.argv[2]
  if (runtime !== 'node' && runtime !== 'electron') {
    fail(`expected "node" or "electron" as the argument, got ${String(runtime)}`)
  }
  // No top-level await: this package is CommonJS (no "type": "module"), and
  // tsx transforms .ts files accordingly — a top-level await is a transform
  // error (measured).
  ensureSqliteAbi(runtime).catch((error: unknown) =>
    fail(`unexpected failure: ${String(error)}`),
  )
}
