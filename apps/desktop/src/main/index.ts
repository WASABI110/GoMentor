import { app, BrowserWindow } from 'electron'
import { CHANNEL_NAMES } from '@gomentor/shared'
import { initLogging, scoped } from './logger'
import { createSettingsService } from './settings'
import { createSecretsService, electronEncryptor } from './safe-storage'
import { createGameStore } from './library/store'
import { createLlmService } from './llm/service'
import { createEngineService } from './katago/service'
import { emit } from './ipc/events'
import { createTelemetry } from './telemetry'
import { registerAllHandlers, removeAllHandlers } from './ipc'
import { createWindow } from './window'
import { applyMenu } from './menu'

/**
 * Main process entry: single-instance lock, lifecycle, IPC registration, window.
 *
 * ## Ordering here is load-bearing
 *
 * 1. **Logging first**, before the single-instance check — so a rejected second
 *    instance is recorded. That line is the answer to "I clicked the icon and
 *    nothing happened", which is otherwise unanswerable.
 * 2. **Single-instance lock before anything stateful.** Two instances would fight
 *    over the settings file, the log file, and — from M2 — SQLite and the GPU
 *    (`design.md` §Operational). The loser must quit before it has opened any of
 *    them, so this cannot be deferred into `whenReady`.
 * 3. **Handlers registered before the window loads.** The renderer calls
 *    `settings:get` on mount; a window created first would race it and get
 *    "no handler registered for channel".
 */

const logger = scoped('main:app')

/**
 * Settings are needed before `app.whenReady()` resolves in order to configure
 * logging, but `app.getPath('userData')` throws before ready. So the service is
 * constructed lazily inside `whenReady` and this holds it for the lifecycle
 * handlers below.
 */
let services: ReturnType<typeof createServices> | undefined

function createServices() {
  const settings = createSettingsService()
  const secrets = createSecretsService(settings.secretStore, electronEncryptor)
  const store = createGameStore()
  const llm = createLlmService(settings, secrets)
  const engine = createEngineService({ settings })
  const telemetry = createTelemetry()
  return { settings, secrets, store, llm, engine, telemetry }
}

// Two instances would fight over settings, the log file, and — from M2 —
// SQLite and the GPU. The loser quits immediately.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Logging is initialised with debug off: reading settings here would require
  // `userData`, which is not available yet, and this process is about to exit.
  initLogging({ debugEnabled: false })
  logger.info('second instance rejected, quitting')
  app.quit()
} else {
  void app.whenReady().then(() => {
    const created = createServices()
    services = created

    // Now that `userData` is reachable, logging can honour the user's setting.
    initLogging({ debugEnabled: created.settings.get().debugLogging })

    logger.info('app starting', {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
    })

    created.telemetry.track({
      name: 'app_started',
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
    })

    if (!created.secrets.isPersistent()) {
      // Surfaced at startup rather than only at the first key write, so the
      // settings UI can warn before a user types a key they will lose.
      logger.warn('OS encryption unavailable; secrets will be session-only')
    }

    // The menu's actions, named so both the startup build and a later locale
    // change use the same closures. Inlining them at each call site would put the
    // openSgf handler in two places, and "which callback is the live menu using?"
    // would have two possible answers.
    const menuActions = {
      openSgf: () => {
        // The menu asks the *renderer* to run its open flow rather than opening
        // the dialog here. Otherwise the accelerator and the in-app button would
        // be two paths to the same feature, and they would drift.
        emit('menu:command', { command: 'openSgf' })
      },
    }

    // Before the window: the renderer calls settings:get on mount.
    registerAllHandlers({
      store: created.store,
      settings: created.settings,
      secrets: created.secrets,
      llm: created.llm,
      engine: created.engine,
      now: () => new Date().toISOString(),
      // A locale change rebuilds the whole menu rather than patching labels:
      // Electron replaces the menu wholesale, so there is no partial-update path
      // to get wrong.
      relabelMenu: (locale) => {
        applyMenu(menuActions, locale)
      },
    })

    // Translated from the user's stored locale, so the menu is correct on the
    // first paint. This is what the deleted `menu:setLabels` channel could not do:
    // labels pushed from the renderer could not arrive until React had mounted and
    // i18n had initialised, leaving the bar in English until then.
    applyMenu(menuActions, created.settings.get().ui.locale)

    createWindow(created.settings)

    app.on('activate', () => {
      // macOS: clicking the dock icon with no windows open should reopen one.
      if (BrowserWindow.getAllWindows().length === 0) createWindow(created.settings)
    })

    // The engine reports its real state — `unavailable` until the first game
    // open starts it (lazy start, `design.md` §Engine lifecycle) — replacing
    // M1's hardcoded stand-in emission. A badge mounted later still syncs via
    // `engine:info`; this line is for one already listening.
    created.engine.notifyStatus()
  })
}

app.on('second-instance', () => {
  logger.info('second instance attempted, focusing existing window')
  const [existing] = BrowserWindow.getAllWindows()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  logger.info('app quitting')
  // In-flight streams hold AbortControllers and an open HTTP connection. Left
  // running, the process would linger after the window closed.
  services?.llm.shutdown()
  // A spawned engine that outlived the app would be an orphan holding CPU and
  // the log tail; stop() is terminate → grace → SIGKILL, with a synchronous
  // kill in the process layer's own 'exit' handler as the last resort.
  void services?.engine.shutdown()
  removeAllHandlers(CHANNEL_NAMES)
})
