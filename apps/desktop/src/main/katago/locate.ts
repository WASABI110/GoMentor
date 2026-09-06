import { accessSync, constants as fsConstants, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { engineBinariesDir, weightsResourcesDir } from '../paths'

/**
 * Resolves the engine binary and network weights for this machine.
 *
 * Three contexts, one decision (`design.md` §Where the engine binary lives):
 *
 * - **Packaged** — `process.resourcesPath/katago/<platform>-<arch>/`, copied
 *   there by `extraResources` from the fetch layout.
 * - **Dev** — `apps/desktop/resources/katago/<platform>-<arch>/`, the same
 *   fetch layout in the repo.
 * - **Override** — `GOMENTOR_KATAGO_BINARY` names a binary directly (e2e
 *   against the fake, support diagnostics). Checked *first*: an explicit
 *   pointer wins over the bundled layout.
 *
 * The decision itself is pure (`resolveEngineLayout`): every OS fact arrives
 * as an argument through the `EngineFs` seam, so the policy — override beats
 * bundled, missing means different things in dev vs packaged — is unit-testable
 * and mutation-covered without a filesystem. `locateBundledEngine` is the thin
 * Electron-bound wrapper that gathers the facts.
 *
 * ## Why missing is two different states
 *
 * A packaged build promises zero-config; a missing binary there is a packaging
 * defect and must fail loudly (`failed`, `ENGINE_BINARY_MISSING`). In dev it
 * almost always means `pnpm fetch:katago` has not been run, which is a normal
 * Tuesday, so it degrades to `unavailable` with a log line saying exactly what
 * to fetch. The outcome carries the `mode` so the service can make that call.
 */

/** Platforms with an official KataGo Eigen build (`scripts/katago-manifest.ts`). */
export type EngineTarget = 'win32-x64' | 'linux-x64'

/** Executable name inside the platform directory, as the fetch script extracts it. */
const BINARY_NAMES: Record<EngineTarget, string> = {
  'win32-x64': 'katago.exe',
  'linux-x64': 'katago',
}

/**
 * The platform-arch key for a `process.platform`/`process.arch` pair, or null
 * where no official Eigen build exists. macOS is null **by construction**
 * (scope decision 6 — no macOS binaries are published in any KataGo release),
 * which is what makes `unavailable` the honest darwin state.
 */
export function engineTargetFor(platform: string, arch: string): EngineTarget | null {
  if (arch !== 'x64') return null
  if (platform === 'win32') return 'win32-x64'
  if (platform === 'linux') return 'linux-x64'
  return null
}

/**
 * Filesystem seam. Tests supply in-memory implementations; the production
 * binding is `nodeEngineFs` below. `list` returns entry names (not paths) and
 * yields an empty array for a missing directory — an absent weights dir is a
 * first-launch state, not an I/O error.
 */
export interface EngineFs {
  exists(path: string): boolean
  executable(path: string): boolean
  list(dir: string): readonly string[]
}

export const nodeEngineFs: EngineFs = {
  exists: (path) => existsSync(path),
  executable(path) {
    // Windows has no execute bit — presence is the whole check there. POSIX
    // gets the real X_OK probe so a fetch that died before `chmod 755` is
    // caught here rather than as a confusing `spawn EACCES`.
    if (process.platform === 'win32') return true
    try {
      accessSync(path, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  },
  list(dir) {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
}

export type LocateMode = 'dev' | 'packaged' | 'override'

export type LocateOutcome =
  | { readonly kind: 'found'; readonly binary: string; readonly network: string }
  | { readonly kind: 'unsupported' }
  | {
      readonly kind: 'binary-missing'
      readonly searched: string
      readonly mode: LocateMode
    }
  | {
      readonly kind: 'binary-not-executable'
      readonly path: string
      readonly mode: Exclude<LocateMode, 'override'>
    }
  | {
      readonly kind: 'network-missing'
      readonly dir: string
      readonly mode: LocateMode
    }
  | {
      readonly kind: 'network-ambiguous'
      readonly dir: string
      readonly matches: readonly string[]
      readonly mode: LocateMode
    }

export interface ResolveEngineLayoutInput {
  /** `process.env['GOMENTOR_KATAGO_BINARY']`, when set to a non-empty string. */
  readonly envOverride: string | undefined
  /** Bundled binaries directory, or null when the platform has no target. */
  readonly binariesDir: string | null
  /** Bundled weights directory — platform-independent, always present. */
  readonly weightsDir: string
  /** Bundled executable name, or null when the platform has no target. */
  readonly binaryName: string | null
  readonly isPackaged: boolean
  readonly fs: EngineFs
}

/**
 * The weights file is whichever single net the fetch tooling placed in the
 * weights directory — the directory is the authority, so there is no second
 * copy of the pinned net name to drift from the manifest. Fetch artifacts
 * (`*.partial`) and the explanatory README do not match the suffixes and are
 * ignored. Zero matches means "not fetched"; more than one means someone
 * dropped an extra net in and picking silently would be a guess.
 */
export function selectNetworkFile(entries: readonly string[]): string | null {
  const matches = entries.filter(
    (entry) => entry.endsWith('.txt.gz') || entry.endsWith('.bin.gz'),
  )
  return matches.length === 1 ? (matches[0] ?? null) : null
}

type NetworkOutcome =
  | { readonly kind: 'found'; readonly network: string }
  | {
      readonly kind: 'network-missing'
      readonly dir: string
      readonly mode: LocateMode
    }
  | {
      readonly kind: 'network-ambiguous'
      readonly dir: string
      readonly matches: readonly string[]
      readonly mode: LocateMode
    }

function resolveNetwork(
  weightsDir: string,
  mode: LocateMode,
  fs: EngineFs,
): NetworkOutcome {
  const entries = fs.list(weightsDir)
  const network = selectNetworkFile(entries)
  if (network === null) {
    const named = entries.filter(
      (entry) => entry !== 'README.md' && !entry.endsWith('.partial'),
    )
    if (named.length > 1) {
      return { kind: 'network-ambiguous', dir: weightsDir, matches: named, mode }
    }
    return { kind: 'network-missing', dir: weightsDir, mode }
  }
  return { kind: 'found', network: join(weightsDir, network) }
}

/**
 * Pure resolution. Returns `found` only when both the binary and exactly one
 * network are present; every other outcome carries what the service needs to
 * choose between `unavailable` and `failed`.
 */
export function resolveEngineLayout(input: ResolveEngineLayoutInput): LocateOutcome {
  const defaultMode: LocateMode = input.isPackaged ? 'packaged' : 'dev'

  if (input.envOverride !== undefined && input.envOverride !== '') {
    // The override names a program the caller guarantees is spawnable, so the
    // check is existence: support diagnostics may point at a script or a
    // homebrew build, where an execute-bit probe would be both wrong and
    // redundant — the spawn itself is the proof. Weights still come from the
    // bundled directory; an engine without a network cannot analyse anything.
    if (!input.fs.exists(input.envOverride)) {
      return { kind: 'binary-missing', searched: input.envOverride, mode: 'override' }
    }
    const network = resolveNetwork(input.weightsDir, 'override', input.fs)
    if (network.kind !== 'found') return network
    return { kind: 'found', binary: input.envOverride, network: network.network }
  }

  if (input.binariesDir === null || input.binaryName === null) {
    // No bundled target for this platform (macOS, non-x64). Distinct from
    // every "missing" outcome: nothing is wrong, there is nothing to fetch.
    return { kind: 'unsupported' }
  }

  const binary = join(input.binariesDir, input.binaryName)
  if (!input.fs.exists(binary)) {
    return { kind: 'binary-missing', searched: binary, mode: defaultMode }
  }
  if (!input.fs.executable(binary)) {
    return { kind: 'binary-not-executable', path: binary, mode: defaultMode }
  }
  const network = resolveNetwork(input.weightsDir, defaultMode, input.fs)
  if (network.kind !== 'found') return network
  return { kind: 'found', binary, network: network.network }
}

/**
 * The Electron-bound entry point: gathers `process`/filesystem facts and
 * delegates the decision to `resolveEngineLayout`. The override is honoured
 * on every platform — a macOS build with `GOMENTOR_KATAGO_BINARY` pointing at
 * a working engine is a legitimate diagnostics setup even though no bundled
 * darwin binary exists.
 */
export function locateBundledEngine(
  env: NodeJS.ProcessEnv = process.env,
): LocateOutcome {
  const target = engineTargetFor(process.platform, process.arch)
  return resolveEngineLayout({
    envOverride: env['GOMENTOR_KATAGO_BINARY'],
    binariesDir: target === null ? null : engineBinariesDir(target),
    weightsDir: weightsResourcesDir(),
    binaryName: target === null ? null : BINARY_NAMES[target],
    isPackaged: app.isPackaged,
    fs: nodeEngineFs,
  })
}

// ---------------------------------------------------------------------------
// Launch planning
// ---------------------------------------------------------------------------

/**
 * How to exec one resolved engine binary. Usually the binary itself; a script
 * override needs an interpreter.
 */
export interface EngineLaunch {
  /** The program to spawn. */
  readonly command: string
  /** Arguments that must precede the service's `analysis -config …` argv. */
  readonly prefixArgs: readonly string[]
  /**
   * Extra environment for the child, or null to inherit unchanged. Only ever
   * set for the script-override path.
   */
  readonly env: Readonly<Record<string, string>> | null
}

const SCRIPT_EXTENSIONS = /\.(?:ts|mts|cts|mjs|cjs|js)$/i

/**
 * Plans the exec for a resolved engine binary.
 *
 * The env override (`GOMENTOR_KATAGO_BINARY`) is a diagnostics seam — e2e
 * against the fake, support pointing at a homebrew build — and in those
 * contexts the target can be a TypeScript/JavaScript *script*, which no
 * platform execs directly. A script is unambiguous (the bundled binaries are
 * `katago`/`katago.exe`), so the extension is a safe discriminator: scripts
 * run under the app's own runtime with the tsx loader, and `ELECTRON_RUN_AS
 * NODE=1` makes an Electron `process.execPath` behave as Node for the child
 * (native binaries ignore the variable; it is set only here, never app-wide).
 * Under vitest `execPath` already is Node and the variable is inert.
 *
 * Packaged apps do not ship tsx, so a script override fails there with a
 * clear spawn error — acceptable, because overrides are a dev/CI diagnostics
 * path, not a user feature.
 */
export function planEngineLaunch(binary: string, execPath: string): EngineLaunch {
  if (SCRIPT_EXTENSIONS.test(binary)) {
    return {
      command: execPath,
      prefixArgs: ['--import', 'tsx', binary],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return { command: binary, prefixArgs: [], env: null }
}
