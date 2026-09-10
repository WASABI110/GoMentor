import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { firstPage, launchApp, makeUserDataDir } from './harness'

/**
 * C1 (M4 Stage 1): the library survives a quit and a relaunch on the same
 * profile — the acceptance criterion the whole SQLite swap exists for.
 *
 * ## What makes this a persistence test rather than an import test
 *
 * The first launch imports and *closes the app*; the assertions all run
 * against a second process that had no way to inherit anything in memory.
 * Whatever the relaunched app shows, it read from disk. The same
 * `userDataDir` is passed to both launches (the `panel-resize` restart
 * pattern); `launchApp`'s throwaway profiles would make the relaunch a fresh
 * install and the test vacuous.
 *
 * ## Why the row is clicked rather than only listed
 *
 * "The game is present and openable" has two halves. Listing proves the
 * `games` rows survived; clicking the row runs the real open path —
 * `sgf:serialize` from the stored AST bytes, re-parse, board render — which
 * is what would break if the round trip through the `sgf` column were lossy
 * in a way a summary query cannot see (A5's whole reason for keeping the AST).
 */

const FIXTURE_SGF = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'core',
  'test',
  'fixtures',
  'sgf',
  'gnugo-9x9-1-pass.sgf',
)

test.describe('the library persists across a restart (C1)', () => {
  let app: ElectronApplication
  let page: Page
  let profile: { dir: string; cleanup: () => void }

  test.beforeAll(() => {
    profile = makeUserDataDir()
  })

  test.afterAll(() => {
    profile.cleanup()
  })

  test('import → quit → relaunch: the game is listed and openable', async () => {
    app = await launchApp({ userDataDir: profile.dir })
    page = await firstPage(app)

    const imported = await page.evaluate(async (filePath) => {
      const result = await window.gomentor.library.import({ filePaths: [filePath] })
      return result.ok && result.data.imported.length === 1
    }, FIXTURE_SGF)
    expect(imported).toBe(true)

    // The row rendered from the first launch's own write.
    await expect(
      page.getByTestId('library-list').locator('button.library-row'),
    ).toHaveCount(1)

    // Quit — a real close of the whole app, not a reload. `app.close()` runs
    // the before-quit path, which is where the WAL checkpoint happens.
    await app.close()

    app = await launchApp({ userDataDir: profile.dir })
    page = await firstPage(app)

    // The relaunch's renderer fetched library:list on mount (main.tsx); the
    // row exists only if the relaunch read it back from disk.
    await expect(
      page.getByTestId('library-list').locator('button.library-row'),
    ).toHaveCount(1)

    // And the record opens: 53 moves in the fixture (the analysis spec's
    // number), rendered from the re-parsed stored bytes.
    await page.getByTestId('library-list').locator('button.library-row').first().click()
    await expect(page.getByTestId('board-move')).toContainText('53')

    await app.close()
  })
})
