import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { firstPage, launchApp } from './harness'

/**
 * Live analysis end-to-end: the real app, the real main process, and the real
 * spawned fake KataGo — selected through the production `GOMENTOR_KATAGO_BINARY`
 * override, with `planEngineLaunch` resolving the TypeScript child through the
 * app's own runtime. Nothing inside the app is stubbed; what is faked is the
 * engine on the other end of the pipe, which is the only piece a CI runner
 * cannot have.
 *
 * ## Why one sequential flow instead of independent tests
 *
 * The scenario is inherently ordered — open a record, watch analysis land, step,
 * watch it follow, step onto a faulted query, watch the rejection hold, step
 * again, watch it recover. Every stage reads the UI state the previous stage
 * left behind, so the tests share one app and run in file order. A failure
 * cascades by design: that is what a broken sequence means.
 *
 * ## Navigation shape (why the steps go through `move-tree-first`)
 *
 * Opening a record places the cursor at the END (`gameStore.open` — a review
 * starts from the final position), so `move-tree-next` is disabled at open.
 * The flow therefore seeks to the start first and then steps forward: cursor
 * 53 → 0 → 1 → 2 → 3. With `atMove` riding the cursor, the issued focus
 * queries are focus:1 (open, position 53), focus:2 (position 0), focus:3
 * (position 1), focus:4 (position 2).
 *
 * ## The wrong-length ownership rejection, observed from the renderer
 *
 * `FAKE_KATAGO_OWNERSHIP_SHORT=focus:3` makes the fake answer that one query
 * with an ownership array one point short. The production parser rejects the
 * whole result (B4), so the readout must revert to "no analysis" and stay
 * there — while the steps before and after repopulate normally. That pairing
 * is the load-bearing part: persistence of the empty state proves rejection
 * only because the surrounding steps prove the path itself is healthy.
 *
 * ## Locale
 *
 * The app boots in its default locale (zh-CN, with en fallback); assertions
 * therefore match on digits and testids, never on translated label text.
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

/** The fake child, addressed through the same env override support uses. */
const FAKE_CHILD = resolve(__dirname, '..', 'integration', 'fake-katago-child.ts')

