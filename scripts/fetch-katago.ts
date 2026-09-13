/**
 * Fetches the KataGo executable into `apps/desktop/resources/katago`. **Real.**
 *
 * Replaces the M1 stub: this now downloads, verifies, and extracts the pinned
 * Eigen CPU build for the current platform. See `fetch-engine.ts` for the
 * download/resume/checksum contract and `katago-manifest.ts` for the pinned
 * version and per-platform asset facts.
 *
 * ## Layout: per-platform subdirectories
 *
 * The binary lands under `resources/katago/<platform>-<arch>/` (e.g.
 * `win32-x64/`, `linux-x64/`, `darwin-arm64/`). `electron-builder.yml` selects
 * the matching subdirectory per platform via `extraResources`, so an installer
 * ships only its own OS/arch binary rather than every platform's (the tier is
 * sized for one). darwin targets fetch the **source builds** GoMentor's own CI
 * publishes (M5; `katago-manifest.ts` `sourceBuilds`) — there is no official
 * macOS upstream binary, and platforms with no target at all (linux-arm64
 * etc.) still exit 0 with an explanatory line.
 *
 * ## The two-stage Linux extraction
 *
 * The official Linux build is an **AppImage inside the release zip** (research
 * `katago-releases.md`). So for `linux-x64` the flow is: download+verify the zip,
 * extract it to recover the AppImage, then run the AppImage with
 * `--appimage-extract` to unpack the real ELF payload — because a bundled
 * AppImage nested inside an AppImage/AppDir has no FUSE in the packaged context
 * and does not run. The spawnable on Linux is the extracted `usr/bin/katago`,
 * flattened into the target directory alongside any libraries it needs.
 *
 * Run: `pnpm fetch:katago`   (current platform; `--all` fetches every target)
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KATAGO_MANIFEST,
  applyRecordedChecksums,
  currentEngineTarget,
  engineDownloadBase,
  persistRecordedChecksums,
  readRecordedChecksums,
  type EngineAsset,
  type EngineTarget,
} from '../packages/engines/src/katago-manifest'

/** The committed TOFU sidecar, beside the manifest it belongs to. */
const SIDECAR = fileURLToPath(
  new URL('../packages/engines/src/katago-checksums.json', import.meta.url),
)
import {
  engineDir,
  ensureFetched,
  extractAppImage,
  extractZip,
  makeExecutable,
} from '../packages/engines/src/fetch-engine'
import { RESOURCES_ROOT } from './resources'

const fetchAll = process.argv.includes('--all')
const fetchGpu = process.argv.includes('--gpu')

/** The spawnable binary name after full extraction (AppImage payload or the exe). */
const SPAWNABLE = 'katago'

/** Mirrors packages/core `backends.ts` GPU_BACKENDS — scripts do not import core. */
const GPU_BACKENDS = ['cuda', 'opencl'] as const

/** Fetches one platform target; returns a human-readable outcome line. */
async function fetchTarget(target: EngineTarget): Promise<string> {
  const asset = KATAGO_MANIFEST.engine.targets[target]
  const url = `${engineDownloadBase(target)}/${asset.file}`
  const dir = engineDir(RESOURCES_ROOT, target)

  // Stage 1: download + verify the release zip, resuming across runs. The zip
  // lands as `<binary>.partial` then renames to the asset's `binary` name (the
  // AppImage on Linux, the exe on Windows) — a verified archive, not yet the
  // spawnable. ensureFetched's size+sha256 gate runs here.
  const archive = await ensureFetched(asset, url, dir)
  await extractEngine(archive.path, dir, asset)

  // Extraction is not yet idempotent across the AppImage two-stage path, so a
  // re-run that reused a verified archive still re-extracts. That is correct
  // (extraction is cheap relative to a 40MB download) but worth stating.
  const verb = archive.reused ? 'reused archive, re-extracted' : 'fetched + extracted'
  return `${target}: ${verb} ${asset.file} -> ${dir}/${SPAWNABLE} sha256=${archive.sha256}`
}

