import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { firstPage, launchApp } from './harness'

/**
 * The whole-record sweep and branch navigation, end to end: the real app, the
 * real main process, and the real spawned fake KataGo (through the production
 * `GOMENTOR_KATAGO_BINARY` override). `FAKE_KATAGO_DELAY_MS` makes the fake
 * take 200ms per analysis response, so the sweep fills the winrate graph
 * *progressively* — a spec can watch points appear instead of meeting an
 * instant 33. No argv can reach the env-override launch path, which is why
 * the delay is env-selected in the fake.
 *
 * ## Fixture
 *
 * `gnugo-9x9-4-qgo-var.sgf`: 18 moves, then a branch point whose children are
 * a 15-move line (child 0 — also the mainline continuation, so the mainline
 * runs 33 moves) and an 11-move line (child 1, ending at B+8.0). Probed
 * against the real adapter before being pinned here.
 *
 * ## Why one sequential flow
 *
 * Same reasoning as `analysis.spec.ts`: every stage reads the UI state the
 * previous stage left (33 points on the graph, cursor at 18 with the picker
 * open, the 29-move variation rendered), so the tests share one app and run
 * in file order. A failure cascades by design.
 *
 * ## Locale
 *
 * The app boots in its default locale (zh-CN, en fallback); assertions match
 * on digits and testids, never on translated text.
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
  'gnugo-9x9-4-qgo-var.sgf',
)

/** The fake child, addressed through the same env override support uses. */
const FAKE_CHILD = resolve(__dirname, '..', 'integration', 'fake-katago-child.ts')

/** The record's move count — the x-axis of the graph. */
const TOTAL = 33
/** Settled points: every position 0..TOTAL inclusive (move 0 is a position). */
const POINTS = TOTAL + 1
/** The variation line's move count after choosing child 1 at the branch point. */
const VARIATION_TOTAL = 29
/** Its settled points, same 0..N inclusive counting. */
const VARIATION_POINTS = VARIATION_TOTAL + 1

test.describe('the sweep, the graph, and branch navigation', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await launchApp({
      env: {
        GOMENTOR_KATAGO_BINARY: FAKE_CHILD,
        // 200ms per analysis response: the sweep takes seconds, not
        // milliseconds, so "fills progressively" is observable.
        FAKE_KATAGO_DELAY_MS: '200',
      },
    })
    page = await firstPage(app)

    // Open over the real user path: import, then click the library row.
    const ok = await page.evaluate(async (filePath) => {
      const result = await window.gomentor.library.import({ filePaths: [filePath] })
      return result.ok && result.data.imported.length === 1
    }, FIXTURE_SGF)
    expect(ok).toBe(true)
    await page.getByTestId('library-list').locator('button.library-row').first().click()
  })

  test.afterAll(async () => {
    await app.close()
  })

  /** How many settled points the graph currently holds. */
  async function pointCount(): Promise<number> {
    return page.locator('[data-testid^="winrate-point-"]').count()
  }

  /** Clicks the graph at the slot for `move` (inside its 1/total span). */
  async function clickGraphAt(move: number, total: number): Promise<void> {
    const svg = page.getByTestId('winrate-graph-svg')
    const box = await svg.boundingBox()
    if (box === null) throw new Error('graph has no box')
    // Offset 0.4, not the slot centre: the handler rounds fraction*total, and
    // a .5 fraction rounds UP — (10.5/33) would seek 11, not 10.
    await svg.click({
      position: { x: box.width * ((move + 0.4) / total), y: box.height / 2 },
    })
  }

  test('opening a record starts a sweep: the graph fills progressively', async () => {
    // The record opens at its end position: 33 moves in the fixture.
    await expect(page.getByTestId('board-move')).toContainText('33')
    await expect(
      page.getByTestId('engine-status').locator('.engine-status__value--ready'),
    ).toBeVisible({ timeout: 15_000 })

    // The first settled point lands well before the sweep is done — this is
    // the load-bearing assertion that the graph fills while the user reviews
    // rather than appearing all at once when the sweep finishes.
    await expect
      .poll(async () => pointCount(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    const earlyCount = await pointCount()
    expect(earlyCount).toBeLessThan(POINTS)

    // …and the sweep runs to completion: every position 0..33 settled, the
    // pending region gone entirely.
    await expect.poll(async () => pointCount(), { timeout: 30_000 }).toBe(POINTS)
    await expect(page.getByTestId('winrate-graph-pending')).toHaveCount(0)
  })

  test('clicking the graph seeks the cursor to that move', async () => {
    await clickGraphAt(10, TOTAL)
    await expect(page.getByTestId('board-move')).toContainText('10')

    // The seek re-points the analysis: the readout drops and repopulates for
    // position 10 — proof the click drove the engine, not just the cursor.
    await expect(page.getByTestId('analysis-winrate')).toContainText('%', {
      timeout: 15_000,
    })
  })

  test('at a branch point the picker offers both lines', async () => {
    await clickGraphAt(18, TOTAL)
    await expect(page.getByTestId('board-move')).toContainText('18')

    const picker = page.getByTestId('branch-picker')
    await expect(picker).toBeVisible()
    // Child 0 is the active line (the mainline), child 1 the alternative.
    await expect(page.getByTestId('branch-option-0')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByTestId('branch-option-1')).toBeVisible()
    // The sweep is untouched by cursor moves: the graph still holds all 34.
    expect(await pointCount()).toBe(POINTS)
  })

  test('choosing a variation re-parses, re-drives the engine, and re-sweeps', async () => {
    await page.getByTestId('branch-option-1').click()

    // The variation line renders: 29 moves, landing at its end position.
    await expect(page.getByTestId('board-move')).toContainText('29')
    // Its final move is the variation's last move, B[be] — the B+8.0 line.
    await expect(page.getByTestId('analysis-winrate')).toContainText('%', {
      timeout: 15_000,
    })

    // The graph reset for the new line — the pending region is back while the
    // fresh sweep works through the 29 positions…
    await expect(page.getByTestId('winrate-graph-pending')).toBeVisible()
    await expect
      .poll(async () => pointCount(), { timeout: 30_000 })
      .toBe(VARIATION_POINTS)
    // …and no picker at the variation's end: its line has no branch point
    // after move 29 (the one branch point sits at move 18, behind the cursor).
    await expect(page.getByTestId('branch-picker')).toHaveCount(0)
    await expect(page.getByTestId('winrate-graph-pending')).toHaveCount(0)
  })
})
