import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { firstPage, launchApp } from './harness'

/**
 * S4: the settings panel's GPU backend rows render from the real service's
 * `gpu:status`, and selecting a backend writes the settings document.
 *
 * ## Why no download is driven here
 *
 * The download pipeline is the real `@gomentor/engines` fetch — network,
 * upstream bytes, TOFU sidecar. Faking it would test a fixture, driving it
 * for real puts an upstream download inside an e2e budget on every CI run
 * (the same argument the packaged-launch spec makes for not re-fetching).
 * The pipeline is proven live by the CLI run and by the scripts suite; this
 * spec proves the renderer half: rows exist per backend, the downloaded
 * state renders (main reports from the real layout — empty in a fresh
 * profile), and the backend select writes `engine.backend` through the
 * ordinary settings bridge. The service's slot/state logic is unit-covered
 * in test/unit/gpu.test.ts.
 */

test.describe('the settings panel GPU backend rows', () => {
  let app: ElectronApplication
  let page: Page
  let profileDir: string

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'gomentor-gpu-e2e-'))
    app = await launchApp({ userDataDir: profileDir })
    page = await firstPage(app)
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('rows render from the real status; the select writes the preference', async () => {
    // Settings is a TAB inside the teacher panel, not an always-mounted
    // surface — open it first, or the GPU rows are simply not in the DOM.
    await page.getByTestId('teacher-tab-settings').click()

    // Both backends listed. The downloaded/not-downloaded STATE is
    // environment-dependent (a dev checkout that ran `pnpm fetch:gpu` has
    // real backends on disk; CI has none) — `downloaded` reads the actual
    // layout, which is exactly why neither state is pinned here.
    await expect(page.getByTestId('settings-gpu-cuda')).toBeVisible()
    await expect(page.getByTestId('settings-gpu-opencl')).toBeVisible()

    // The select writes `engine.backend` through the settings bridge and the
    // document comes back — the same live-preference path `locate.ts` reads
    // per engine start.
    await page
      .getByTestId('settings-engine-backend')
      .selectOption('opencl')
    await expect
      .poll(async () => {
        const result = await page.evaluate(async () => {
          const doc = await window.gomentor.settings.get({})
          return doc.ok ? doc.data.engine.backend : null
        })
        return result
      })
      .toBe('opencl')
  })
})
