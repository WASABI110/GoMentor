import { CHANNEL_NAMES } from '@gomentor/shared'
import { removeAllHandlers } from './register'
import { registerSgfHandlers } from './sgf.handlers'
import { registerLibraryHandlers } from './library.handlers'
import { registerSettingsHandlers } from './settings.handlers'
import { registerLlmHandlers } from './llm.handlers'
import { registerEngineHandlers } from './engine.handlers'
import { registerBatchHandlers } from './batch.handlers'
import { registerProfileHandlers } from './profile.handlers'
import { registerGpuHandlers } from './gpu.handlers'
import type { Locale } from '@gomentor/shared'
import type { EngineService } from '../katago/service'
import type { BatchService } from '../katago/batch'
import type { GpuService } from '../katago/gpu'
import type { AnalysisRepository } from '../db/repositories/analysis'
import type { GameStore } from '../library/store'
import type { LlmService } from '../llm/service'
import type { SecretsService } from '../safe-storage'
import type { SettingsService } from '../settings'

/**
 * Single registration point for every channel.
 *
 * One function rather than four calls in `index.ts`, so that "is every channel
 * registered" is answerable by reading one file — and so the handlers
 * integration test exercises the same wiring the app does. A test that
 * registered handlers its own way would pass while the app shipped an
 * unregistered channel.
 */

export interface Dependencies {
  store: GameStore
  settings: SettingsService
  secrets: SecretsService
  llm: LlmService
  /** The engine lifecycle. Lazy: constructed here, started on first game open. */
  engine: EngineService
  /** The batch scheduler (M4). Lazy like the engine: started by `batch:start`. */
  batch: BatchService
  /** GPU tier-2 downloads (M5 Stage 4): status + one-at-a-time fetch. */
  gpu: GpuService
  /** The analysis ledger and rows (M4): the profile derivation reads it on demand. */
  analysis: AnalysisRepository
  /**
   * Injected rather than called directly so handler tests are deterministic —
   * `importedAt` otherwise makes every expected value a moving target.
   */
  now: () => string
  /**
   * Rebuilds the native menu for a locale. Called by the settings handler when a
   * patch changes `locale`, since main owns the menu and translates it itself
   * (R10) — there is no renderer round-trip.
   *
   * Injected for the same reason as `now`: the real one calls
   * `Menu.setApplicationMenu`, which needs a running app, so a handler test would
   * otherwise require a live Electron.
   */
  relabelMenu: (locale: Locale) => void
}

export function registerAllHandlers(deps: Dependencies): void {
  // Idempotent: `ipcMain.handle` throws on a duplicate channel, so a second call
  // without this would fail rather than replace. Tests re-register per case.
  removeAllHandlers(CHANNEL_NAMES)

  registerSgfHandlers(deps.store, deps.now)
  registerLibraryHandlers(deps.store, deps.now)
  registerSettingsHandlers(deps.settings, deps.secrets, deps.relabelMenu)
  registerLlmHandlers(deps.llm)
  registerEngineHandlers(deps.engine)
  registerBatchHandlers(deps.batch)
  registerGpuHandlers(deps.gpu, deps.settings)
  registerProfileHandlers({
    store: deps.store,
    repository: deps.analysis,
    settings: deps.settings,
  })
}

export { removeAllHandlers }
