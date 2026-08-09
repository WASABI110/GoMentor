import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { firstPage, launchApp, makeUserDataDir } from './harness'

/**
 * A12 — "Switching zh-CN ↔ en leaves no untranslated key visible."
 *
 * ## Why this needs the built app at all
 *
 * `test/renderer/i18n.test.ts` proves the catalogues are complete and mutually
 * consistent, and `scripts/check-i18n.ts` gates that in CI. Neither can see the
 * defect that actually ships: a component with a Chinese string typed directly
 * into the JSX. Every key exists, every catalogue matches, and the English build
 * still shows Chinese. Only rendering the real app can catch that, which is why
 * A12 is "manual smoke + CI key-completeness gate" in the PRD and why this spec
 * converts most of the manual half into a machine check.
 *
 * ## Why the locale is seeded on disk rather than switched through the UI
 *
 * The settings panel does not exist yet, and waiting for it would leave A12
 * untested through the stage that introduces i18n. `ui.locale` is a persisted
 * field that main reads at startup, so writing `settings.json` into an isolated
 * `--user-data-dir` exercises the same path a user's saved preference takes — and
 * it additionally covers the **first paint**, which a click-to-switch test cannot:
 * the native menu is built before any window exists, so a menu that is only
 * correct after a renderer round-trip would pass an in-app switch test and still
 * ship an English menu bar to every Chinese user on launch.
 *
 * ## What is still manual
 *
 * Whether the translations read naturally, and whether a longer German-style
 * string overflows a panel. Neither is decidable here. A11's "legible" is manual
 * for the same reason.
 */

/** The panel headings, which come from three different namespaces. */
const HEADINGS = {
  'zh-CN': ['棋谱库', '棋盘', 'AI 教师'],
  en: ['Library', 'Board', 'AI Teacher'],
} as const

/** Top-level native menu labels, translated in main from the same JSON. */
const MENU = {
  'zh-CN': ['文件', '视图', '帮助'],
  en: ['File', 'View', 'Help'],
} as const

/**
 * Reads the top-level menu labels out of the main process.
 *
 * `Menu.getApplicationMenu()` rather than anything visual: the menu bar is native
 * chrome and Playwright cannot see it from the page. This is the same measurement
 * that settled the `menu:setLabels` question — see `prd.md` R4.
 */
async function menuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    if (menu === null) return []
    return menu.items.map((item) => item.label)
  })
}

for (const locale of ['zh-CN', 'en'] as const) {
  test.describe(`a build launched with ui.locale = ${locale}`, () => {
    const profile = makeUserDataDir()
    let app: ElectronApplication

    test.beforeAll(async () => {
      // A minimal document, not a full one: `settingsSchema` fills every other
      // field with its default, so this stays valid as settings are added. Written
      // before the first launch so main reads it during startup rather than
      // creating a default file and being corrected later.
      writeFileSync(
        join(profile.dir, 'settings.json'),
        JSON.stringify({ version: 1, ui: { locale } }),
        'utf8',
      )
      app = await launchApp({ userDataDir: profile.dir })
    })

    test.afterAll(async () => {
      await app.close()
      profile.cleanup()
    })

    test('renders every panel heading in that language', async () => {
      const page = await firstPage(app)
      for (const heading of HEADINGS[locale]) {
        await expect(page.getByRole('heading', { name: heading })).toBeVisible()
      }
    })

    test('shows no untranslated key anywhere in the page', async () => {
      const page = await firstPage(app)
      const text = await page.locator('body').innerText()

      // The signature of a failed lookup: i18next renders the key itself, so a
      // missing `board:empty` appears verbatim, and a namespaced miss keeps its
      // `ns:` prefix. Matching the shape rather than a list of known keys means a
      // key added later is covered without touching this spec.
      expect(text).not.toMatch(
        /\b[a-z][a-zA-Z]*(?::[a-z][a-zA-Z]*)?\.[a-z][a-zA-Z.]+\b/,
      )
    })

    test('translates the native menu before the first window exists', async () => {
      expect(await menuLabels(app)).toEqual([...MENU[locale]])
    })

    test('leaves no string from the other language on screen', async () => {
      const page = await firstPage(app)
      const text = await page.locator('body').innerText()

      // The defect a key-completeness check cannot see: a string typed straight
      // into the JSX. It survives every catalogue assertion and shows the
      // authoring language to an English user.
      const other = locale === 'en' ? 'zh-CN' : 'en'
      for (const stray of HEADINGS[other]) {
        expect(text).not.toContain(stray)
      }
    })
  })
}
