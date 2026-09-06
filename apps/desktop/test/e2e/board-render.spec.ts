import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { parseSgf } from '@gomentor/core/sgf/parser'
import { mainline } from '@gomentor/core/sgf/ast'
import { getMove, getSetup } from '@gomentor/core/sgf/props'
import { Position } from '@gomentor/core/board/position'
import type { BoardSize, Coord, Player } from '@gomentor/shared'
import { firstPage, launchApp } from './harness'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')

/**
 * A3: the board renders the correct position for 9×9, 13×13 and 19×19.
 *
 * ## Why this is an e2e test against the built app
 *
 * The bug class is coordinate conversion between SGF (top-left, no I-skip),
 * internal `{x,y}`, and canvas pixels. All three conversions live in
 * `@gomentor/core` and are unit-tested exhaustively, but the renderer adds two
 * more transformations: how it maps the internal position to canvas pixels, and
 * how it scales for `devicePixelRatio`. An off-by-one in the canvas layout
 * (padding versus spacing) looks fine until you compare stone placement against
 * a known reference.
 *
 * ## The assertion is pixel-based, but not a screenshot comparison
 *
 * Screenshot tests are brittle across OS fonts and DPR. Instead the test reads
 * individual pixels at computed intersection centres and checks whether they are
 * black or white. The centre of a stone is the most stable pixel; the edge of a
 * stone is antialiased and varies with DPR.
 *
 * ## Three fixtures, one per canonical size
 *
 * - 9×9: a short game with captures.
 * - 13×13: a game that exercises the board edge.
 * - 19×19: a 9-stone handicap game, which catches setup-stone placement
 *   (handicap stones are `AB`/`AW`, not moves, and have been lost before).
 *
 * Each fixture has a small, stable set of stones at the final position that the
 * test asserts, rather than comparing the whole board. This keeps the test from
 * depending on move-count details while still proving the coordinate path is
 * correct.
 */

interface Fixture {
  path: string
  size: 9 | 13 | 19
  /** Stones expected at the final position, in internal {x,y} form. */
  expected: { coord: { x: number; y: number }; color: 'black' | 'white' }[]
}

function finalPosition(
  filePath: string,
  size: BoardSize,
): { coord: Coord; color: Player }[] {
  const source = readFileSync(resolve(REPO_ROOT, filePath), 'utf8')
  const collection = parseSgf(source)
  const root = collection.roots[0]
  if (root === undefined) throw new Error(`no root in ${filePath}`)

  let position = Position.empty(size)
  const setup = getSetup(root, size)
  position = position.setup([
    ...setup.black.map((coord) => ({ coord, player: 'black' as const })),
    ...setup.white.map((coord) => ({ coord, player: 'white' as const })),
  ])

  for (const node of mainline(root).slice(1)) {
    const move = getMove(node, size)
    if (move === null) continue
    if (move.coord === null) continue
    const result = position.place(move.coord, move.player)
    position = result.position
  }

  const stones = position.toArray()
  const out: { coord: Coord; color: Player }[] = []
  for (let index = 0; index < stones.length; index += 1) {
    const player = stones[index]
    if (player === null || player === undefined) continue
    out.push({ coord: { x: index % size, y: Math.floor(index / size) }, color: player })
  }
  return out
}

/** Pick a small, diverse set of stones to assert against the canvas. */
function pickReference(
  stones: { coord: Coord; color: Player }[],
  size: BoardSize,
): { coord: Coord; color: Player }[] {
  const byColor = {
    black: stones.filter((s) => s.color === 'black'),
    white: stones.filter((s) => s.color === 'white'),
  }

  const pick = (
    list: typeof stones,
    predicate: (c: Coord) => boolean,
  ): (typeof stones)[number] | undefined => {
    const found = list.find((s) => predicate(s.coord))
    return found ?? list[0]
  }

  const reference: { coord: Coord; color: Player }[] = []
  if (byColor.black.length > 0) {
    const black = pick(byColor.black, (c) => c.x === c.y && c.x > size / 3)
    if (black !== undefined) reference.push(black)
  }
  if (byColor.white.length > 0) {
    const white = pick(byColor.white, (c) => c.x !== c.y)
    if (white !== undefined) reference.push(white)
  }
  return reference
}

