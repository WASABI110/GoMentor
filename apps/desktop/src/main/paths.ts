import { app } from 'electron'
import { join } from 'node:path'

/**
 * Single source of truth for every path the app touches.
 *
 * Scattered `path.join(app.getPath(...))` calls are how cross-platform path
 * bugs enter: one call site uses `userData`, another hardcodes a sibling
 * directory, and the two disagree on Linux only. Every path is derived here so
 * a disagreement is a compile-time impossibility rather than a platform-
 * specific bug (`design.md` §Operational).
 *
 * `app.getPath('userData')` cannot be called at module load — it throws before
 * `app` is ready — so these are functions, not constants. Resist the urge to
 * "optimise" them into a frozen object evaluated at import time; the crash is
 * immediate and total, and it only reproduces in a packaged build if a lazy
 * import happens to have deferred it in dev.
 */

/** Root for everything user-specific and writable. */
export function userDataDir(): string {
  return app.getPath('userData')
}

/**
 * Where `electron-log` writes. Deliberately *not* `app.getPath('logs')`:
 * on Windows that resolves under `userData\logs` anyway, but on macOS it is
 * `~/Library/Logs/<app>`, which puts logs outside the directory the "Reveal
 * logs" menu item and a support request would look in. One location on every
 * platform is worth more than each platform's convention here.
 */
export function logsDir(): string {
  return join(userDataDir(), 'logs')
}

/** The single log file. Rotation appends suffixes to this name. */
export function logFile(): string {
  return join(logsDir(), 'main.log')
}

/** zod-validated settings document. */
export function settingsFile(): string {
  return join(userDataDir(), 'settings.json')
}

/**
 * Read-only assets shipped with the build (KataGo binary, networks, KB seed).
 * In dev these live in the repo; packaged, they are unpacked beside the app.
 * `process.resourcesPath` is undefined outside a packaged build, hence the
 * branch — reading it unguarded yields the string "undefined" in a path.
 */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

/** Default library root. The user may add others via settings. */
export function defaultLibraryDir(): string {
  return join(app.getPath('documents'), 'GoMentor')
}
