import { app, BrowserWindow, crashReporter } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHANNEL_NAMES } from '@gomentor/shared'
import { initLogging, scoped } from './logger'
import { createSettingsService } from './settings'
import { createSecretsService, electronEncryptor } from './safe-storage'
import { openLibraryDatabase } from './db/connection'
import { createAnalysisRepository } from './db/repositories/analysis'
import { createGameStore } from './library/store'
import { createLlmService } from './llm/service'
import { createEngineService } from './katago/service'
import { createBatchService } from './katago/batch'
import { buildSnapshot } from './ipc/profile.handlers'
import { emit } from './ipc/events'
import { createTelemetry } from './telemetry'
import { registerAllHandlers, removeAllHandlers } from './ipc'
import { crashesDir, dbFile, enginesChecksumsFile, telemetryLogFile } from './paths'
import { createWindow } from './window'
import { applyMenu } from './menu'
import { createUpdateService } from './update/update'
import { locateBundledEngine } from './katago/locate'
import { createNodeGpuService } from './katago/gpu'
import { createFoxService } from './integrations/fox/service'

/**
 * `settings.engine.backend` → the locate-level preference: a GPU backend name
 * when the setting names one, null (tier-1 Eigen, or whichever GPU directory
 * exists) otherwise. Kept here because the shared settings type carries the
 * raw string; the mapping to the locate seam is wiring, not domain logic.
 */
function backendPreference(backend: string | null): 'cuda' | 'opencl' | null {
  return backend === 'cuda' || backend === 'opencl' ? backend : null
}

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

/** Process start, for the `app_quit` session-length event. */
const appStartedAt = Date.now()

/**
 * Settings are needed before `app.whenReady()` resolves in order to configure
 * logging, but `app.getPath('userData')` throws before ready. So the service is
 * constructed lazily inside `whenReady` and this holds it for the lifecycle
 * handlers below.
 */
let services: ReturnType<typeof createServices> | undefined

