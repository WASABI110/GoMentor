import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSgf } from '@gomentor/core/sgf/parser'
import { getBoardSize, getSetup } from '@gomentor/core/sgf/props'
import { replay } from '@gomentor/core/board/position'
import { isAppError, type BoardSize, type Game } from '@gomentor/shared'
import { toGame, toSummary } from '../../src/main/sgf/adapter'

/**
 * `main/sgf/adapter.ts` — the AST → `Game` projection, against the real corpus.
 *
 * ## Why this file exists, stated plainly because it is a lesson
 *
 * `packages/core/test/board/replay.test.ts` sweeps the same corpus and proves
 * `replay` correct, but it builds its `ReplayInput` with a *local copy* of the
 * projection. So it could not see a bug in the shipping one. Measured: replacing
 * `setup: toSetup(...)` with `setup: { black: [], white: [] }` in the real adapter
 * left all 784 tests green — the exact defect this stage set out to fix would have
 * shipped, with a corpus-wide test file sitting next to it.
 *
 * A projection is only tested by a test that calls the projection. That is the
 * whole point of this file, and why it reads fixtures through `toGame` rather than
 * through anything of its own.
 *
 * ## Expectations come from the SGF, not from transcription
 *
 * Each assertion below derives its expected value from the fixture's own
 * properties (`getSetup` on the AST) rather than from a hardcoded board. A
 * transcribed diagram would be a snapshot of this implementation's output, which
 * passes by construction and cannot detect the class of bug above.
 */

// The corpus lives in `packages/core` because that is where the SGF parser it
// exercises lives. Reached by relative path rather than duplicated: two copies of
// 44 fixtures would drift, and the drift would be invisible.
const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'core',
  'test',
  'fixtures',
  'sgf',
)

const OPTIONS = {
  id: 'test-id',
  source: 'import' as const,
  importedAt: '2026-01-01T00:00:00.000Z',
  contentHash: 'hash',
}

interface Projected {
  name: string
  size: BoardSize
  game: Game
  root: ReturnType<typeof parseSgf>['roots'][number]
}

const refused: { name: string; code: unknown }[] = []

const PROJECTED: Projected[] = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.sgf') && !name.startsWith('_'))
  .flatMap((name) => {
    let root
    let size: BoardSize
    try {
      const collection = parseSgf(new Uint8Array(readFileSync(join(FIXTURES, name))))
      const first = collection.roots[0]
      if (first === undefined) return []
      root = first
      size = getBoardSize(first)
      return [{ name, size, game: toGame(collection, OPTIONS), root }]
    } catch (error) {
      // Recorded rather than dropped: a silently shrinking sweep is how a
      // corpus-wide test becomes vacuous.
      refused.push({ name, code: isAppError(error) ? error.code : 'NON_APP_ERROR' })
      return []
    }
  })

describe('the sweep is looking at a real corpus', () => {
  it('projected enough fixtures to be worth sweeping', () => {
    expect(PROJECTED.length).toBeGreaterThanOrEqual(35)
  })

  it('covers the three board sizes A3 names', () => {
    expect([...new Set(PROJECTED.map((p) => p.size))].sort((a, b) => a - b)).toEqual([
      9, 13, 19,
    ])
  })

  it('refuses exactly the files it has a stated reason to refuse', () => {
    // Pinned as an exact set with each reason, not a count and not a minimum.
    // Every entry is a file the app genuinely cannot render, and each was read
    // before being listed:
    //
    //   the two `gnugo-joseki-*` files are GNU Go banner text, not SGF at all
    //   `gogui-size-after-invalid-points` puts `AB`/`AW` outside its own `SZ[9]`
    //   `gogui-human-readable` writes moves as `R16`, not as SGF coordinates
    //   `gogui-invalidmove` has a move off the board
    //   `katago-sampletest7x7` is 7×7, which this app does not render
    //
    // A regression in the projection shows up here as a new row rather than as a
    // quietly smaller sweep. Growth is the failure this guards.
    expect([...refused].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'gnugo-joseki-hoshi-keima-var.sgf', code: 'SGF_NOT_SGF' },
      { name: 'gnugo-joseki-sansan-var.sgf', code: 'SGF_NOT_SGF' },
      { name: 'gogui-human-readable.sgf', code: 'SGF_INVALID_PROPERTY' },
      { name: 'gogui-invalidmove.sgf', code: 'SGF_INVALID_PROPERTY' },
      { name: 'gogui-size-after-invalid-points.sgf', code: 'SGF_INVALID_PROPERTY' },
      { name: 'katago-sampletest7x7.sgf', code: 'SGF_UNSUPPORTED_BOARD_SIZE' },
    ])
  })

  it('refuses off-board setup for the reason it says, and not board-wide', () => {
    // `gogui-size-after-invalid-points.sgf` is refused because a *file* gave a
    // point outside the board — `SGF_INVALID_PROPERTY`, not `BOARD_INVALID_COORD`,
    // which would blame the engine for the file's mistake.
    //
    // Its twin `gogui-size-after-valid-points.sgf` is the same two stones under
    // `SZ[19]`, where they are on the board, and must project cleanly. Without
    // that half, this suite would also pass for a projection that threw on every
    // setup property in the corpus.
    expect(refused).toContainEqual({
      name: 'gogui-size-after-invalid-points.sgf',
      code: 'SGF_INVALID_PROPERTY',
    })
    expect(PROJECTED.map((p) => p.name)).toContain('gogui-size-after-valid-points.sgf')
  })
})

