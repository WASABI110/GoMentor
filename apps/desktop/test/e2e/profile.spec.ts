import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { firstPage, launchApp } from './harness'

/**
 * C5 (M4 Stage 4): a weakness card's evidence opens the game and seeks to the
 * move — and the weakness itself is real, derived from rows a real batch run
 * produced.
 *
 * ## Nothing here is seeded directly
 *
 * The tempting shortcut is INSERT-ing analysis rows into the profile's SQLite
 * file. Two measured reasons it is not done: the e2e runner's
 * `better-sqlite3` binding is the Electron ABI at this point in the gate
 * (the e2e script rebuilds for Electron before Playwright starts), so a spec
 * process opening the database itself fails at `require`; and a hand-seeded
 * row would prove the panel renders rows, not that the batch tier the user
 * actually runs produces rows the profile can read. So the spec drives the
 * real path: import a generated SGF, configure the student's name, start the
 * batch through the bridge, and let the app analyse against the same spawned
 * fake KataGo `analysis.spec.ts` uses (`GOMENTOR_KATAGO_BINARY`). Every number
 * the panel shows was written by the production scheduler.
 *
 * ## Why the assertions avoid pinning a category
 *
 * The fake engine's winrates are hash-seeded per position in [0.5, 0.599], so
 * the seeded game's per-move losses are deterministic but their magnitude
 * profile is a hash artifact — which category fires is stable for a given
 * fixture, and pinning it would be pinning the hash. What C5 asks is the
 * click-through: some weakness exists, its evidence names a game and a move,
 * and clicking opens the board at exactly that move. Category semantics are
 * the core suites' job (`test/profile/categories.test.ts`), where they are
 * tested against explicit rows instead of a hash.
 */

/** The student name the generated SGF carries — the settings list matches it. */
const STUDENT = 'Student'

function buildStudentSgf(): string {
  // Thirty alternating moves in row-major order: distinct points, no
  // captures, no suicides — a record the fake engine can analyse and the
  // parser can round-trip.
  const moves = Array.from({ length: 30 }, (_, i) => {
    const x = i % 19
    const y = Math.floor(i / 19)
    const letter = (n: number): string => String.fromCharCode(97 + n)
    return `;${i % 2 === 0 ? 'B' : 'W'}[${letter(x)}${letter(y)}]`
  }).join('')
  return `(;GM[1]FF[4]CA[UTF-8]SZ[19]PB[${STUDENT}]PW[Opponent]KM[6.5]${moves})`
}

const FAKE_CHILD = resolve(__dirname, '..', 'integration', 'fake-katago-child.ts')

test.describe('the profile panel and its evidence click-through (C5)', () => {
  let app: ElectronApplication
  let page: Page
  let profileDir: string

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'gomentor-profile-'))
    // The SGF lives inside the isolated profile so the spec's only file writes
    // are ones the app never reads as settings.
    writeFileSync(join(profileDir, 'student.sgf'), buildStudentSgf())
    app = await launchApp({
      userDataDir: profileDir,
      env: {
        GOMENTOR_KATAGO_BINARY: FAKE_CHILD,
        // Slow the fake engine's answers: a 30-move game otherwise completes
        // inside one tick, and the progress readout the panel shows between
        // start and terminal would never be on screen long enough to assert.
        FAKE_KATAGO_DELAY_MS: '150',
      },
    })
    page = await firstPage(app)
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('a batch run produces weaknesses; evidence opens the board at the move', async () => {
    // Import the generated record through the real import path.
    const gameId = await page.evaluate(
      async (path) => {
        const result = await window.gomentor.library.import({ filePaths: [path] })
        if (!result.ok || result.data.imported.length !== 1) {
          throw new Error(`import failed: ${JSON.stringify(result)}`)
        }
        return result.data.imported[0]?.id
      },
      join(profileDir, 'student.sgf'),
    )
    expect(gameId).toBeDefined()

    // Configure the student's name BEFORE starting the batch: the queue reads
    // the names at start, and the derivation reads them per request.
    const named = await page.evaluate(async (name) => {
      const result = await window.gomentor.settings.set({
        patch: { profile: { playerNames: [name] } },
      })
      return result.ok
    }, STUDENT)
    expect(named).toBe(true)

    // Before any analysis the panel says so, with the count of my games it
    // found — the "run the batch analysis" state, not a blank panel.
    await expect(page.getByTestId('profile-empty')).toBeVisible()

    // Start the batch from the panel's own button: the run is the real
    // scheduler against the fake engine, writing rows and ledger.
    await page.getByTestId('profile-batch-start').click()

    // One game in scope: the readout counts COMPLETED games, so a single-game
    // run reads 0/1 for its whole duration and then the terminal event flips
    // the panel out of its running state — there is no intermediate "1/1"
    // moment to catch.
    await expect(page.getByTestId('profile-batch-progress')).toContainText('0/1')
    await expect(page.getByTestId('profile-batch-progress')).toHaveCount(0)

    // The terminal refetch derived the profile from the rows the run wrote.
    const card = page.locator('[data-testid^="profile-weakness-"]').first()
    await expect(card).toBeVisible()

    // The first evidence row of the first weakness: its move number comes off
    // the test id (`profile-evidence-<gameId>-<move>`), the same pair the
    // click-through uses.
    const evidenceButton = card.locator('[data-testid^="profile-evidence-"]').first()
    const testId = (await evidenceButton.getAttribute('data-testid')) ?? ''
    const moveText = /-(\d+)$/.exec(testId)?.[1]
    if (moveText === undefined) {
      throw new Error(`evidence test id carries no move number: ${testId}`)
    }

    // The click-through: serialize → open → seek. The board's move readout is
    // the cursor — landing on the evidence move is the criterion.
    await evidenceButton.click()
    await expect(page.getByTestId('board-move')).toContainText(moveText)
  })
})
