import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  engineTargetFor,
  planEngineLaunch,
  resolveEngineLayout,
  selectNetworkFile,
  type EngineFs,
} from '../../src/main/katago/locate'

/**
 * `locate.ts` decision logic, pure: every OS fact arrives as an argument, so
 * the policy under test is the policy in production. The load-bearing
 * decisions (`design.md` §Where the engine binary lives):
 *
 * - the env override wins over the bundled layout, and is checked for
 *   existence only (a demanded binary that is not there is `failed`, not
 *   "fall back to the bundled one");
 * - a missing bundled binary means `dev` (fetch not run → degrade) or
 *   `packaged` (a zero-config build with no engine → fail) — the outcome
 *   carries which, because the service maps them to different statuses;
 * - the weights file is whichever single net the directory holds — the
 *   directory is the authority, so there is no second copy of the pinned name
 *   to drift.
 *
 * `electron` is mocked (as in the handlers suite) so importing `paths.ts`
 * through `locate.ts` cannot touch a real app path even by accident.
 *
 * Paths here are built with `join` (not forward-slash literals) because
 * production builds them with `join`: on Windows the separator is `\`, and
 * the fake fs must speak the same separator the code under test does.
 */
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/virtual/app',
    getPath: () => '/virtual/userData',
  },
}))

/** Absolute platform-joined path: `/res/...` on POSIX, `\res\...` on Windows. */
const p = (...segments: readonly string[]): string => join('/', ...segments)

const BINARY = p('res', 'katago', 'win32-x64', 'katago.exe')
const BINARIES_DIR = p('res', 'katago', 'win32-x64')
const WEIGHTS_DIR = p('res', 'weights')
const NET = p('res', 'weights', 'net.txt.gz')
const OVERRIDE = p('override', 'katago')
const GONE = p('gone', 'katago')

/** In-memory fs: `files` are the paths that exist; `executables` the subset. */
function fakeFs(entries: {
  files?: readonly string[]
  executables?: readonly string[]
  dirs?: Readonly<Record<string, readonly string[]>>
}): EngineFs {
  const files = new Set(entries.files ?? [])
  const executables = new Set(entries.executables ?? [])
  const dirs = entries.dirs ?? {}
  return {
    exists: (path) => files.has(path),
    executable: (path) => files.has(path) && executables.has(path),
    list: (dir) => dirs[dir] ?? [],
  }
}

const ROOTS = {
  binariesDir: BINARIES_DIR,
  weightsDir: WEIGHTS_DIR,
  binaryName: 'katago.exe',
} as const

describe('engineTargetFor', () => {
  it('maps supported platforms to their fetch targets', () => {
    expect(engineTargetFor('win32', 'x64')).toBe('win32-x64')
    expect(engineTargetFor('linux', 'x64')).toBe('linux-x64')
  })

  it('returns null for platforms with no official Eigen build', () => {
    // macOS is the deliberate one (scope decision 6 — no binaries published).
    expect(engineTargetFor('darwin', 'arm64')).toBeNull()
    expect(engineTargetFor('darwin', 'x64')).toBeNull()
    // And non-x64 architectures of supported platforms have no target either.
    expect(engineTargetFor('win32', 'arm64')).toBeNull()
    expect(engineTargetFor('linux', 'arm64')).toBeNull()
  })
})

describe('selectNetworkFile', () => {
  it('returns the single net file in the directory', () => {
    expect(selectNetworkFile(['README.md', 'net.txt.gz'])).toBe('net.txt.gz')
    expect(selectNetworkFile(['net.bin.gz'])).toBe('net.bin.gz')
  })

  it('ignores the README, and a lone partial is not a net', () => {
    expect(selectNetworkFile(['README.md', 'net.txt.gz'])).toBe('net.txt.gz')
    // An interrupted fetch leaves `net.txt.gz.partial`; it is not a usable
    // network (KataGo would fail to load the truncated model) and does not
    // satisfy the suffix match, so it cannot be mistaken for one.
    expect(selectNetworkFile(['net.txt.gz.partial'])).toBeNull()
  })

  it('returns null when there is no net', () => {
    expect(selectNetworkFile(['README.md'])).toBeNull()
    expect(selectNetworkFile([])).toBeNull()
  })

  it('returns null when more than one net is present', () => {
    expect(selectNetworkFile(['a.txt.gz', 'b.bin.gz'])).toBeNull()
  })
})

