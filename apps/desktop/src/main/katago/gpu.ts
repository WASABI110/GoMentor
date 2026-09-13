import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineBackend } from '@gomentor/shared'
import { AppError } from '@gomentor/shared'
import {
  KATAGO_MANIFEST,
  applyRecordedChecksums,
  currentEngineTarget,
  engineDownloadBase,
  readRecordedChecksums,
  type EngineTarget,
} from '@gomentor/engines'
import { ensureFetched, extractZip, makeExecutable } from '@gomentor/engines'
import { scoped } from '../logger'
import { engineBinariesDir } from '../paths'

/**
 * GPU tier-2 download service (M5 Stage 4): the in-app face of the same fetch
 * pipeline the CLI drives (`pnpm fetch:gpu`). One backend download at a time
 * — two writers to one `.partial` file would corrupt each other's resumes —
 * and every state change lands on `gpu:progress`, byte-throttled to at most
 * one emission per 512 KB so a fast link cannot flood the renderer (the same
 * coalescing rule the analysis ticks follow).
 *
 * ## The @gomentor/engines import
 *
 * The manifest is the single pinned source of truth for the engine assets;
 * importing it (rather than restating asset facts in the app) keeps one
 * authority, and `fetch-engine` is one verified download/resume/checksum
 * implementation shared with the CLI and CI. The package was extracted from
 * `scripts/` for exactly this: a cross-tree source import fought the desktop
 * package's CJS TypeScript settings (measured, reverted), while a workspace
 * package is aliased into the electron-vite bundle like shared and core.
 *
 * ## The ensure seam
 *
 * The fetch pipeline is injectable (`deps.ensure`): production binds the real
 * `ensureFetched`+extract against the manifest, unit tests script it — the
 * service's own logic (slot, states, throttling, refusal) is what the unit
 * suite pins, and the real pipeline is proven live by the CLI run.
 *
 * ## Where the bytes go, and who may write there
 *
 * The layout is `engineBinariesDir('<target>-<backend>')` — the same tree
 * `locate.ts`'s `selectBundledDir` resolves, so a downloaded backend is
 * immediately usable with no second lookup convention. A per-user install
 * (the default NSIS layout) keeps that directory user-writable; a read-only
 * install location surfaces as a typed download error from the pipeline, not
 * a crash.
 */

const logger = scoped('main:katago:gpu')

export type DownloadableBackend = Exclude<EngineBackend, 'eigen' | 'tensorrt'>
export const DOWNLOADABLE_BACKENDS: readonly DownloadableBackend[] = ['cuda', 'opencl']

export interface GpuProgress {
  readonly backend: DownloadableBackend
  readonly state: 'downloading' | 'extracting' | 'done' | 'error'
  readonly received?: number
  readonly total?: number | null
  readonly error?: string
}

export interface GpuBackendState {
  backend: DownloadableBackend
  downloaded: boolean
  preferred: boolean
}

export interface GpuServiceDeps {
  /** `settings.engine.backend`, read live (not cached at construction). */
  readonly preference: () => EngineBackend | null
  /** Null on a platform with no tier-2 assets: status works, downloads refuse. */
  readonly target: EngineTarget | null
  /** The layout directory for one backend. */
  readonly dirFor: (backend: DownloadableBackend) => string
  /** The app-writable TOFU sidecar (userData; see paths.enginesChecksumsFile). */
  readonly checksumsPath: string
  readonly emitProgress: (progress: GpuProgress) => void
  /**
   * The fetch pipeline for one backend: download (reporting byte progress)
   * and extract. Production binds `ensureFetched`+extract; tests script it.
   */
  readonly ensure: (
    backend: DownloadableBackend,
    onProgress: (received: number, total: number | null) => void,
  ) => Promise<void>
}

const THROTTLE_BYTES = 512 * 1024

type Tier2Target = 'win32-x64' | 'linux-x64'

function tier2Asset(
  backend: DownloadableBackend,
  target: EngineTarget | null,
):
  | {
      ok: true
      asset: EngineTarget extends never
        ? never
        : { binary: string; bytes: number; file: string }
    }
  | { ok: false } {
  if (target === null || target === 'darwin-arm64' || target === 'darwin-x64') {
    return { ok: false }
  }
  // The tier-2 records are total over win32-x64/linux-x64, so the lookup is
  // defined whenever the target survives the guard above.
  return { ok: true, asset: KATAGO_MANIFEST.engine.tier2[backend][target] }
}

