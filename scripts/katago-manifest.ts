/**
 * The single pinned source of truth for the KataGo engine and net that the core
 * tier bundles. Every fetch script, the packager config, and the license gate read
 * this — not memory, and not a value re-derived in each caller.
 *
 * ## Why a manifest, and why these values
 *
 * The engine and the net are downloaded executables/weights, not npm packages, so
 * the lockfile cannot pin them. The manifest pins them instead. Its values come
 * from `research/katago-releases.md` and `research/katago-networks.md`
 * (fetched/verified via the GitHub API and katagotraining.org on 2026-09-04):
 *
 * - **Engine v1.18.1** — the latest release with Eigen CPU builds (v1.18.2 is
 *   CUDA-only). Eigen + eigenavx2 builds exist for **windows-x64 and linux-x64
 *   only**; no macOS binaries are published in any release, so there is no darwin
 *   target and macOS reports `unavailable` by construction (scope decision 6).
 * - **Net `kata1-b6c96-s175395328-d26788732`** — final g170 b6c96,
 *   4,967,720 bytes, CC0. The original recommendation was b10c128 (site Elo
 *   11521.7); the Stage-2 benchmark gate (2026-09-06) measured it outside the
 *   live-analysis latency envelope and the pre-agreed contingency swapped it
 *   — see the `weights` block below for the numbers. b10c128 is kept as the
 *   recorded stronger-but-slower alternative.
 * - Both are `.txt.gz`: the g170 imports return 403 for `.bin.gz` (verified) and
 *   KataGo v1.18 loads the older text format (`default_model.txt.gz`).
 *
 * ## Checksums are TOFU, and that is stated rather than hidden
 *
 * KataGo publishes **no** checksums for release binaries and katagotraining.org
 * publishes **no** checksums for nets (both verified 2026-09-04). The `sha256`
 * fields below start `null`; the first fetch from a network that can reach the
 * source records the observed hash into `katago-checksums.json` (the sidecar,
 * committed like a lockfile entry), and from then on every fetch verifies
 * against it — a truncated or substituted file fails loudly instead of
 * shipping. `recordObservedSha256` is the only writer, so the recorded value
 * always comes from a completed download, never from a guess.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A platform-architecture the fetch tooling knows how to target. */
export type EngineTarget = 'win32-x64' | 'linux-x64'

export interface EngineAsset {
  /** Exact release asset filename under the release download URL. */
  readonly file: string
  /** Expected size in bytes, from the release asset listing (verified). */
  readonly bytes: number
  /**
   * Trust-on-first-use sha256. `null` until the first completed download records
   * it; thereafter a mismatch fails the fetch.
   */
  sha256: string | null
  /** Whether the zip wraps a Linux AppImage that must itself be extracted. */
  readonly appImage: boolean
  /** The name the verified archive is kept as in the target directory. */
  readonly archive: string
  /** Name of the executable inside the zip (the AppImage, or the exe directly). */
  readonly binary: string
}

export interface WeightAsset {
  readonly name: string
  readonly url: string
  readonly bytes: number
  /** CC0 — public domain; recorded because NOTICE must name it (D4). */
  readonly license: string
  sha256: string | null
}

export interface KatagoManifest {
  readonly engine: {
    readonly version: string
    readonly releaseUrl: string
    readonly downloadBase: string
    readonly license: string
    /** Vendored components listed in KataGo's LICENSE preamble (cpp/external). */
    readonly vendored: string[]
    readonly targets: Record<EngineTarget, EngineAsset>
  }
  readonly weights: WeightAsset
  /** Recorded fallback if the benchmark gate rejects the primary net. */
  readonly fallbackWeights: WeightAsset
}

const RELEASE_BASE = 'https://github.com/lightvector/KataGo/releases/download'