const FIXTURES: Fixture[] = [
  {
    path: 'packages/core/test/fixtures/sgf/gnugo-9x9-1-pass.sgf',
    size: 9,
    expected: pickReference(
      finalPosition('packages/core/test/fixtures/sgf/gnugo-9x9-1-pass.sgf', 9),
      9,
    ),
  },
  {
    path: 'packages/core/test/fixtures/sgf/gnugo-incident96-13x13-lb.sgf',
    size: 13,
    expected: pickReference(
      finalPosition(
        'packages/core/test/fixtures/sgf/gnugo-incident96-13x13-lb.sgf',
        13,
      ),
      13,
    ),
  },
  {
    path: 'packages/core/test/fixtures/sgf/gnugo-9handicap-glgo-latin1.sgf',
    size: 19,
    expected: [
      // 9 handicap stones: the four corners, four side stars, and tengen.
      { coord: { x: 3, y: 3 }, color: 'black' },
      { coord: { x: 9, y: 3 }, color: 'black' },
      { coord: { x: 15, y: 3 }, color: 'black' },
      { coord: { x: 3, y: 9 }, color: 'black' },
      { coord: { x: 9, y: 9 }, color: 'black' },
      { coord: { x: 15, y: 9 }, color: 'black' },
      { coord: { x: 3, y: 15 }, color: 'black' },
      { coord: { x: 9, y: 15 }, color: 'black' },
      { coord: { x: 15, y: 15 }, color: 'black' },
    ],
  },
]

/** Creates a temp SGF file in the *test* Node process and returns its path. */
function writeTempSgf(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gomentor-a3-'))
  const filePath = join(dir, 'test.sgf')
  writeFileSync(filePath, content)
  return filePath
}

async function openFile(
  _app: ElectronApplication,
  page: Page,
  filePath: string,
): Promise<void> {
  const absolute = resolve(REPO_ROOT, filePath)
  const content = readFileSync(absolute, 'utf8')
  const tempPath = writeTempSgf(content)

  const imported = await page.evaluate(async (path) => {
    const result = await window.gomentor.library.import({ filePaths: [path] })
    return result.ok
  }, tempPath)
  expect(imported).toBe(true)

  // Wait for the library list to update and for the game to be selected.
  await expect(page.getByTestId('library-list').getByRole('listitem')).toHaveCount(1)
  await page.getByTestId('library-list').getByRole('listitem').first().click()

  // Opening selects the final move by default.
  await expect(page.getByTestId('board-canvas')).toBeVisible()
}

test.describe('the board renders the correct position at each size', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeEach(async () => {
    app = await launchApp({
      env: {
        // This spec is about canvas geometry, not the engine. Opening a record
        // lazily starts the engine — which since the real fetch exists means
        // every run of this spec would silently spawn real KataGo and burn
        // CPU on positions it never asserts on. The override names a path
        // that does not exist; in dev mode that degrades to `unavailable`
        // (the expected-absence state), keeping the spec engine-free on any
        // machine.
        GOMENTOR_KATAGO_BINARY: join(REPO_ROOT, 'no-such-engine'),
      },
    })
    page = await firstPage(app)
  })

  test.afterEach(async () => {
    await app.close()
  })

  for (const fixture of FIXTURES) {
    const label = `${String(fixture.size)}×${String(fixture.size)} from ${fixture.path}`
    test(label, async () => {
      await openFile(app, page, fixture.path)

      const canvas = page.getByTestId('board-canvas').locator('canvas').first()
      const box = await canvas.boundingBox()
      if (box === null) throw new Error('canvas bounding box not found')

      // The board is square and centred; the CSS size is the smaller dimension.
      const cssSize = Math.min(box.width, box.height)

      for (const { coord, color } of fixture.expected) {
        // Compute the canvas centre for this intersection in CSS pixels.
        // Geometry mirrors Board.tsx: padding = spacing = cssSize / (size + 1).
        const spacing = cssSize / (fixture.size + 1)
        const padding = spacing
        const cx = padding + coord.x * spacing
        const cy = padding + coord.y * spacing
        const px = box.x + cx
        const py = box.y + cy

        // Read a single pixel. Playwright returns `{r,g,b}` 0-255.
        const pixel = await page.evaluate(
          ({ x, y }) => {
            const element = document.elementFromPoint(x, y)
            if (element === null || !(element instanceof HTMLCanvasElement)) {
              return null
            }
            const rect = element.getBoundingClientRect()
            const ctx = element.getContext('2d')
            if (ctx === null) return null
            // Scale from CSS to backing-store pixels using the canvas's own size.
            const scaleX = element.width / rect.width
            const scaleY = element.height / rect.height
            const data = ctx.getImageData(
              (x - rect.left) * scaleX,
              (y - rect.top) * scaleY,
              1,
              1,
            ).data
            return { r: data[0], g: data[1], b: data[2], a: data[3] }
          },
          { x: px, y: py },
        )

        if (pixel === null) return

        // `getImageData` returns a Uint8ClampedArray; the four entries are defined
        // for a 1×1 read, but the type is number | undefined. Narrow explicitly.
        const r = pixel.r ?? 0
        const g = pixel.g ?? 0
        const b = pixel.b ?? 0
        const luminance = (r + g + b) / 3
        if (color === 'black') {
          expect(
            luminance,
            `expected black stone at (${String(coord.x)},${String(coord.y)})`,
          ).toBeLessThan(80)
        } else {
          expect(
            luminance,
            `expected white stone at (${String(coord.x)},${String(coord.y)})`,
          ).toBeGreaterThan(200)
        }
      }
    })
  }
})
