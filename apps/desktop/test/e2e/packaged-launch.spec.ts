import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { firstPage, launchEnv, makeUserDataDir } from './harness'

/**
 * The packaged-launch gate (B1, M1 R12 rule at M2 scale): the *packaged* app,
 * launched from `dist/<platform>-unpacked`, must answer for its engine tier —
 *
 * - **Windows / Linux**: reach `ready` against the **real bundled engine** and
 *   land a real analysis readout — no `GOMENTOR_KATAGO_BINARY` override, no
 *   fake.
 * - **macOS**: launch, open a record, and report `unavailable` — no darwin
 *   engine asset exists (scope decision 6), and by construction that absence
 *   must read as a state, never as a crash or a `failed` packaging defect.
 *
 * ## Why this is a separate spec that usually skips
 *
 * It needs `pnpm package:dir` first, which is minutes of work the rest of the
 * suite must not pay for. Without a packaged build on disk the file skips with
 * a message naming the fix — so in the ordinary e2e run this spec is a visible
 * no-op, and after a packaging step (locally, or in CI after `pnpm package`)
 * it is the gate.
 *
 * ## What only this spec can catch
 *
 * The dev build resolves the engine from `resources/katago/<platform>-<arch>/`
 * in the repo; the packaged app resolves it from `process.resourcesPath` —
 * a layout produced by `electron-builder.yml`'s `extraResources`. Those two
 * paths agreeing is a packaging assertion, not a code assertion: a wrong
 * `to:` target ships bytes to the wrong directory and every dev-mode test
 * stays green while the packaged launch dies with `ENGINE_BINARY_MISSING`
 * (the exact failure `electron-builder.yml`'s comment records as measured).
 * The same applies to the bundled net under `resources/weights`.
 *
 * ## The real engine's timing (win/linux branch)
 *
 * `research/benchmark-eigen.md`: b6c96 cold-starts in ~0.5s and completes a
 * 500-visit focus read in ~3.4s on the reference machine. The deadlines below
 * leave an order of magnitude for a slower CI runner.
 */

const DIST = join(__dirname, '..', '..', 'dist')

function findUnpackedDir(): string | null {
  if (!existsSync(DIST)) return null
  const entries = readdirSync(DIST)
  const wanted =
    process.platform === 'win32'
      ? 'win-unpacked'
      : process.platform === 'darwin'
        ? entries.find(
            (entry) => entry.startsWith('mac') && entry.endsWith('-unpacked'),
          )
        : 'linux-unpacked'
  if (wanted === undefined || !existsSync(join(DIST, wanted))) return null
  return join(DIST, wanted)
}

/**
 * The packaged app's executable: `GoMentor.exe` on win, un-suffixed on linux,
 * and on macOS the Mach-O binary inside the `.app` bundle (the bundle itself
 * is a directory, not something Playwright can spawn).
 */
function findPackagedExecutable(unpacked: string): string | null {
  const entries = readdirSync(unpacked)
  if (process.platform === 'darwin') {
    const bundle = entries.find((entry) => entry.toLowerCase().endsWith('.app'))
    if (bundle === undefined) return null
    const binaryName = bundle.replace(/\.app$/i, '')
    const binary = join(unpacked, bundle, 'Contents', 'MacOS', binaryName)
    return existsSync(binary) ? binary : null
  }
  const name = entries.find(
    (entry) =>
      entry.toLowerCase() === 'gomentor.exe' ||
      entry.toLowerCase() === 'gomentor' ||
      entry.toLowerCase() === 'goementor',
  )
  return name === undefined ? null : join(unpacked, name)
}

const UNPACKED_DIR = findUnpackedDir()
const EXECUTABLE = UNPACKED_DIR === null ? null : findPackagedExecutable(UNPACKED_DIR)

test.skip(EXECUTABLE === null, 'packaged app not found — run `pnpm package:dir` first')

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

/**
 * Launches the packaged product binary against an isolated profile.
 *
 * `executablePath` (not `args[0]`): this is the packaged product binary, not
 * the Playwright-bundled electron running a JS entry. The profile is isolated
 * for the same reason harness.ts isolates every launch — a packaged app
 * defaults to the real `%APPDATA%/GoMentor`. The product binary is an Electron
 * executable too, so the same leaked `ELECTRON_RUN_AS_NODE` that
 * harness.launchApp strips would boot it as plain Node, where Playwright's own
 * switches read as "bad option".
 */