async function extractEngine(
  archivePath: string,
  dir: string,
  asset: EngineAsset,
): Promise<void> {
  if (!asset.appImage) {
    // Windows: the zip holds the exe and its co-located DLLs; flatten them all
    // into the target dir (the DLL-load contract in fetch-engine.ts).
    await extractZip(archivePath, dir)
    await makeExecutable(join(dir, asset.binary))
    return
  }

  // Linux: recover the AppImage from the verified zip, then extract its payload.
  // The stage tree is an intermediate — it must not survive into the target
  // directory, or it would ride into the installer through extraResources.
  const stage = join(dir, '.zip-stage')
  await extractZip(archivePath, stage)
  await extractAppImage(join(stage, asset.binary), dir)
  await rm(stage, { recursive: true, force: true })
  await makeExecutable(join(dir, SPAWNABLE))
}

/**
 * Fetches the tier-2 GPU backends for the current platform into
 * `<target>-<backend>` directories (the layout `locate.ts`'s
 * `selectBundledDir` resolves when `settings.engine.backend` names one).
 * Both backends, sequentially: the point of tier-2 is choice — a machine
 * whose CUDA runtime is missing still gets OpenCL.
 */
async function fetchGpuBackends(): Promise<void> {
  const target = currentEngineTarget()
  if (target === null || target.startsWith('darwin-')) {
    console.log(`fetch-katago: no GPU tier-2 for ${process.platform}-${process.arch}`)
    return
  }
  for (const backend of GPU_BACKENDS) {
    const asset =
      KATAGO_MANIFEST.engine.tier2[backend][target as 'win32-x64' | 'linux-x64']
    const url = `${engineDownloadBase(target)}/${asset.file}`
    const dir = engineDir(RESOURCES_ROOT, `${target}-${backend}`)
    const archive = await ensureFetched(asset, url, dir)
    // Tier-2 zips carry the engine and (for CUDA) its co-located runtime
    // DLLs — the same flatten-into-one-directory contract as tier-1.
    await extractZip(archive.path, dir)
    await makeExecutable(join(dir, asset.binary))
    persistRecordedChecksums(SIDECAR)
    console.log(
      `${target}-${backend}: ${archive.reused ? 'reused' : 'fetched'} ${asset.file} -> ${dir}`,
    )
  }
}

async function main(): Promise<void> {
  // Sidecar first: once a recorded hash exists, this run verifies the archive
  // against it instead of recording a fresh one (TOFU — see katago-manifest.ts).
  applyRecordedChecksums(readRecordedChecksums(SIDECAR))

  if (fetchGpu) {
    await fetchGpuBackends()
    return
  }

  if (fetchAll) {
    const targets = Object.keys(KATAGO_MANIFEST.engine.targets) as EngineTarget[]
    for (const target of targets) {
      console.log(await fetchTarget(target))
      // Persist per target, not once at the end: a later target's failure (the
      // Linux AppImage cannot extract on a non-Linux host — `--appimage-extract`
      // executes the image) must not discard an earlier completed download's
      // TOFU record, and a 40MB re-download is the cost of losing it.
      persistRecordedChecksums(SIDECAR)
    }
    return
  }

  const current = currentEngineTarget()
  if (current === null) {
    // Not an error: this platform-arch has no engine target at all (e.g.
    // linux-arm64, windows-arm64). Exiting 0 lets CI run without a fetch
    // special-case; the app reports `unavailable` there by construction. A
    // non-zero exit would imply a fetch was possible and failed, which is not
    // what "no target exists" means.
    console.log(
      `fetch-katago: no engine build exists for ${process.platform}-${process.arch}; ` +
        'nothing to fetch (see scripts/katago-manifest.ts for the supported targets).',
    )
    return
  }
  console.log(await fetchTarget(current))
  persistRecordedChecksums(SIDECAR)
}

main().catch((error: unknown) => {
  console.error('fetch-katago failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
