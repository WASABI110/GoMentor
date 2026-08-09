import { CHANNEL_NAMES } from '@gomentor/shared'
import { removeAllHandlers } from './register'
import { registerSgfHandlers } from './sgf.handlers'
import { registerLibraryHandlers } from './library.handlers'
import { registerSettingsHandlers } from './settings.handlers'
import { registerLlmHandlers } from './llm.handlers'
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
  /**
   * Injected rather than called directly so handler tests are deterministic —
   * `importedAt` otherwise makes every expected value a moving target.
   */
  now: () => string
}

export function registerAllHandlers(deps: Dependencies): void {
  // Idempotent: `ipcMain.handle` throws on a duplicate channel, so a second call
  // without this would fail rather than replace. Tests re-register per case.
  removeAllHandlers(CHANNEL_NAMES)

  registerSgfHandlers(deps.store, deps.now)
  registerLibraryHandlers(deps.store, deps.now)
  registerSettingsHandlers(deps.settings, deps.secrets)
  registerLlmHandlers(deps.llm)
}

export { removeAllHandlers }
