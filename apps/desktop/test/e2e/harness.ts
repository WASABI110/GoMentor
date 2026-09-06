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
 *
 * Exported because the packaged-launch spec calls `_electron.launch` directly
 * (its subject is the product binary, not `OUT_MAIN`), and a spec that
 * re-derives this by hand would copy the omission trick without the reason.
 */
export function launchEnv(extra: Record<string, string> = {}): Record<string, string> {
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
   *
   * Omitting it does *not* mean "the default profile" — `launchApp` allocates a
   * throwaway one. Only pass this when two launches must share state.
   */
  userDataDir?: string
  /** Extra argv for the app under test. Appended after `OUT_MAIN`. */
  args?: string[]
  /** Extra environment for the launched process. Merged over the cleaned env. */
  env?: Record<string, string>
}

/**
 * Launches the built app, always against a profile no other spec can see.
 *
 * `--user-data-dir` goes in `args` after `OUT_MAIN` because Electron parses its
 * own switches from the full argv regardless of position; keeping the entry point
 * first is what makes the argv readable in a process list.
 *
 * ## Why isolation is the default and not opt-in
 *
 * It used to be opt-in, and that was a real cross-spec leak rather than a
 * hypothetical one. A launch with no `userDataDir` inherits Electron's default
 * profile for an unpackaged app — `%APPDATA%/Electron` — which is one directory
 * shared by every spec and every run on the machine. `ipc-events` writes
 * `llm.kind: 'local'` through `settings:set` to get a keyless provider;
 * `preload-boundary` then booted expecting default settings and failed with
 * `LLM_UNREACHABLE` where it asserts `LLM_NO_KEY`. Measured: the file at
 * `%APPDATA%/Electron/settings.json` held `kind: local` and the stalling server's
 * port after the run.
 *
 * That failure is the mild version. The same directory is where a spec's imported
 * games and `safeStorage` secrets land, it survives between runs, and it makes
 * every result depend on which spec happened to run first. Order-dependence that
 * only appears once two specs write the same key is exactly the kind of thing that
 * passes locally and fails in CI — so the safe form is the default, and sharing is
 * what has to be asked for.
 *
 * The directory is removed when the app closes, so no caller has to remember. Specs
 * that need a profile to outlive one launch still use `makeUserDataDir` and pass it
 * in, which is the case the option now exists for.
 */
export async function launchApp(
  options: LaunchOptions = {},
): Promise<ElectronApplication> {
  assertBuilt()

  const shared = options.userDataDir !== undefined
  // Held so the `close` handler below can remove it. When the caller supplied the
  // directory, it owns the lifetime and nothing here deletes it.
  const profile = shared ? null : makeUserDataDir()
  const userDataDir = options.userDataDir ?? profile?.dir

  const args = [OUT_MAIN]
  if (userDataDir !== undefined) {
    args.push(`--user-data-dir=${userDataDir}`)
  }
  if (options.args !== undefined) {
    args.push(...options.args)
  }

  const app = await electron.launch({ args, env: launchEnv(options.env) })

  if (profile !== null) {
    // On `close` rather than in an `afterEach`: this module cannot register hooks
    // for specs it does not know about, and a spec that forgot one would silently
    // go back to leaking.
    app.on('close', () => {
      profile.cleanup()
    })
  }

  return app
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
 * Points the running app at a local OpenAI-compatible server on `port`.
 *
 * Shared because two specs need it and the *reasons* are what would get lost in a
 * copy. With the default `kind: 'cloud'` and no API key, `send` throws `LLM_NO_KEY`
 * at provider construction — before a request exists and before a runId is issued —
 * and a CI runner has no key and never will. The keyless `local` path is therefore
 * the only one an automated LLM test can use, and it is a real user path rather than
 * a test hook.
 *
 * Written through `settings:set` rather than into `settings.json` before launch, for
 * a second measured reason: `settings.update` calls `invalidate()`, so the next send
 * rebuilds the provider from the new document instead of reusing the cached cloud one
 * that threw. Pre-seeding the file would test a path the settings panel does not take.
 *
 * Throws rather than returning a boolean so a failed write reads as a failed write.
 * The alternative was letting the caller time out waiting for a runId that could
 * never arrive, which points at the wrong thing.
 */
export async function useLocalProvider(page: Page, port: number): Promise<void> {
  const ok = await page.evaluate(async (localPort) => {
    const result = await window.gomentor.settings.set({
      patch: {
        llm: { kind: 'local', baseUrl: `http://127.0.0.1:${String(localPort)}/v1` },
      },
    })
    return result.ok
  }, port)

  if (!ok) {
    throw new Error(
      `settings:set rejected the local provider patch for port ${String(port)}`,
    )
  }
}

/**
 * A fresh directory for `userDataDir`, and the function that removes it.
 *
 * Returned as a pair rather than registered with an `afterAll` inside this module:
 * a spec that launches twice against one directory must remove it after the
 * *second* launch, and a hook hidden in the harness could not know that. The
 * caller owning cleanup keeps the ordering visible where it matters.
 *
 * ## Call this inside a hook, not at module scope
 *
 * `makeUserDataDir()` creates the directory when it is *called*, and Playwright
 * loads a spec file twice: once to collect the tests and again to run them. A call
 * in a `describe` body therefore runs during collection too, and that copy has no
 * `afterAll` behind it — measured with `--list`, which runs no tests at all and
 * still left two `gomentor-e2e-*` directories in temp.
 *
 * So `const profile = makeUserDataDir()` beside the tests leaks one directory per
 * describe per run. Call it in `beforeAll` and keep the handle in a `let`. Specs
 * that just need isolation should not call it at all — `launchApp` allocates and
 * removes a profile on its own.
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