function createServices() {
  // Telemetry's consent gate reads the settings document; the crash dumps and
  // the event JSONL share the crashes directory ("Reveal crashes" opens it).
  // `crashReporter` is injected rather than imported inside telemetry.ts, which
  // keeps that module pure Node; `uploadToServer: false` there is the whole
  // transport policy and is pinned by unit test plus mutation.
  app.setPath('crashDumps', crashesDir())
  const settings = createSettingsService()
  const secrets = createSecretsService(settings.secretStore, electronEncryptor)
  // Before the handlers and before the store: migrations run here, once, at
  // startup (`app.ready` has resolved by the time this is called, so `userData`
  // exists). A damaged file is quarantined inside — the app still starts.
  const db = openLibraryDatabase(dbFile())
  const store = createGameStore(db)
  const analysis = createAnalysisRepository(db)
  // The engine before the LLM service: the agent loop's tool calls reach into
  // it, so it must exist by the time a run can start. The locate wrapper
  // re-reads the backend preference per start, so a settings change to
  // `engine.backend` applies on the next engine start without a relaunch.
  const engine = createEngineService({
    settings,
    locate: () =>
      locateBundledEngine(undefined, backendPreference(settings.get().engine.backend)),
  })
  const batch = createBatchService({ store, settings, engine, repository: analysis })
  // GPU tier-2 (M5 Stage 4): the in-app download face of the fetch pipeline.
  const gpu = createNodeGpuService({
    checksumsPath: enginesChecksumsFile(),
    preference: () => settings.get().engine.backend,
    emitProgress: (progress) => {
      emit('gpu:progress', progress)
    },
  })
  // Fox public-kifu sync (M5 Stage 5): the rate limiter is process-global by
  // design — the upstream does not distinguish callers, so every Fox channel
  // in this process shares one spacing clock.
  const fox = createFoxService({
    fetch: (url) => fetch(url),
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const llm = createLlmService(settings, secrets, {
    store,
    engine,
    // The teacher quotes the same derivation the profile panel shows — one
    // builder, so the tool's numbers cannot drift from the UI's.
    profile: () => buildSnapshot({ store, repository: analysis, settings }),
  })
  const telemetry = createTelemetry({
    consented: settings.get().telemetryConsent,
    logPath: telemetryLogFile(),
    crashReporter,
    now: () => new Date().toISOString(),
  })
  return {
    settings,
    secrets,
    db,
    store,
    analysis,
    llm,
    engine,
    batch,
    gpu,
    fox,
    telemetry,
  }
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

    // An uncaught main-process exception is exactly what the local crash
    // story exists for: the code is a fixed enum string (never the error's
    // message — that can carry user content), the message itself goes only to
    // the local log, and the minidump lands in the crashes directory when
    // consented. Logging first so even an unconsented install has the detail
    // in the log file.
    process.on('uncaughtException', (error) => {
      logger.error('uncaught exception', { error: error.message })
      services?.telemetry.track({ name: 'crash', code: 'MAIN_UNCAUGHT_EXCEPTION' })
    })

    if (!created.secrets.isPersistent()) {
      // Surfaced at startup rather than only at the first key write, so the
      // settings UI can warn before a user types a key they will lose.
      logger.warn('OS encryption unavailable; secrets will be session-only')
    }

    // Auto-update: eligibility is decided once here (packaged build, the
    // user's setting, and the unsigned-macOS policy) and holds for the
    // process. Ineligible builds emit one `update:status: disabled` so the
    // settings panel can say why there is no updater; eligible ones get a
    // startup check, and the menu item is only installed when it can work.
    const update = createUpdateService({
      // The UpdateDriver seam is wide on purpose (string event names, unknown
      // payloads); electron-updater's typed `autoUpdater` satisfies it
      // directly, and the mapping from its events to `update:status` — the
      // actual logic — is what the unit tests pin.
      driver: autoUpdater,
      platform: process.platform,
      isPackaged: app.isPackaged,
      enabled: created.settings.get().autoUpdate.enabled,
      emitStatus: (status) => {
        emit('update:status', status)
      },
    })

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
      // Absent when updates are ineligible: buildMenu omits the item entirely
      // rather than installing one that can only report a failure.
      ...(update.eligibility.eligible
        ? {
            checkForUpdates: () => {
              void update.checkForUpdates()
            },
          }
        : {}),
    }

    if (update.eligibility.eligible) {
      // One quiet startup check. Failures land in `update:status` (and the
      // log) via the service — an offline launch must not surface an error
      // dialog, the settings row shows the state instead.
      void update.checkForUpdates()
    }

    // Before the window: the renderer calls settings:get on mount.
    registerAllHandlers({
      gpu: created.gpu,
      fox: created.fox,
      store: created.store,
      settings: created.settings,
      secrets: created.secrets,
      llm: created.llm,
      engine: created.engine,
      batch: created.batch,
      analysis: created.analysis,
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
  // The session-length event, while the telemetry that could write it still
  // exists — the handlers and services shut down below.
  services?.telemetry.track({
    name: 'app_quit',
    sessionSeconds: Math.round((Date.now() - appStartedAt) / 1000),
  })
  // In-flight streams hold AbortControllers and an open HTTP connection. Left
  // running, the process would linger after the window closed.
  services?.llm.shutdown()
  // Before the engine: aborts the run's in-flight queries and stops the queue,
  // so no batch continuation tries to write the database after the close below.
  services?.batch.shutdown()
  // A spawned engine that outlived the app would be an orphan holding CPU and
  // the log tail; stop() is terminate → grace → SIGKILL, with a synchronous
  // kill in the process layer's own 'exit' handler as the last resort.
  void services?.engine.shutdown()
  removeAllHandlers(CHANNEL_NAMES)
  // Last, after the handlers that could still write are gone: a clean close
  // checkpoints the WAL into the database file, so a copied-at-rest `library.db`
  // (backup, support request) is complete without its sidecar files.
  services?.db.close()
})