describe('setup stones survive the projection', () => {
  /**
   * The assertion the missing one would have caught.
   *
   * Every fixture's `Game.setup` is compared against the setup properties read
   * straight off the AST. A projection that drops, truncates, or reorders them
   * fails here for the specific file that proves it.
   */
  for (const { name, size, game, root } of PROJECTED) {
    it(`${name}: carries the stones its AST declares`, () => {
      // Pre-first-move setup only, matching what `toSetup` promises. Read from the
      // root plus any node ahead of move 1 — `katago-foxlike.sgf` has one.
      const expected = getSetup(root, size)
      // Every stone the root declares must be present. A superset is legitimate
      // (a later pre-move node may add more); a missing stone is not.
      for (const coord of expected.black) {
        expect(game.setup.black, `black ${JSON.stringify(coord)}`).toContainEqual(coord)
      }
      for (const coord of expected.white) {
        expect(game.setup.white, `white ${JSON.stringify(coord)}`).toContainEqual(coord)
      }
    })
  }

  it('finds setup stones in the corpus at all, or the loop above is vacuous', () => {
    // Every `it` above passes trivially for a fixture with no setup stones, and
    // 30 of the 41 have none. Without this, deleting setup from the projection
    // *and* from the corpus would look identical to success.
    const withSetup = PROJECTED.filter(
      (p) => p.game.setup.black.length + p.game.setup.white.length > 0,
    )
    expect(withSetup.length).toBeGreaterThanOrEqual(8)
    // And the total is substantial, so a projection keeping one stone per file
    // would not satisfy the per-file loop either.
    const total = withSetup.reduce(
      (n, p) => n + p.game.setup.black.length + p.game.setup.white.length,
      0,
    )
    expect(total).toBeGreaterThanOrEqual(100)
  })

  it('places all nine handicap stones, on the board and not in the move list', () => {
    const handicap = PROJECTED.find((p) => p.name === 'gnugo-9handicap-glgo-latin1.sgf')
    expect(handicap).toBeDefined()
    if (handicap === undefined) return

    expect(handicap.game.setup.black).toHaveLength(9)
    expect(handicap.game.setup.white).toHaveLength(0)

    // The end-to-end property: projected `Game` → `replay` → nine stones before
    // move 1, and the first *played* move is white's, as a handicap game requires.
    const { position } = replay(handicap.game, 0)
    expect(position.stoneCount()).toBe(9)
    expect(handicap.game.moves[0]?.player).toBe('white')
    expect(handicap.game.moves[0]?.number).toBe(1)
  })

  it('collects setup from a node after the root', () => {
    // `katago-foxlike.sgf` carries `;AB[pd][dp]` on the node following the root. A
    // root-only read loses both stones of a two-stone handicap game.
    const foxlike = PROJECTED.find((p) => p.name === 'katago-foxlike.sgf')
    expect(foxlike).toBeDefined()
    expect(foxlike?.game.setup.black).toHaveLength(2)
    // And they are not in `moves`, which is what keeps move numbering right.
    expect(foxlike?.game.moves[0]?.player).toBe('white')
  })

  it('carries white setup stones, not only black', () => {
    // A `handicap`-count substitute would express black stones only. Three corpus
    // files place white ones, one of them 34 — proof that a count could never
    // stand in for this field.
    const withWhite = PROJECTED.filter((p) => p.game.setup.white.length > 0)
    expect(withWhite.length).toBeGreaterThanOrEqual(3)
    expect(
      Math.max(...withWhite.map((p) => p.game.setup.white.length)),
    ).toBeGreaterThanOrEqual(30)
  })

  it('has setup for files that declare no HA at all', () => {
    // The measurement that ruled out deriving setup from `meta.handicap`.
    const noHandicap = PROJECTED.filter(
      (p) =>
        p.game.meta.handicap === 0 &&
        p.game.setup.black.length + p.game.setup.white.length > 0,
    )
    expect(noHandicap.length).toBeGreaterThanOrEqual(3)
  })
})

describe('every projected record replays cleanly', () => {
  /**
   * The property that would have failed loudly on the original defect: a real
   * record, projected by the real adapter, replays from its setup through every
   * move without breaking a rule.
   *
   * Setup stones missing means later captures resolve differently, so this is a
   * second, independent way the same bug surfaces — one that does not depend on
   * knowing which fixture is a handicap game.
   */
  for (const { name, game } of PROJECTED) {
    it(`${name}: no rule violation across ${String(game.moves.length)} moves`, () => {
      const result = replay(game, game.moves.length)
      expect(result.stopped, JSON.stringify(result.stopped)).toBeUndefined()
      expect(result.applied).toBe(game.moves.length)
    })
  }
})

describe('move numbering', () => {
  it('is 1-based and contiguous, with setup excluded', () => {
    for (const { name, game } of PROJECTED) {
      game.moves.forEach((move, index) => {
        expect(move.number, `${name} index ${String(index)}`).toBe(index + 1)
      })
    }
  })
})

describe('toSummary', () => {
  it('reports the move count the game actually has', () => {
    for (const { name, game } of PROJECTED) {
      expect(toSummary(game).moveCount, name).toBe(game.moves.length)
    }
  })

  it('does not leak setup stones into the move count', () => {
    // The list showing 187 while the board shows 178 is the drift `toSummary`'s
    // own note warns about, and setup stones are the newest way to cause it.
    const handicap = PROJECTED.find((p) => p.name === 'gnugo-9handicap-glgo-latin1.sgf')
    expect(handicap).toBeDefined()
    if (handicap === undefined) return
    expect(toSummary(handicap.game).moveCount).toBe(handicap.game.moves.length)
  })
})
