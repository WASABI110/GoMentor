import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

/**
 * Shared launch helper for the Electron e2e specs.
 *
 * ## Why this exists as a module rather than as copied `beforeAll` blocks
 *
 * Three of the details below are not style choices — each one was a failing
 * launch first, and the comment records the measurement. Copied into a second
 * spec they would be copied without the reasons, and the first person to
 * "simplify" one would get a failure that points at Electron internals rather
 * than at what they changed. Stage 5 had one spec so the duplication cost was
 * zero; Stage 6 adds specs for A1, A2, A3, A4, A12 and A13, which is where it
 * stops being zero.
 *
 * ## What deliberately stays out
 *
 * Building `out/`. That is a precondition, not this module's job: building here
 * would make every spec pay for it and would hide which step broke. `assertBuilt`
 * fails with a pointed message instead.
 */

/**
 * The built main bundle — the artifact under test.
 *
 * Not `src/main/index.ts`: a spec that ran the sources would have passed through
 * all of Stage 4 while the shipped app did not start at all (`externalizeDepsPlugin`
 * left `@gomentor/shared` as a runtime `require()` of an uncompiled `.ts` entry,
 * and the CJS bundle died on `SyntaxError: Unexpected token 'export'`). Launching
 * the artifact is the whole point — see `quality-guidelines.md`, "The built bundle
 * must be launched, not just built."
 */
export const OUT_MAIN = join(__dirname, '..', '..', 'out', 'main', 'index.js')

/**
 * Fails with a message that names the fix, rather than letting Playwright throw a
 * missing-file stack from inside its own launcher.
 */
export function assertBuilt(): void {
  if (!existsSync(OUT_MAIN)) {
    throw new Error(
      `Built main bundle not found at ${OUT_MAIN}. ` +
        'Run `pnpm --filter @gomentor/desktop build` first.',
    )
  }
}

/**
 * `process.env` minus `ELECTRON_RUN_AS_NODE`, narrowed to what Playwright accepts.
 *
 * Electron-based editors and terminals leak `ELECTRON_RUN_AS_NODE` into their
 * integrated shells. With it set, the binary boots as plain Node, `app` is
 * undefined, and the launch fails with "Cannot read properties of undefined
 * (reading 'handle')" — measured, not anticipated. `electron.vite.config.ts`
 * deletes it for `dev`; a test launch has the same hazard.
 *
 * Removed by omission rather than by assigning `undefined`: under
 * `exactOptionalPropertyTypes` that assignment is a type error, and it would be
 * wrong regardless — Playwright's `env` is `Record<string, string>`, so the value
 * would arrive as the *string* `"undefined"`, which Electron finds truthy. The
 * "fix" would reintroduce the exact failure it was meant to prevent.
 */
function launchEnv(extra: Record<string, string> = {}): Record<string, string> {
  const { ELECTRON_RUN_AS_NODE: _asNode, ...rest } = process.env

  return {
    ...Object.fromEntries(
      Object.entries(rest).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...extra,
  }
}

export interface LaunchOptions {
  /**
   * Isolated `app.getPath('userData')`. Pass the same directory to a second
   * launch to test what survives a restart.
   *
   * Measured before being relied on: `--user-data-dir` genuinely relocates
   * `app.getPath('userData')`, and a write → quit → relaunch → read round-trip
   * really does come back. Without it, A2's restart test would either read the
   * developer's real profile — making the result depend on machine state — or
   * write settings and secrets into it, which for a test that stores a fake API
   * key is not acceptable.
   */
  userDataDir?: string
  /** Extra argv for the app under test. Appended after `OUT_MAIN`. */
  args?: string[]
  /** Extra environment for the launched process. Merged over the cleaned env. */
  env?: Record<string, string>
}

/**
 * Launches the built app.
 *
 * `--user-data-dir` goes in `args` after `OUT_MAIN` because Electron parses its
 * own switches from the full argv regardless of position; keeping the entry point
 * first is what makes the argv readable in a process list.
 */
export async function launchApp(
  options: LaunchOptions = {},
): Promise<ElectronApplication> {
  assertBuilt()

  const args = [OUT_MAIN]
  if (options.userDataDir !== undefined) {
    args.push(`--user-data-dir=${options.userDataDir}`)
  }
  if (options.args !== undefined) {
    args.push(...options.args)
  }

  return electron.launch({ args, env: launchEnv(options.env) })
}

/**
 * The app's first window, after load.
 *
 * The wait is not defensive padding. `getLastWebPreferences()` reports the
 * preferences of the last *committed* navigation and returns null before one has
 * happened, so a spec that skipped this asserted against `null` and said nothing
 * about the security flags. Every spec needs the same wait, so it belongs here
 * rather than in each one.
 */
export async function firstPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return page
}

/**
 * A fresh directory for `userDataDir`, and the function that removes it.
 *
 * Returned as a pair rather than registered with an `afterAll` inside this module:
 * a spec that launches twice against one directory must remove it after the
 * *second* launch, and a hook hidden in the harness could not know that. The
 * caller owning cleanup keeps the ordering visible where it matters.
 */
export function makeUserDataDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gomentor-e2e-'))
  return {
    dir,
    cleanup: () => {
      // `force` so a spec that failed before the app wrote anything still cleans
      // up, and `maxRetries` because Windows can hold a lock on a just-closed
      // Electron profile for a few milliseconds after `app.close()` resolves.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}