describe('resolveEngineLayout', () => {
  it('prefers the env override over the bundled binary', () => {
    const fs = fakeFs({
      files: [OVERRIDE, BINARY],
      dirs: { [WEIGHTS_DIR]: ['net.txt.gz'] },
    })
    const outcome = resolveEngineLayout({
      envOverride: OVERRIDE,
      ...ROOTS,
      isPackaged: true,
      fs,
    })
    // Weights still come from the bundled directory.
    expect(outcome).toEqual({
      kind: 'found',
      binary: OVERRIDE,
      network: NET,
    })
  })

  it('override pointing at nothing is binary-missing in override mode', () => {
    const outcome = resolveEngineLayout({
      envOverride: GONE,
      ...ROOTS,
      isPackaged: false,
      fs: fakeFs({}),
    })
    expect(outcome).toEqual({
      kind: 'binary-missing',
      searched: GONE,
      mode: 'override',
    })
  })

  it('the override is existence-checked, not execute-bit-checked', () => {
    // A support override may name a script or a homebrew build; the spawn is
    // the proof of executability, so an X_OK probe would be wrong here.
    const fs = fakeFs({
      files: [OVERRIDE], // not in executables
      dirs: { [WEIGHTS_DIR]: ['net.txt.gz'] },
    })
    const outcome = resolveEngineLayout({
      envOverride: OVERRIDE,
      ...ROOTS,
      isPackaged: true,
      fs,
    })
    expect(outcome.kind).toBe('found')
  })

  it('a platform without a bundled target reports unsupported', () => {
    const outcome = resolveEngineLayout({
      envOverride: undefined,
      binariesDir: null,
      weightsDir: WEIGHTS_DIR,
      binaryName: null,
      isPackaged: true,
      fs: fakeFs({}),
    })
    expect(outcome).toEqual({ kind: 'unsupported' })
  })

  it('missing bundled binary is dev mode when not packaged', () => {
    const outcome = resolveEngineLayout({
      envOverride: undefined,
      ...ROOTS,
      isPackaged: false,
      fs: fakeFs({ dirs: { [WEIGHTS_DIR]: ['net.txt.gz'] } }),
    })
    expect(outcome).toEqual({
      kind: 'binary-missing',
      searched: BINARY,
      mode: 'dev',
    })
  })

  it('missing bundled binary is packaged mode when packaged', () => {
    const outcome = resolveEngineLayout({
      envOverride: undefined,
      ...ROOTS,
      isPackaged: true,
      fs: fakeFs({ dirs: { [WEIGHTS_DIR]: ['net.txt.gz'] } }),
    })
    expect(outcome).toEqual({
      kind: 'binary-missing',
      searched: BINARY,
      mode: 'packaged',
    })
  })

  it('a binary that exists but is not executable is its own outcome', () => {
    const fs = fakeFs({
      files: [BINARY],
      executables: [],
      dirs: { [WEIGHTS_DIR]: ['net.txt.gz'] },
    })
    const outcome = resolveEngineLayout({
      envOverride: undefined,
      ...ROOTS,
      isPackaged: true,
      fs,
    })
    expect(outcome).toEqual({
      kind: 'binary-not-executable',
      path: BINARY,
      mode: 'packaged',
    })
  })

  it('missing weights is reported after the binary checks pass', () => {
    const fs = fakeFs({
      files: [BINARY],
      executables: [BINARY],
      dirs: { [WEIGHTS_DIR]: ['README.md'] },
    })
    const outcome = resolveEngineLayout({
      envOverride: undefined,
      ...ROOTS,
      isPackaged: false,
      fs,
    })
    expect(outcome).toEqual({ kind: 'network-missing', dir: WEIGHTS_DIR, mode: 'dev' })
  })

  it('two nets in the directory is ambiguous, never a silent pick', () => {
    const fs = fakeFs({
      files: [BINARY],
      executables: [BINARY],
      dirs: { [WEIGHTS_DIR]: ['a.txt.gz', 'b.txt.gz'] },
    })
    const outcome = resolveEngineLayout({
      envOverride: undefined,
      ...ROOTS,
      isPackaged: true,
      fs,
    })
    expect(outcome).toEqual({
      kind: 'network-ambiguous',
      dir: WEIGHTS_DIR,
      matches: ['a.txt.gz', 'b.txt.gz'],
      mode: 'packaged',
    })
  })

  it('resolves a complete bundled layout to found with both paths', () => {
    const fs = fakeFs({
      files: [BINARY],
      executables: [BINARY],
      dirs: { [WEIGHTS_DIR]: ['README.md', 'net.txt.gz'] },
    })
    const outcome = resolveEngineLayout({
      envOverride: undefined,
      ...ROOTS,
      isPackaged: true,
      fs,
    })
    expect(outcome).toEqual({
      kind: 'found',
      binary: BINARY,
      network: NET,
    })
  })
})

describe('planEngineLaunch', () => {
  const EXEC = p('usr', 'bin', 'electron-or-node')

  it('spawns a native binary directly, with no prefix args and no extra env', () => {
    expect(planEngineLaunch(BINARY, EXEC)).toEqual({
      command: BINARY,
      prefixArgs: [],
      env: null,
    })
  })

  it('runs a TypeScript script override through the app runtime with tsx', () => {
    // The env-override diagnostics seam can name a .ts file (the e2e fake does);
    // no platform execs TypeScript directly, so the plan resolves to the app's
    // own runtime with the tsx loader and the run-as-node switch.
    const script = p('tools', 'fake-katago-child.ts')
    expect(planEngineLaunch(script, EXEC)).toEqual({
      command: EXEC,
      prefixArgs: ['--import', 'tsx', script],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('treats every script extension as a script, case-insensitively', () => {
    for (const name of ['a.mts', 'a.cts', 'a.mjs', 'a.cjs', 'a.js', 'a.TS']) {
      const script = p('tools', name)
      const launch = planEngineLaunch(script, EXEC)
      expect(launch.command, name).toBe(EXEC)
      expect(launch.prefixArgs, name).toEqual(['--import', 'tsx', script])
      expect(launch.env, name).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    }
  })

  it('does not mistake the bundled katago names for scripts', () => {
    // `katago.exe` and `katago` end in nothing script-like; the discriminator
    // is the extension, so these must stay direct spawns.
    expect(planEngineLaunch(p('bin', 'katago'), EXEC).command).toBe(p('bin', 'katago'))
    expect(planEngineLaunch(p('bin', 'katago.exe'), EXEC).env).toBeNull()
  })
})
