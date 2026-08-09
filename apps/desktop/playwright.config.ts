import { defineConfig } from '@playwright/test'

/**
 * Playwright is used only for what needs a real Electron process. Everything
 * that can be tested without one lives in vitest — spawning a browser-class
 * runtime per assertion is slow, and a test that *can* be a unit test and isn't
 * fails less informatively.
 *
 * `testDir` is `test/e2e`, which `vitest.config.ts` explicitly excludes, so the
 * two runners never claim the same file.
 *
 * No `webServer` and no global setup: the app under test is the built output in
 * `out/`, and each spec launches it itself. The build is a *precondition*, not
 * something the test does — see `test/e2e/preload-boundary.spec.ts`, which fails
 * with a pointed message rather than a missing-file stack if `out/` is absent.
 */
export default defineConfig({
  testDir: './test/e2e',
  // Electron launches are serial by nature here: the app takes a single-instance
  // lock (`main/index.ts`), so two concurrent launches would have one quit
  // immediately and the spec would test nothing.
  workers: 1,
  fullyParallel: false,
  // A hung Electron launch is the likely failure, and the default 30s is enough
  // for a cold start on CI's slowest runner without making a genuine hang cost
  // minutes.
  timeout: 60_000,
  // CI must not silently pass a suite where someone left `.only` on one spec.
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? 'list' : 'list',
})