test.describe('live analysis against the spawned fake engine', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await launchApp({
      env: {
        GOMENTOR_KATAGO_BINARY: FAKE_CHILD,
        // The third focus query (the first `next` step) answers with a
        // wrong-length ownership array; every other query is well-formed.
        FAKE_KATAGO_OWNERSHIP_SHORT: 'focus:3',
      },
    })
    page = await firstPage(app)
  })

  test.afterAll(async () => {
    await app.close()
  })

  /** The analysis readout values currently on screen, or null while empty. */
  async function readout(): Promise<{ winrate: string; visits: string } | null> {
    const winrateNode = page.getByTestId('analysis-winrate')
    if ((await winrateNode.count()) === 0) return null
    return {
      winrate: (await winrateNode.innerText()).trim(),
      visits: (await page.getByTestId('analysis-visits').innerText()).trim(),
    }
  }

  /**
   * Scans the dynamic canvas around a board coordinate for the candidate
   * marker's blue family (disc `rgba(43, 108, 176, …)`). Geometry mirrors
   * `computeGeometry`: padding = spacing = size/(size+1) of the canvas, and a
   * zero-indexed coord `x` lands at `(1 + x) * spacing` from the canvas edge.
   */
  async function candidateBlueAt(coord: { x: number; y: number }): Promise<boolean> {
    return page.evaluate(({ x, y }) => {
      const canvas = document.querySelector('canvas.board__dynamic')
      if (!(canvas instanceof HTMLCanvasElement)) return false
      const rect = canvas.getBoundingClientRect()
      const ctx = canvas.getContext('2d')
      if (ctx === null) return false
      const spacing = rect.width / 10 // 9×9 board: size+1 cells
      const cx = spacing * (1 + x)
      const cy = spacing * (1 + y)
      const radius = spacing * 0.3
      const dpr = window.devicePixelRatio || 1
      for (let dy = -radius; dy <= radius; dy += 2) {
        for (let dx = -radius; dx <= radius; dx += 2) {
          if (dx * dx + dy * dy > radius * radius) continue
          const px = ctx.getImageData(
            Math.round((cx + dx) * dpr),
            Math.round((cy + dy) * dpr),
            1,
            1,
          ).data
          const r = px[0] ?? 0
          const g = px[1] ?? 0
          const b = px[2] ?? 0
          // Board wood is r-dominant; black/white stones are neutral. The
          // marker is the only blue-dominant thing the canvas can paint.
          if (b - r >= 20 && b >= g) return true
        }
      }
      return false
    }, coord)
  }

  test('open → ready → candidates, ownership, and a per-position readout', async () => {
    // Open over the real user path: import, then click the library row — which
    // round-trips through sgf:serialize into gameStore.open, the same way a
    // user's click does.
    const ok = await page.evaluate(async (filePath) => {
      const result = await window.gomentor.library.import({ filePaths: [filePath] })
      return result.ok && result.data.imported.length === 1
    }, FIXTURE_SGF)
    expect(ok).toBe(true)

    await page.getByTestId('library-list').locator('button.library-row').first().click()
    // The record opens at its end position: 53 moves in the fixture.
    await expect(page.getByTestId('board-move')).toContainText('53')

    // The badge is fed by the store seeded from engine:info + engine:status.
    // Ready means the 1-visit probe round-tripped through the production parser
    // inside the service; only then is the held setGame issued as focus:1.
    await expect(
      page.getByTestId('engine-status').locator('.engine-status__value--ready'),
    ).toBeVisible({ timeout: 15_000 })

    // The first focus query's result round-tripped: the readout names a winrate
    // (rendered as a percentage) and the engine's visit count — the canned
    // rootInfo echoes the request's maxVisits, whose default is 500.
    await expect(page.getByTestId('analysis-winrate')).toContainText('%', {
      timeout: 15_000,
    })
    const first = await readout()
    expect(first?.winrate).toMatch(/\d+(\.\d+)?%/)
    expect(first?.visits).toContain('500')

    // Candidate markers: the fake suggests the quarter-board points (2,2) and
    // (6,6), always legal on a 9×9. Both wear the blue lettered disc.
    expect(await candidateBlueAt({ x: 2, y: 2 })).toBe(true)
    expect(await candidateBlueAt({ x: 6, y: 6 })).toBe(true)

    // Ownership rides with the result, so the toggle is live. Flipping it must
    // repaint the dynamic canvas: count pixels that changed across the toggle.
    const changed = await page.evaluate(async () => {
      const canvas = document.querySelector('canvas.board__dynamic')
      if (!(canvas instanceof HTMLCanvasElement)) return -1
      const ctx = canvas.getContext('2d')
      const toggle = document.querySelector('[data-testid="ownership-toggle"]')
      if (ctx === null || toggle === null) return -1
      const read = (): Uint8ClampedArray =>
        ctx.getImageData(0, 0, canvas.width, canvas.height).data
      const before = read()
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // React processes the click, the store flips, the board effect redraws
      // on the next frame — give that chain a moment before the second read.
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      const after = read()
      let count = 0
      for (let index = 0; index < before.length; index += 4) {
        if (
          Math.abs((before[index] ?? 0) - (after[index] ?? 0)) > 8 ||
          Math.abs((before[index + 1] ?? 0) - (after[index + 1] ?? 0)) > 8 ||
          Math.abs((before[index + 2] ?? 0) - (after[index + 2] ?? 0)) > 8
        ) {
          count += 1
        }
      }
      return count
    })
    expect(changed).toBeGreaterThan(500)
    await expect(page.getByTestId('ownership-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Back off, so the candidate assertion in the recovery stage sees the
    // plain board-plus-markers layer.
    await page.getByTestId('ownership-toggle').click()
    await expect(page.getByTestId('ownership-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  test('a healthy step moves the analysis: empty on cursor change, repopulated for the new position', async () => {
    // `next` is disabled at the end position; seek to the start first.
    await page.getByTestId('move-tree-first').click()
    await expect(page.getByTestId('board-move')).toContainText('0')
    // setExpectation clears the accepted focus synchronously — the readout
    // must drop before the next result lands (and must land again after).
    await expect(page.getByTestId('analysis-empty')).toBeVisible()
    await expect(page.getByTestId('analysis-winrate')).toContainText('%', {
      timeout: 15_000,
    })
  })

  test('a wrong-length ownership array is rejected: the readout stays empty', async () => {
    await page.getByTestId('move-tree-next').click()
    await expect(page.getByTestId('board-move')).toContainText('1')

    // focus:3 is the faulted query. A healthy round trip completes in well
    // under a second (the previous stage proves it); staying empty far longer
    // than that is the rejection, not slowness.
    await expect(page.getByTestId('analysis-empty')).toBeVisible()
    await page.waitForTimeout(2_000)
    expect(await readout()).toBeNull()
    await expect(page.getByTestId('analysis-empty')).toBeVisible()
  })

  test('the next position recovers: rejection killed one result, not the stream', async () => {
    await page.getByTestId('move-tree-next').click()
    await expect(page.getByTestId('board-move')).toContainText('2')
    await expect(page.getByTestId('analysis-winrate')).toContainText('%', {
      timeout: 15_000,
    })
    // And candidates paint again on the new position.
    expect(await candidateBlueAt({ x: 2, y: 2 })).toBe(true)
  })
})
