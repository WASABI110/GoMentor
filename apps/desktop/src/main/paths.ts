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
 *
 * ## Why the dev branch anchors to this module, not `app.getAppPath()`
 *
 * Unpackaged, `app.getAppPath()` is NOT the package root: Electron resolves a
 * file argument (`electron out/main/index.js` — how electron-vite dev, the
 * Playwright e2e, and a plain manual launch all start the app) to the entry
 * script's own directory, `out/main`, and the resources tree would be sought
 * at `out/main/resources`, which has never existed. Measured via an e2e probe
 * (2026-09-05): locate logged `network weights missing …
 * out\main\resources\weights` while the net sat at
 * `apps/desktop/resources/weights`. Both `src/main` (vitest/tsx) and
 * `out/main` (built bundle) sit exactly two levels below the package root, so
 * anchoring to this module's own directory is correct in every context the
 * app actually runs in — a `getAppPath` walk-up would be a second source of
 * truth for the same layout fact.
 */
export function resourcesDir(): string {
  return app.isPackaged
    ? process.resourcesPath
    : join(__dirname, '..', '..', 'resources')
}

/**
 * Bundled engine binaries for one platform-arch, as laid out by the fetch
 * scripts (`resources/katago/<platform>-<arch>/`). Called only for platforms
 * with an official Eigen build (`win32-x64`, `linux-x64`) — darwin has no
 * target and never reaches this (`locate.ts` reports `unavailable` there by
 * construction, scope decision 6).
 */
export function engineBinariesDir(platformArch: string): string {
  return join(resourcesDir(), 'katago', platformArch)
}

/**
 * Bundled network weights. Platform-independent — the same net file ships in
 * every installer — so unlike the engine binaries there is no per-platform
 * subdirectory.
 */
export function weightsResourcesDir(): string {
  return join(resourcesDir(), 'weights')
}

/**
 * The generated KataGo analysis config. Written under `userData` (never into
 * the read-only resources tree) and rewritten on every engine start, so it is
 * a cache of the settings that produced it, not something the user edits.
 */
export function engineConfigFile(): string {
  return join(userDataDir(), 'katago-analysis.cfg')
}

/** Default library root. The user may add others via settings. */
export function defaultLibraryDir(): string {
  return join(app.getPath('documents'), 'GoMentor')
}