async function launchPackaged(): Promise<{
  app: ElectronApplication
  page: Page
  cleanup: () => void
}> {
  if (EXECUTABLE === null) {
    // Unreachable while the file-level `test.skip` holds; it narrows the
    // `string | null` for `executablePath` and names the fix if it ever fires.
    throw new Error('packaged app not found — run `pnpm package:dir` first')
  }
  const profile = makeUserDataDir()
  const app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [`--user-data-dir=${profile.dir}`],
    env: launchEnv(),
  })
  return { app, page: await firstPage(app), cleanup: profile.cleanup }
}

/** Imports the fixture and opens it through the same user path the specs use. */
async function importAndOpen(page: Page): Promise<void> {
  const ok = await page.evaluate(async (filePath) => {
    const result = await window.gomentor.library.import({ filePaths: [filePath] })
    return result.ok && result.data.imported.length === 1
  }, FIXTURE_SGF)
  expect(ok).toBe(true)
  await page.getByTestId('library-list').locator('button.library-row').first().click()
}

if (process.platform === 'darwin') {
  test.describe('packaged launch on macOS: the engine is absent by construction', () => {
    let app: ElectronApplication | undefined
    let page: Page
    let cleanupProfile: (() => void) | undefined

    test.beforeAll(async () => {
      const launched = await launchPackaged()
      app = launched.app
      page = launched.page
      cleanupProfile = launched.cleanup
    })

    test.afterAll(async () => {
      if (app !== undefined) await app.close()
      cleanupProfile?.()
    })

    test('open → the badge reports unavailable, and the record still opens', async () => {
      await importAndOpen(page)

      // `unavailable`, not `failed`: a missing darwin engine is an expected
      // absence (no official macOS build exists to bundle — scope decision 6),
      // not a packaging defect.
      const badge = page.getByTestId('engine-status')
      await expect(badge.locator('.engine-status__value--unavailable')).toBeVisible({
        timeout: 15_000,
      })

      // And it stays that way — nothing spawns, nothing retries: after a
      // grace period the badge is still `unavailable` (a start loop would have
      // flipped it to `starting`/`failed` by now).
      await page.waitForTimeout(2_000)
      await expect(badge.locator('.engine-status__value--unavailable')).toBeVisible()

      // Usable without the engine: the record opened and its move count
      // rendered — the M1 A13 invariant at M2 scale.
      await expect(page.getByTestId('board-move')).toContainText('53')
    })
  })
} else {
  test.describe('packaged launch against the real bundled engine', () => {
    // `| undefined` because afterAll must tolerate a beforeAll that never
    // completed — a failed launch is exactly when cleanup matters.
    let app: ElectronApplication | undefined
    let page: Page
    let cleanupProfile: (() => void) | undefined

    test.beforeAll(async () => {
      const launched = await launchPackaged()
      app = launched.app
      page = launched.page
      cleanupProfile = launched.cleanup
    })

    test.afterAll(async () => {
      if (app !== undefined) await app.close()
      cleanupProfile?.()
    })

    test('open → ready → a real analysis readout, with no engine override', async () => {
      await importAndOpen(page)

      // `ready` is proven, not declared: the 1-visit probe round-tripped through
      // the production parser inside the packaged app — which required the
      // bundled binary AND net to have shipped where `locate.ts` resolves them.
      await expect(
        page.getByTestId('engine-status').locator('.engine-status__value--ready'),
      ).toBeVisible({ timeout: 30_000 })

      // A real read: the readout names a percentage and the engine's visit
      // count for the settings-default 500-visit query. The real engine does
      // not echo the cap the way the fake does — it overshoots to the next NN
      // batch boundary (measured: 501) — so the assertion is a range, not an
      // exact match.
      await expect(page.getByTestId('analysis-winrate')).toContainText('%', {
        timeout: 30_000,
      })
      // The element is `<i18n label> <count>`; the app boots in zh-CN, so the
      // number is picked out of the string rather than parsed off the start.
      // Partial ticks land here long before the search settles (the store takes
      // both), so poll until the visits reach the settings-default cap rather
      // than snapshotting the first tick (measured: ~30 visits ~0.5s in, cap
      // reached ~3.4s in on the reference machine).
      await expect
        .poll(
          async () => {
            const text = (await page.getByTestId('analysis-visits').innerText()).trim()
            const match = /\d[\d,]*/.exec(text)
            return match === null ? 0 : Number.parseInt(match[0].replace(/,/g, ''), 10)
          },
          { timeout: 30_000, intervals: [500] },
        )
        .toBeGreaterThanOrEqual(450)
    })
  })
}
