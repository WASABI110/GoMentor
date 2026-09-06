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

describe('variation lines and branch options (Stage 4)', () => {
  /**
   * Read-only branch navigation's projection (`design.md` §Branch navigation).
   * Every expectation below was probed against the real file, not predicted:
   * SGF's first-child convention means a file's "mainline" already continues
   * into the first variation, which is why `gnugo-9x9-4-qgo-var.sgf` reports
   * 33 mainline moves for what reads like 18 + two variations.
   *
   * The load-bearing decisions:
   *
   * - `variationPath` selects the line; absent/short means mainline, extra
   *   elements are never consumed, and an out-of-range index is the caller's
   *   bug (`IPC_INVALID_REQUEST`), not a file defect;
   * - `branches` is indexed by arrival index — entry `c` lists the
   *   alternatives at the node reached with `c` moves applied, so an
   *   end-of-record branch point sits at `moves.length` (qgo: 18) while a
   *   before-the-first-move point sits at 0 (ff4_ex);
   * - option `index` is the SGF child index, kept verbatim even when
   *   move-less alternatives make it non-contiguous — it is exactly what a
   *   re-parse's `variationPath` consumes;
   * - the array is dense: holes would cross IPC as `null`.
   */
  function load(name: string): ReturnType<typeof parseSgf> {
    return parseSgf(new Uint8Array(readFileSync(join(FIXTURES, name))))
  }

  function project(name: string, variationPath?: readonly number[]): Game {
    return toGame(load(name), {
      ...OPTIONS,
      ...(variationPath === undefined ? {} : { variationPath }),
    })
  }

  const QGO_VAR = 'gnugo-9x9-4-qgo-var.sgf'

  it('the mainline walks first children: 18 moves + the first variation = 33 moves', () => {
    const game = project(QGO_VAR)
    expect(game.moves).toHaveLength(33)
    // One branch point: the last mainline node, whose two children are the
    // variations. Arrival index 18 = the position after move 18.
    expect(game.branches).toHaveLength(19)
    expect(game.branches.slice(0, 18).every((entry) => entry.length === 0)).toBe(true)
    expect(game.branches[18]).toEqual([
      // Child 0 — the default continuation, itself 15 moves long (and the
      // reason the mainline is 33 moves, not 18).
      { index: 0, player: 'black', coord: { x: 7, y: 6 }, moves: 15 },
      // Child 1 — the 11-move alternative. Its C[B+8.0] sits on the line's
      // LAST node, so it is not the option label (labels come from the
      // alternative's first node); it rides as the final move's comment,
      // asserted in the variation test below.
      { index: 1, player: 'black', coord: { x: 8, y: 4 }, moves: 11 },
    ])
  })

  it('a variationPath selects the line: [1] follows the 11-move alternative', () => {
    const game = project(QGO_VAR, [1])
    expect(game.moves).toHaveLength(29)
    const last = game.moves.at(-1)
    expect(last?.player).toBe('black')
    expect(last?.coord).toEqual({ x: 1, y: 4 })
    // Comments ride the projection on any line, not only the mainline.
    expect(last?.comment).toBe('B+8.0')
    // The branch point lies ON the followed line (the walk passes through the
    // same node), so its options are reported identically.
    expect(game.branches[18]).toHaveLength(2)
    // And the id is the same record: two branches of one file share the
    // content-hash id (the engine correlation suffix lives in gameStore).
    expect(game.id).toBe(project(QGO_VAR).id)
  })

  it('[0] is the default continuation and reproduces the mainline', () => {
    expect(project(QGO_VAR, [0]).moves).toHaveLength(33)
  })

  it('extra path elements are never consumed — the line has no more branch points', () => {
    expect(project(QGO_VAR, [0, 0]).moves).toHaveLength(33)
    expect(project('katago-messy.sgf', [0, 0, 1]).moves).toHaveLength(5)
  })

  it('an out-of-range child index is IPC_INVALID_REQUEST with locating context', () => {
    let caught: unknown
    try {
      project(QGO_VAR, [2])
    } catch (error) {
      caught = error
    }
    expect(isAppError(caught) && caught.code).toBe('IPC_INVALID_REQUEST')
    if (isAppError(caught)) {
      expect(caught.context).toEqual({ branchPoint: 0, childIndex: 2, children: 2 })
    }

    // A non-integer index fails the same check and reports null for the value
    // (the IPC schema already rejects fractions; this is the projection's own
    // tripwire for callers that bypass it).
    try {
      project(QGO_VAR, [1.5])
    } catch (error) {
      caught = error
    }
    expect(isAppError(caught) && caught.code).toBe('IPC_INVALID_REQUEST')
    if (isAppError(caught)) {
      expect(caught.context).toEqual({ branchPoint: 0, childIndex: null, children: 2 })
    }
  })

  it('option indices stay child indices even when alternatives are skipped', () => {
    // `gogui-ff4_ex.sgf`'s root has five children; children 1 and 2 are
    // setup-only chains with no move in them, so they are skipped and the
    // offered indices read 0, 3, 4. A display ordinal (0, 1, 2) would break
    // the round-trip: re-parsing with the ordinal would follow the wrong
    // child.
    const game = project('gogui-ff4_ex.sgf')
    expect(game.branches[0]?.map((option) => option.index)).toEqual([0, 3, 4])
    expect(game.branches[0]?.map((option) => option.moves)).toEqual([13, 3, 21])
    // The label rides from the alternative's first-node comment — ff4_ex
    // carries one on every child, so each option here is labelled.
    expect(game.branches[0]?.every((option) => typeof option.label === 'string')).toBe(
      true,
    )
  })

  it('a move-less alternative before a real branch point consumes no path element', () => {
    // Crafted minimal case — no corpus variation file carries this shape
    // (every corpus branch point has ≥ 2 usable children, so the real-file
    // tests above cannot see the misalignment). A node whose extra child is a
    // setup-only chain is NOT a branch point: the renderer stores one path
    // element per branch point it can actually choose at, and `followLine`
    // must consume at exactly those nodes (`branchAlternatives` is the single
    // definition both read). A walker that consumed an element at every
    // multi-child node would spend this choice one node early and the
    // re-parse would follow the setup-only chain — a silent wrong line.
    const collection = parseSgf(
      '(;SZ[9];B[aa](;W[bb](;B[cc];W[dd])(;B[ee];W[ff]))(;AB[gg]C[setup-only]))',
    )
    const projectPath = (variationPath?: readonly number[]): Game =>
      toGame(collection, {
        ...OPTIONS,
        ...(variationPath === undefined ? {} : { variationPath }),
      })

    // Arrival 1 has two children but only ONE usable alternative (the
    // setup-only chain is filtered), so it is not a branch point at all: no
    // picker renders there, no path element belongs to it, and the density
    // fill reports [] like any non-branch node.
    expect(projectPath().branches[1]).toEqual([])
    // Arrival 2 is the real branch point: two 2-move lines.
    const chosen = projectPath([1])
    expect(chosen.moves).toHaveLength(4)
    // B[ee] is (4,4) and W[ff] is (5,5) on a 9×9 — the chosen line, not the
    // setup-only chain and not the default B[cc];W[dd] continuation.
    expect(chosen.moves[2]).toMatchObject({ player: 'black', coord: { x: 4, y: 4 } })
    expect(chosen.moves[3]).toMatchObject({ player: 'white', coord: { x: 5, y: 5 } })
    // The default continuation is unchanged: [0] still follows child 0 at the
    // real branch point, and the setup-only chain stays unaddressable.
    expect(projectPath([0]).moves[2]).toMatchObject({
      player: 'black',
      coord: { x: 2, y: 2 },
    })
  })

  it('an alternative that opens with a pass reports coord null, not a sentinel', () => {
    const game = project('katago-messy.sgf')
    const atTwo = game.branches[2]
    expect(atTwo?.map((option) => option.index)).toEqual([0, 1])
    expect(atTwo?.[0]?.coord).toEqual({ x: 5, y: 5 })
    expect(atTwo?.[1]?.coord).toBeNull()
    expect(atTwo?.[1]?.moves).toBe(6)
  })

  it('branch options on a followed variation line are collected too', () => {
    // katato-messy's child 0 contains its own branch points: following it and
    // then choosing at its second branch point yields a line with a third,
    // three-option branch point nested inside the variation.
    const game = project('katago-messy.sgf', [0, 1])
    expect(game.moves).toHaveLength(8)
    const nonEmpty = game.branches
      .map((entry, index) => [index, entry.length] as const)
      .filter(([, count]) => count > 0)
    expect(nonEmpty).toEqual([
      [0, 2],
      [2, 2],
      [6, 3],
    ])
  })

  it('four options at one branch point stay addressable', () => {
    const game = project('sabaki-sgf-no-ca.sgf')
    expect(game.branches[0]?.map((option) => option.index)).toEqual([0, 1, 2, 3])
    // Each alternative is a genuinely different line, not a re-numbered copy.
    expect(project('sabaki-sgf-no-ca.sgf', [1]).moves).toHaveLength(6)
    expect(project('sabaki-sgf-no-ca.sgf', [2]).moves).toHaveLength(4)
    expect(project('sabaki-sgf-no-ca.sgf', [3]).moves).toHaveLength(6)
    expect(project('sabaki-sgf-no-ca.sgf', [1]).moves[0]?.coord).toEqual({
      x: 11,
      y: 2,
    })
    // A deeper element with no branch point to consume it changes nothing.
    expect(project('sabaki-sgf-no-ca.sgf', [1, 1]).moves).toHaveLength(6)
  })

  it('a mid-record branch point sits at its arrival index, not the end', () => {
    // dublin2 branches at move 69 of 243; its alternative is a single move.
    const game = project('gnugo-dublin2-var-tbtw.sgf')
    expect(
      game.branches.flatMap((entry, index) => (entry.length > 0 ? [index] : [])),
    ).toEqual([69])
    const variation = project('gnugo-dublin2-var-tbtw.sgf', [1])
    expect(variation.moves).toHaveLength(70)
    expect(variation.moves[69]?.coord).toEqual({ x: 18, y: 3 })
  })

  it('a record with several mid-record branch points reports each', () => {
    const game = project('katago-sampletest9x9.sgf')
    const indices = game.branches.flatMap((entry, index) =>
      entry.length > 0 ? [index] : [],
    )
    expect(indices).toEqual([2, 12, 15])
    expect(game.branches[2]?.[1]?.label).toBe('%HINT%')
    expect(game.branches[15]?.[0]?.player).toBe('white')
  })

  it('branches is dense: every entry is an array, never a hole', () => {
    // JSON has no array holes — a sparse JS array would cross IPC as nulls
    // and fail the schema on the other side. The projection fills, and this
    // is the guard that keeps it filling.
    for (const name of [QGO_VAR, 'katago-messy.sgf', 'gogui-ff4_ex.sgf']) {
      const branches = project(name).branches
      for (let index = 0; index < branches.length; index += 1) {
        expect(Array.isArray(branches[index]), `${name} [${String(index)}]`).toBe(true)
      }
    }
    expect(project(QGO_VAR).branches[0]).toEqual([])
  })

  it('a variation line replays cleanly like any other projection', () => {
    // Branch navigation is read-only review: the selected line must satisfy
    // the same whole-record replay property the mainline sweep asserts.
    for (const [name, path] of [
      [QGO_VAR, [1]],
      ['katago-messy.sgf', [0, 1]],
      ['gnugo-dublin2-var-tbtw.sgf', [1]],
      ['sabaki-sgf-no-ca.sgf', [2]],
    ] as const) {
      const game = project(name, [...path])
      const result = replay(game, game.moves.length)
      expect(result.stopped, `${name} ${JSON.stringify(path)}`).toBeUndefined()
      expect(result.applied).toBe(game.moves.length)
    }
  })
})