export const KATAGO_MANIFEST: KatagoManifest = {
  engine: {
    version: 'v1.18.1',
    releaseUrl: 'https://github.com/lightvector/KataGo/releases/tag/v1.18.1',
    downloadBase: `${RELEASE_BASE}/v1.18.1`,
    license: 'MIT',
    vendored: [
      'clblast',
      'composable_kernel_fmha',
      'cudnn-frontend',
      'cutlass',
      'filesystem-1.5.8',
      'half-2.2.0',
      'httplib',
      'katagocoreml',
      'macos Swift modules',
      'mozilla-cacerts',
      'nlohmann_json',
      'sgfmill',
      'onnx',
      'tclap-1.2.5',
    ],
    targets: {
      // +bs50 = 50% larger batch-size build; the default is the right core-tier
      // choice (lower memory, and the CPU tier is visit-latency bound, not
      // batch bound). eigenavx2 over plain eigen: the release notes call AVX2
      // the default pure-CPU build; plain eigen exists only for pre-AVX2 CPUs.
      'win32-x64': {
        file: 'katago-v1.18.1-eigenavx2-windows-x64.zip',
        bytes: 5_899_607,
        sha256: null,
        appImage: false,
        archive: 'katago-v1.18.1-eigenavx2-windows-x64.zip',
        binary: 'katago.exe',
      },
      // The official Linux build is an AppImage inside the zip (research
      // `katago-releases.md`): `binary` names the AppImage, which fetch
      // extracts to the real ELF via `--appimage-extract` (no FUSE in the
      // packaged context, so we never spawn the AppImage itself).
      'linux-x64': {
        file: 'katago-v1.18.1-eigenavx2-linux-x64.zip',
        bytes: 41_821_245,
        sha256: null,
        appImage: true,
        archive: 'katago-v1.18.1-eigenavx2-linux-x64.zip',
        binary: 'katago',
      },
    },
  },

  // The bundled core-tier net is b6c96 — swapped in from b10c128 by the
  // Stage-2/3 benchmark gate (2026-09-06, Ryzen 7 5700X, 4-thread budget,
  // Eigen AVX2): b10c128 returned 500-visit focus reads in ~8.1s (62 v/s),
  // outside the 1–3s useful-read envelope `research/eigen-cpu-throughput.md`
  // framed as "live"; b6c96 does the same read in ~3.4s (148 v/s), fills the
  // sweep at 311 v/s aggregate, and cuts the bundled net from 13.8MB to
  // 5.0MB. It is the weaker net at equal visits (~1560 site Elo), but at
  // equal wall time its 500-visit reads match b10c128's ~150-visit reads,
  // and the core tier's requirement is cursor-following latency (B3), not
  // maximum strength. The measured numbers live in the task's
  // `research/benchmark-eigen.md`; this decision was pre-agreed in the task's
  // implement.md Stage 3.
  weights: {
    name: 'kata1-b6c96-s175395328-d26788732.txt.gz',
    url: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b6c96-s175395328-d26788732.txt.gz',
    bytes: 4_967_720,
    license: 'CC0-1.0',
    sha256: null,
  },

  /** The stronger-but-slower alternative, kept for a future latency tier. */
  fallbackWeights: {
    name: 'kata1-b10c128-s1141046784-d204142634.txt.gz',
    url: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz',
    bytes: 14_466_254,
    license: 'CC0-1.0',
    sha256: null,
  },
}

/** The current platform-arch key for `process.platform`/`process.arch`. */
export function currentEngineTarget(): EngineTarget | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64'
  return null // darwin (any arch), or non-x64 — no official Eigen build (scope 6)
}

/**
 * Records the sha256 observed from a completed download, so the next fetch can
 * verify against it. Idempotent and refuse-to-downgrade: a recorded value is
 * never overwritten by a different one — that would mean the source changed
 * under us, which is exactly what the checksum exists to catch.
 */
export function recordObservedSha256(
  asset: EngineAsset | WeightAsset,
  sha256: string,
): void {
  if (asset.sha256 !== null && asset.sha256 !== sha256) {
    throw new Error(
      `Refusing to record sha256 for ${'file' in asset ? asset.file : asset.name}: ` +
        `already recorded ${asset.sha256}, observed ${sha256}. The source changed — ` +
        `investigate rather than overwrite.`,
    )
  }
  asset.sha256 = sha256
}

