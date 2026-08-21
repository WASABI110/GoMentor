import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { firstPage, launchApp, makeUserDataDir } from './harness'

/**
 * A2: the three panels are resizable and the layout persists across restart.
 *
 * ## Why this needs a real pointer drag rather than just checking the grid tracks
 *
 * The grid tracks are set from `settings.ui.panelWidths` on first render. A bug
 * where `App.tsx` ignores drag input but still reads the persisted widths would
 * pass a "tracks exist" check while failing the actual interaction. The drag
 * exercises the mouse-event handlers and the local-state → settings write path.
 *
 * ## Why restart uses the same profile directory
 *
 * `launchApp` allocates and removes a throwaway profile by default. To test
 * persistence, the spec creates one directory in `beforeAll`, passes it to every
 * launch, and removes it in `afterAll`.
 */

test.describe('panel widths can be resized and persist across restart', () => {
  let app: ElectronApplication
  let page: Page
  let profile: { dir: string; cleanup: () => void }

  test.beforeAll(() => {
    profile = makeUserDataDir()
  })

  test.beforeEach(async () => {
    app = await launchApp({ userDataDir: profile.dir })
    page = await firstPage(app)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test.afterAll(() => {
    profile.cleanup()
  })

  test('dragging the library resize handle changes the library width', async () => {
    const shell = page.getByTestId('app-shell')
    const handle = page.getByTestId('resize-handle-library')

    const before = await shell.evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns.split(/\s+/)
      return Number.parseFloat(tracks[0] ?? '0')
    })

    const box = await handle.boundingBox()
    if (box === null) throw new Error('resize handle not found')

    // Drag the library handle 120px to the right. `dragTo` is not used because
    // the handle is only 8px wide; the pointer quickly leaves it and lands on the
    // board panel, so Playwright's target-element stability check times out.
    await handle.hover({ position: { x: box.width / 2, y: box.height / 2 } })
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2)
    await page.mouse.up()

    const after = await shell.evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns.split(/\s+/)
      return Number.parseFloat(tracks[0] ?? '0')
    })

    expect(after).toBeGreaterThan(before + 80)
  })

  test('the resized library width survives a relaunch', async () => {
    const shell = page.getByTestId('app-shell')
    const handle = page.getByTestId('resize-handle-library')

    const box = await handle.boundingBox()
    if (box === null) throw new Error('resize handle not found')

    await handle.hover({ position: { x: box.width / 2, y: box.height / 2 } })
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2)
    await page.mouse.up()

    const widthBeforeClose = await shell.evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns.split(/\s+/)
      return Number.parseFloat(tracks[0] ?? '0')
    })

    // Close and relaunch against the same profile.
    await app.close()
    app = await launchApp({ userDataDir: profile.dir })
    page = await firstPage(app)

    const widthAfterRelaunch = await page.getByTestId('app-shell').evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns.split(/\s+/)
      return Number.parseFloat(tracks[0] ?? '0')
    })

    expect(widthAfterRelaunch).toBeGreaterThan(widthBeforeClose - 10)
    expect(widthAfterRelaunch).toBeLessThan(widthBeforeClose + 10)
  })
})
