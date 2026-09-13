import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { firstPage, launchApp } from './harness'

/**
 * C1 (M5 Stage 2): the consent gate and the local-only telemetry story,
 * exercised against the real app rather than the unit-level fakes.
 *
 * ## What only this spec can assert
 *
 * The unit suite proves the telemetry module's behaviour with an injected
 * crashReporter spy; this spec proves the *wiring*: that a real Electron
 * `crashReporter` is (and only is) started from the consented setting, that
 * the construction site points Crashpad's dumps at the app's own crashes
 * directory, and that the event JSONL lands there with only scalar fields.
 * None of that exists below the factory boundary the unit tests see.
 *
 * ## Consent takes effect on next launch — and the spec says so through its
 * shape
 *
 * `createTelemetry` runs once at construction and decides the behaviour for
 * the whole process lifetime; there is deliberately no live switch. So the
 * consent path here is: launch unconsented (assert no telemetry state exists
 * on disk), set `telemetryConsent` through the real settings bridge, quit,
 * relaunch on the SAME profile, and assert the reporter is live — Electron 33
 * has no `isStarted`, but `getUploadToServer()` is defined only on a started
 * reporter and returns the ACTUAL transport policy, which is exactly the thing
 * worth reading from the real process — and the log has the startup event.
 * The sequential describe is the documented pattern — run it whole, never
 * `-g`-filtered (the second test consumes the first test's profile state).
 */

test.describe
  .serial('local-only telemetry: the consent gate against the real app', () => {
  let profileDir: string

  test.beforeAll(() => {
    profileDir = mkdtempSync(join(tmpdir(), 'gomentor-telemetry-e2e-'))
  })

  test('unconsented launch: no crash reporter, no telemetry files', async () => {
    const app: ElectronApplication = await launchApp({ userDataDir: profileDir })
    try {
      // The crashes directory is created lazily by the consented writer; an
      // unconsented install leaves no telemetry state on disk at all.
      expect(existsSync(join(profileDir, 'crashes'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('consented relaunch: reporter up, uploads off, JSONL scalar-only', async () => {
    // Same profile as the first test: consent is a settings write, the
    // relaunch is what makes it take effect.
    const first: ElectronApplication = await launchApp({ userDataDir: profileDir })
    try {
      const page = await firstPage(first)
      const ok = await page.evaluate(async () => {
        const result = await window.gomentor.settings.set({
          patch: { telemetryConsent: true },
        })
        return result.ok
      })
      expect(ok).toBe(true)
    } finally {
      await first.close()
    }

    const app: ElectronApplication = await launchApp({ userDataDir: profileDir })
    try {
      // The transport policy, read from the real reporter. `getUploadToServer`
      // exists only on a started reporter (it throws otherwise — in Electron
      // 33 there is no `isStarted` to ask first), so this one assertion
      // covers both "started because consented" and "started with uploads
      // hard-off".
      const uploadToServer = await app.evaluate(({ crashReporter }) =>
        crashReporter.getUploadToServer(),
      )
      expect(uploadToServer).toBe(false)

      // `app_started` fires during startup, so the JSONL exists by the time
      // the main process is answering — poll for it rather than race it.
      const logPath = join(profileDir, 'crashes', 'telemetry.jsonl')
      await expect
        .poll(() => existsSync(logPath) && readFileSync(logPath, 'utf8').length > 0, {
          timeout: 15_000,
        })
        .toBe(true)

      // Content rule, at the artifact level: every line the real app wrote
      // carries only scalar values (the closed union plus the timestamp).
      const lines = readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
      expect(lines.length).toBeGreaterThanOrEqual(1)
      for (const line of lines) {
        const record = JSON.parse(line) as Record<string, unknown>
        for (const value of Object.values(record)) {
          expect(['string', 'number', 'boolean']).toContain(typeof value)
        }
      }
      expect(lines.some((line) => line.includes('"app_started"'))).toBe(true)
    } finally {
      await app.close()
    }
  })
})