/** Asserts a downloaded byte length matches the manifest (cheap truncation catch). */
export function assertSize(asset: EngineAsset | WeightAsset, actual: number): void {
  if (actual !== asset.bytes) {
    throw new Error(
      `Size mismatch for ${'file' in asset ? asset.file : asset.name}: ` +
        `expected ${String(asset.bytes)} bytes, got ${String(actual)}.`,
    )
  }
}

/* ------------------------------------------------------------------------ */
/* TOFU persistence: the checksum sidecar                                   */
/* ------------------------------------------------------------------------ */

/**
 * ## Why a sidecar, and why the manifest cannot hold observed hashes itself
 *
 * `recordObservedSha256` only mutates the in-memory manifest. Run as a CLI the
 * process exits and the observation would be lost — so "every subsequent fetch
 * verifies against it" would never begin, and a same-size corrupted cache file
 * would be re-recorded and reused instead of rejected (the exact gap B2's
 * scripted check, "corrupt the cache, re-run fetch", exists to close).
 *
 * The observed hashes therefore persist to `katago-checksums.json` beside this
 * file. It is written after a successful fetch and committed like a lockfile
 * entry: from then on, every fetch — including CI's — verifies against the
 * recorded value instead of recording a fresh one. Until the file exists the
 * chain stays in record mode, which is the honest statement of what is known.
 *
 * The manifest stays the reviewed source of truth: `applyRecordedChecksums`
 * fills only `null` slots, never overwrites a hash pinned in source. If the
 * sidecar and the manifest ever disagree, the manifest wins and the sidecar
 * value is dropped — an edited manifest is reviewed; a sidecar is merely read.
 */

const CHECKSUMS_PATH = join(import.meta.dirname, 'katago-checksums.json')

/** Observed sha256 values keyed by asset id (`engine:win32-x64`, `weights`, …). */
export type RecordedChecksums = Readonly<Record<string, { readonly sha256: string }>>

/** Sidecar asset ids for every entry in the manifest, in stable write order. */
function knownAssets(): readonly (readonly [string, EngineAsset | WeightAsset])[] {
  return [
    ...Object.entries(KATAGO_MANIFEST.engine.targets).map(
      ([target, asset]) => [`engine:${target}`, asset] as const,
    ),
    ['weights', KATAGO_MANIFEST.weights] as const,
    ['fallbackWeights', KATAGO_MANIFEST.fallbackWeights] as const,
  ]
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Reads the checksum sidecar. A missing or malformed file yields `{}` — the
 * chain falls back to record mode rather than failing; the fetch itself is the
 * operation that must fail loudly, not the optional prior observation.
 * Injectable path so tests never touch the real sidecar.
 */
export function readRecordedChecksums(
  path: string = CHECKSUMS_PATH,
): RecordedChecksums {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const assets: unknown = (parsed as { assets?: unknown }).assets
  if (typeof assets !== 'object' || assets === null) return {}

  const out: Record<string, { sha256: string }> = {}
  for (const [key, value] of Object.entries(assets)) {
    if (typeof value !== 'object' || value === null) continue
    const sha256: unknown = (value as { sha256?: unknown }).sha256
    if (typeof sha256 === 'string' && SHA256_HEX.test(sha256)) {
      out[key] = { sha256 }
    }
  }
  return out
}

/**
 * Fills `null` sha256 slots in the manifest from a sidecar read. Never
 * overwrites a value pinned in source — see the section comment above.
 */
export function applyRecordedChecksums(recorded: RecordedChecksums): void {
  for (const [key, asset] of knownAssets()) {
    const observed = recorded[key]?.sha256
    if (observed !== undefined && asset.sha256 === null) {
      asset.sha256 = observed
    }
  }
}

/** Writes every known non-null sha256 to the sidecar. Injectable path for tests. */
export function persistRecordedChecksums(path: string = CHECKSUMS_PATH): void {
  const assets: Record<string, { sha256: string }> = {}
  for (const [key, asset] of knownAssets()) {
    if (asset.sha256 !== null) assets[key] = { sha256: asset.sha256 }
  }
  const doc = { version: 1, assets }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}