export interface GpuService {
  status: () => { backends: GpuBackendState[] }
  download: (backend: DownloadableBackend) => { started: boolean }
}

export function createGpuService(deps: GpuServiceDeps): GpuService {
  // TOFU sidecar first: once a hash is recorded, every fetch verifies against
  // it (same chain as the CLI).
  applyRecordedChecksums(readRecordedChecksums(deps.checksumsPath))

  let inFlight: DownloadableBackend | null = null

  function isDownloaded(backend: DownloadableBackend): boolean {
    const probe = tier2Asset(backend, deps.target)
    if (!probe.ok) return false
    return existsSync(join(deps.dirFor(backend), probe.asset.binary))
  }

  function status(): { backends: GpuBackendState[] } {
    const preference = deps.preference()
    return {
      backends: DOWNLOADABLE_BACKENDS.map((backend) => ({
        backend,
        downloaded: isDownloaded(backend),
        preferred: preference === backend,
      })),
    }
  }

  function download(backend: DownloadableBackend): { started: boolean } {
    if (inFlight !== null) {
      throw new AppError(
        'GPU_ALREADY_DOWNLOADING',
        `a ${inFlight} download is already running`,
      )
    }
    const probe = tier2Asset(backend, deps.target)
    if (!probe.ok) {
      throw new AppError(
        'GPU_PLATFORM_UNSUPPORTED',
        `no tier-2 assets exist for ${String(deps.target)}`,
      )
    }
    inFlight = backend
    let lastEmitted = 0

    void (async () => {
      try {
        deps.emitProgress({
          backend,
          state: 'downloading',
          received: 0,
          total: probe.asset.bytes,
        })
        await deps.ensure(backend, (received, total) => {
          // Throttle: every 512 KB past the last emission.
          if (received - lastEmitted >= THROTTLE_BYTES) {
            lastEmitted = received
            deps.emitProgress({ backend, state: 'downloading', received, total })
          }
        })
        lastEmitted = probe.asset.bytes
        deps.emitProgress({
          backend,
          state: 'downloading',
          received: probe.asset.bytes,
          total: probe.asset.bytes,
        })
        deps.emitProgress({ backend, state: 'extracting' })
        deps.emitProgress({ backend, state: 'done' })
      } catch (error) {
        // The partial stays for resume; the progress payload carries a short
        // message, the detail goes to the local log only.
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('gpu download failed', { backend, error: message })
        deps.emitProgress({ backend, state: 'error', error: message })
      } finally {
        inFlight = null
      }
    })()
    return { started: true }
  }

  return { status, download }
}

/**
 * The production ensure: fetch the pinned asset (TOFU, resumable, reporting
 * bytes) then flatten the archive into the layout directory.
 */
function productionEnsure(
  target: Tier2Target,
  dirFor: (backend: DownloadableBackend) => string,
): GpuServiceDeps['ensure'] {
  return async (backend, onProgress) => {
    const asset: (typeof KATAGO_MANIFEST.engine.tier2)[DownloadableBackend][Tier2Target] =
      KATAGO_MANIFEST.engine.tier2[backend][target]
    const dir = dirFor(backend)
    const url = `${engineDownloadBase(target)}/${asset.file}`
    const archive = await ensureFetched(asset, url, dir, undefined, { onProgress })
    await extractZip(archive.path, dir)
    await makeExecutable(join(dir, asset.binary))
  }
}

/** The production binding: real fetch pipeline, real manifest, real layout. */
export function createNodeGpuService(options: {
  preference: () => EngineBackend | null
  checksumsPath: string
  emitProgress: (progress: GpuProgress) => void
}): GpuService {
  const target = currentEngineTarget()
  logger.debug('gpu service bound', { target })
  const dirFor = (backend: DownloadableBackend): string =>
    engineBinariesDir(`${target ?? 'unavailable'}-${backend}`)
  return createGpuService({
    preference: options.preference,
    checksumsPath: options.checksumsPath,
    target,
    dirFor,
    emitProgress: options.emitProgress,
    ensure:
      target === null || target === 'darwin-arm64' || target === 'darwin-x64'
        ? () => Promise.reject(new Error('no tier-2 assets for this platform'))
        : productionEnsure(target, dirFor),
  })
}
