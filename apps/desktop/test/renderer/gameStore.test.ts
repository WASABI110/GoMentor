import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSgf } from '@gomentor/core/sgf/parser'
import type { ErrorEnvelope, Game } from '@gomentor/shared'
import { toGame } from '../../src/main/sgf/adapter'
import {
  positionAt,
  branchStateAt,
  useGameStore,
} from '../../src/renderer/src/state/gameStore'
import { useAnalysisStore } from '../../src/renderer/src/state/analysisStore'

/**
 * `gameStore` — the open record and the cursor into it.
 *
 * ## Fixtures are projected by the shipping adapter, not hand-built
 *
 * A hand-built `Game` literal would let this file pass while `toGame` produced
 * something else entirely — the mistake `sgf-adapter.test.ts` was written to fix,
 * where a corpus sweep built its input with a private copy of the projection and
 * so could not see a bug in the real one. Here the store is fed exactly what
 * `sgf:parse` returns in production: `parseSgf` → `toGame`.
 *
 * That also means the move counts below are *facts about real records* rather than
 * numbers chosen to match the code. `EXPECTED_MOVES` pins them, so a projection
 * that starts dropping moves fails here too.
 *
 * ## What is deliberately not asserted
 *
 * Board contents. `replay` is proven over the whole corpus in
 * `packages/core/test/board/replay.test.ts`, and re-checking stone placement here
 * would be this file reimplementing its neighbour. What is unproven and specific
 * to the store is the *cursor*: its bounds, its default on open, and the fact that
 * the position is derived from it rather than stored beside it.
 */

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

function loadGame(name: string): Game {
  // Read as bytes, not as a utf8 string: several corpus files are latin1 or
  // non-UTF8 CJK, and `parseSgf` detects the encoding from `CA[]` — handing it a
  // pre-decoded string would mojibake exactly those fixtures. This is also how
  // `main/sgf/service.ts` reads a file, so the test path matches production.
  const collection = parseSgf(new Uint8Array(readFileSync(join(FIXTURES, name))))
  return toGame(collection, OPTIONS)
}

/** The handicap fixture, used wherever setup-vs-play matters. */
const HANDICAP = 'gnugo-9handicap-glgo-latin1.sgf'
/** Contains a pass, so `lastMove: null` is reachable at a real cursor. */
const WITH_PASS = 'gnugo-9x9-1-pass.sgf'
/** Contains two variations at move 18, used by the branch navigation tests. */
const VARIATIONS = 'gnugo-9x9-4-qgo-var.sgf'

/**
 * Move counts read off the real corpus, and the reason each file is here.
 *
 * Verified by probe rather than predicted — an earlier suite in this project
 * asserted a guessed set and was wrong by three files. A fixture whose count
 * changes means the projection changed, and that should fail loudly rather than be
 * absorbed by reading the count from the game under test.
 *
 * `as const` rather than `Record<string, number>`: the record form makes every
 * lookup `number | undefined`, which would push the assertions below into either
 * `!` or a needless guard. Keyed by the two consts above, indexing is exact.
 */
const EXPECTED_MOVES = {
  // A 9-stone handicap game: cursor 0 is emphatically not an empty board.
  [HANDICAP]: 400,
  [WITH_PASS]: 53,
  // 18 moves + the 15-move first variation (SGF first-child convention).
  [VARIATIONS]: 33,
} as const

interface BridgeCalls {
  parse: unknown[]
  engine: {
    starts: number
    games: unknown[]
    cursors: unknown[]
  }
}

/**
 * Installs a fake `window.gomentor` and records what the store asked for.
 *
 * Same seam as `settingsStore.test.ts`: `contextBridge` injects a global, so there
 * is no module to `vi.mock`, and stubbing the global keeps a test-only injection
 * point out of the store. The engine group is part of the stub because Stage 3
 * made `open` drive the engine: a stub without it would throw for every open,
 * and the point of the separation below is that engine failures can never block
 * the board — the calls are fire-and-forget.
 */
function stubBridge(handlers: { parse?: (request: unknown) => unknown }): BridgeCalls {
  const calls: BridgeCalls = {
    parse: [],
    engine: { starts: 0, games: [], cursors: [] },
  }
  vi.stubGlobal('window', {
    gomentor: {
      sgf: {
        parse: (request: unknown) => {
          calls.parse.push(request)
          return handlers.parse === undefined
            ? { ok: true, data: loadGame(HANDICAP) }
            : handlers.parse(request)
        },
      },
      engine: {
        start: () => {
          calls.engine.starts += 1
          return Promise.resolve({ ok: true, data: { status: 'ready' } })
        },
        setGame: (request: unknown) => {
          calls.engine.games.push(request)
          return Promise.resolve({ ok: true, data: { focusQueryId: 'focus:1' } })
        },
        setCursor: (request: unknown) => {
          calls.engine.cursors.push(request)
          return Promise.resolve({ ok: true, data: { focusQueryId: 'focus:2' } })
        },
      },
    },
  })
  return calls
}

const REFUSAL: ErrorEnvelope = {
  code: 'SGF_NOT_SGF',
  message: 'not an SGF file',
}

beforeEach(() => {
  // zustand stores are module singletons; without this a cursor left by one test
  // is the starting state of the next, and the suite passes or fails by file order.
  useGameStore.setState({ game: null, cursor: 0, error: null, loading: false })
  // gameStore drives the engine and writes the analysis expectation, so both
  // stores reset together — a leaked expectation would accept a stale result.
  useAnalysisStore.setState({
    status: { status: 'unavailable' },
    focus: null,
    focusGameId: null,
    focusMoveNumber: null,
    sweep: {},
    sweepGameId: null,
    showOwnership: false,
    hoveredCandidate: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the corpus this suite leans on is really there', () => {
  // Guards the fixtures themselves. Every cursor assertion below is stated in
  // terms of these counts, so if a fixture were replaced or a path went stale,
  // the rest of the file could pass vacuously against a 0-move game.
  for (const [name, expected] of Object.entries(EXPECTED_MOVES)) {
    it(`${name} projects to ${String(expected)} moves`, () => {
      expect(loadGame(name).moves).toHaveLength(expected)
    })
  }

  it('the handicap fixture has setup stones, so cursor 0 is not an empty board', () => {
    const game = loadGame(HANDICAP)
    expect(game.setup.black.length + game.setup.white.length).toBeGreaterThan(0)
  })

  it('the pass fixture really contains a pass', () => {
    const game = loadGame('gnugo-9x9-1-pass.sgf')
    expect(game.moves.some((move) => move.coord === null)).toBe(true)
  })
})

describe('open', () => {
  it('sends the content and stores the projected record', async () => {
    const calls = stubBridge({})
    await useGameStore.getState().open('(;GM[1])')

    expect(calls.parse).toEqual([{ content: '(;GM[1])' }])
    expect(useGameStore.getState().game?.moves).toHaveLength(EXPECTED_MOVES[HANDICAP])
    expect(useGameStore.getState().loading).toBe(false)
    expect(useGameStore.getState().error).toBeNull()
  })

  it('opens at the end of the record, not at move 0', async () => {
    stubBridge({})
    await useGameStore.getState().open('(;GM[1])')

    // A review starts from the final position. Asserted against the fixture's own
    // count so this cannot pass by both sides being 0.
    expect(useGameStore.getState().cursor).toBe(EXPECTED_MOVES[HANDICAP])
    expect(useGameStore.getState().cursor).toBeGreaterThan(0)
  })

  it('records a refusal as state and does not throw', async () => {
    stubBridge({ parse: () => ({ ok: false, error: REFUSAL }) })

    // No `rejects` — a bridge call resolves to the union. If this ever throws,
    // the store has started unwrapping envelopes, which `contextBridge` would
    // strip down to `message` alone.
    await expect(useGameStore.getState().open('garbage')).resolves.toBeUndefined()

    expect(useGameStore.getState().error).toEqual(REFUSAL)
    expect(useGameStore.getState().game).toBeNull()
    expect(useGameStore.getState().loading).toBe(false)
  })

  it('keeps the open record when a later open fails', async () => {
    stubBridge({})
    await useGameStore.getState().open('(;GM[1])')
    const opened = useGameStore.getState().game

    vi.unstubAllGlobals()
    stubBridge({ parse: () => ({ ok: false, error: REFUSAL }) })
    await useGameStore.getState().open('garbage')

    // Closing the user's game because their *next* file was bad is a data-loss
    // shaped bug: they lose their place in a record that parsed fine.
    expect(useGameStore.getState().game).toBe(opened)
    expect(useGameStore.getState().cursor).toBe(EXPECTED_MOVES[HANDICAP])
    expect(useGameStore.getState().error).toEqual(REFUSAL)
  })

  it('clears a previous error on a successful open', async () => {
    stubBridge({ parse: () => ({ ok: false, error: REFUSAL }) })
    await useGameStore.getState().open('garbage')
    expect(useGameStore.getState().error).not.toBeNull()

    vi.unstubAllGlobals()
    stubBridge({})
    await useGameStore.getState().open('(;GM[1])')

    // A stale envelope would keep an error banner on screen above a record that
    // opened correctly.
    expect(useGameStore.getState().error).toBeNull()
  })

  it('is loading while the parse is in flight', async () => {
    let release: ((value: unknown) => void) | undefined
    stubBridge({
      parse: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })

    const pending = useGameStore.getState().open('(;GM[1])')
    expect(useGameStore.getState().loading).toBe(true)

    if (release === undefined) throw new Error('bridge was not called')
    release({ ok: true, data: loadGame(HANDICAP) })
    await pending
    expect(useGameStore.getState().loading).toBe(false)
  })
})

describe('the cursor stays inside the record', () => {
  beforeEach(async () => {
    stubBridge({})
    await useGameStore.getState().open('(;GM[1])')
  })

  const total = EXPECTED_MOVES[HANDICAP]

  it('clamps a seek past the end to the last move', () => {
    useGameStore.getState().seek(9999)
    expect(useGameStore.getState().cursor).toBe(total)
  })

  it('clamps a negative seek to 0', () => {
    useGameStore.getState().seek(-5)
    expect(useGameStore.getState().cursor).toBe(0)
  })

  it('truncates a fractional cursor', () => {
    // A fractional cursor would otherwise index between two moves. Chosen inside
    // the record so this tests truncation rather than clamping.
    useGameStore.getState().seek(10.7)
    expect(useGameStore.getState().cursor).toBe(10)
  })

  it('does not step past the end', () => {
    useGameStore.getState().toEnd()
    useGameStore.getState().stepForward()
    expect(useGameStore.getState().cursor).toBe(total)
  })

  it('does not step before the start', () => {
    useGameStore.getState().toStart()
    useGameStore.getState().stepBackward()
    expect(useGameStore.getState().cursor).toBe(0)
  })

  it('steps forward and backward to the same place', () => {
    useGameStore.getState().seek(40)
    useGameStore.getState().stepForward()
    expect(useGameStore.getState().cursor).toBe(41)
    useGameStore.getState().stepBackward()
    expect(useGameStore.getState().cursor).toBe(40)
  })

  it('toStart and toEnd reach both bounds', () => {
    useGameStore.getState().toStart()
    expect(useGameStore.getState().cursor).toBe(0)
    useGameStore.getState().toEnd()
    expect(useGameStore.getState().cursor).toBe(total)
  })
})

describe('the cursor is safe with no record open', () => {
  // Every one of these would be a crash if an action reached into `game.moves`
  // without checking. The store starts empty on launch, and the menu's
  // accelerators are live before any file is opened.
  it('seek does nothing', () => {
    useGameStore.getState().seek(50)
    expect(useGameStore.getState().cursor).toBe(0)
  })

  it('stepForward does nothing', () => {
    useGameStore.getState().stepForward()
    expect(useGameStore.getState().cursor).toBe(0)
  })

  it('toEnd does nothing', () => {
    useGameStore.getState().toEnd()
    expect(useGameStore.getState().cursor).toBe(0)
  })
})

describe('close', () => {
  it('drops the record, the cursor, and any error', async () => {
    stubBridge({})
    await useGameStore.getState().open('(;GM[1])')
    useGameStore.getState().close()

    expect(useGameStore.getState().game).toBeNull()
    expect(useGameStore.getState().cursor).toBe(0)
    expect(useGameStore.getState().error).toBeNull()
  })
})

describe('drives the engine imperatively', () => {
  it('open starts the engine and sends the mapped record at the cursor', async () => {
    const calls = stubBridge({})
    await useGameStore.getState().open('(;GM[1])')

    const game = loadGame(HANDICAP)
    // The payload is the self-contained engine record (design.md §IPC additions):
    // id, meta, setup, and moves stripped of their UI fields — nothing the
    // engine service would have to reach back into the renderer for.
    expect(calls.engine.starts).toBe(1)
    expect(calls.engine.games).toEqual([
      {
        game: {
          gameId: game.id,
          boardSize: game.meta.boardSize,
          komi: game.meta.komi,
          rules: game.meta.ruleset ?? '',
          setup: game.setup,
          moves: game.moves.map((move) => ({ player: move.player, coord: move.coord })),
        },
        atMove: EXPECTED_MOVES[HANDICAP],
      },
    ])
  })

  it('open sets the analysis expectation so results for this game can land', async () => {
    stubBridge({})
    await useGameStore.getState().open('(;GM[1])')

    const game = loadGame(HANDICAP)
    expect(useAnalysisStore.getState().focusGameId).toBe(game.id)
    expect(useAnalysisStore.getState().focusMoveNumber).toBe(EXPECTED_MOVES[HANDICAP])
  })

  it('a refused open drives nothing — the previous analysis stands', async () => {
    const calls = stubBridge({ parse: () => ({ ok: false, error: REFUSAL }) })
    await useGameStore.getState().open('garbage')

    expect(calls.engine.starts).toBe(0)
    expect(calls.engine.games).toEqual([])
    expect(useAnalysisStore.getState().focusGameId).toBeNull()
  })

  it('seek drives setCursor only when the cursor actually changed', async () => {
    const calls = stubBridge({})
    await useGameStore.getState().open('(;GM[1])')
    calls.engine.cursors.length = 0

    useGameStore.getState().seek(30)
    expect(calls.engine.cursors).toEqual([{ moveNumber: 30 }])
    expect(useAnalysisStore.getState().focusMoveNumber).toBe(30)

    // Same cursor again: no engine query — holding an arrow key at the clamp
    // must not become a stream of identical queries.
    useGameStore.getState().seek(30)
    expect(calls.engine.cursors).toEqual([{ moveNumber: 30 }])
  })

  it('stepping at the record boundary is a no-op and sends nothing', async () => {
    const calls = stubBridge({})
    await useGameStore.getState().open('(;GM[1])')
    calls.engine.cursors.length = 0

    useGameStore.getState().toEnd()
    expect(calls.engine.cursors).toEqual([])
    useGameStore.getState().stepForward()
    expect(calls.engine.cursors).toEqual([])
  })

  it('close clears the held record with the engine and the expectation', async () => {
    const calls = stubBridge({})
    await useGameStore.getState().open('(;GM[1])')
    useGameStore.getState().close()

    expect(calls.engine.games).toContainEqual({ game: null, atMove: 0 })
    expect(useAnalysisStore.getState().focusGameId).toBeNull()
    expect(useAnalysisStore.getState().focusMoveNumber).toBeNull()
  })

  it('engine actions with no record open send nothing', () => {
    const calls = stubBridge({})
    useGameStore.getState().seek(10)
    useGameStore.getState().stepForward()
    useGameStore.getState().toEnd()
    expect(calls.engine.starts).toBe(0)
    expect(calls.engine.games).toEqual([])
    expect(calls.engine.cursors).toEqual([])
  })
})

describe('the position is derived, never stored', () => {
  it('is null with no record open', () => {
    expect(positionAt(useGameStore.getState())).toBeNull()
  })

  it('places setup stones at cursor 0', () => {
    const game = loadGame(HANDICAP)
    const setupCount = game.setup.black.length + game.setup.white.length

    const result = positionAt({ game, cursor: 0 })
    if (result === null) throw new Error('expected a position')

    // The handicap bug this whole setup field exists for: nine placed stones
    // reaching the board as an empty grid. `applied` is 0 because no move was
    // played, yet the board is not empty.
    expect(result.applied).toBe(0)
    expect(result.position.stoneCount()).toBe(setupCount)
    expect(result.lastMove).toBeNull()
  })

  it('changes when only the cursor changes', () => {
    const game = loadGame(HANDICAP)
    const early = positionAt({ game, cursor: 10 })
    const later = positionAt({ game, cursor: 60 })
    if (early === null || later === null) throw new Error('expected positions')

    // If the position were cached in the store rather than derived, this is the
    // assertion that would fail — same game object, two cursors, two boards.
    expect(early.applied).toBe(10)
    expect(later.applied).toBe(60)
    expect(early.position.stoneCount()).not.toBe(later.position.stoneCount())
  })

  it('reports lastMove null at a pass', () => {
    const game = loadGame('gnugo-9x9-1-pass.sgf')
    const passIndex = game.moves.findIndex((move) => move.coord === null)
    expect(passIndex).toBeGreaterThanOrEqual(0)

    // Cursor is a 1-based count, so the pass is applied at `passIndex + 1`.
    const result = positionAt({ game, cursor: passIndex + 1 })
    if (result === null) throw new Error('expected a position')

    // The marker must draw nothing here. A `lastMove` of `{0,0}` would put a
    // marker on the corner after every pass.
    expect(result.lastMove).toBeNull()
  })

  it('reads the same cursor the store holds', async () => {
    stubBridge({})
    await useGameStore.getState().open('(;GM[1])')
    useGameStore.getState().seek(25)

    const result = positionAt(useGameStore.getState())
    if (result === null) throw new Error('expected a position')

    // Ties the derivation to the stored cursor rather than to a literal, so a
    // store that silently kept its own separate cursor would fail.
    expect(result.applied).toBe(useGameStore.getState().cursor)
    expect(result.applied).toBe(25)
  })
})

describe('branch navigation (Stage 4)', () => {
  /**
   * Read-only variation switching through the ONE path a `Game` comes into
   * existence (`gameStore.open` → `sgf:parse`): `chooseBranch` re-parses the
   * retained source with an updated `variationPath` and re-drives the engine
   * exactly like an open. The variation fixture's real structure (probed, not
   * guessed): 18 moves, then a branch point whose children are a 15-move line
   * (child 0 — also the mainline continuation) and an 11-move line (child 1).
   *
   * `game.id` is `'test-id'` for every projection here (the OPTIONS contentHash),
   * which is what makes the engine-id suffix assertions readable.
   */
  /**
   * A bridge whose parse honours the request's `variationPath` through the
   * real adapter — the production shape of a branch re-parse. The content is
   * ignored (the store re-parses the source it was opened with, a placeholder
   * here); the fixture collection is the parse result either way.
   */
  function stubVariations(): BridgeCalls {
    return stubBridge({
      parse: (request: unknown) => {
        const { variationPath } = request as { variationPath?: number[] }
        const collection = parseSgf(
          new Uint8Array(readFileSync(join(FIXTURES, VARIATIONS))),
        )
        return {
          ok: true,
          data: toGame(collection, {
            ...OPTIONS,
            ...(variationPath === undefined ? {} : { variationPath }),
          }),
        }
      },
    })
  }

  beforeEach(async () => {
    stubVariations()
    await useGameStore.getState().open('(;GM[1])')
  })

  afterEach(() => {
    useGameStore.getState().close()
  })

  it('open on the mainline sends no variationPath and names the bare id', async () => {
    const calls = stubVariations()
    await useGameStore.getState().open('(;GM[1])')

    // No variationPath key at all — the mainline is the absence of one, and
    // the engine correlation id is the bare content hash.
    expect(calls.parse).toEqual([{ content: '(;GM[1])' }])
    const engineGame = calls.engine.games.at(-1) as { game: { gameId: string } }
    expect(engineGame.game.gameId).toBe('test-id')
    expect(useAnalysisStore.getState().sweepGameId).toBe('test-id')
    expect(useGameStore.getState().game?.moves).toHaveLength(EXPECTED_MOVES[VARIATIONS])
  })

  it('branchStateAt reports the options and the followed index at a branch point', () => {
    const game = useGameStore.getState().game
    if (game === null) throw new Error('expected a game')

    // Cursor 33 (end): the branch point is at arrival 18, not here.
    expect(branchStateAt(game, 33)).toBeNull()
    const atBranch = branchStateAt(game, 18)
    expect(atBranch?.options).toHaveLength(2)
    expect(atBranch?.activeIndex).toBe(0)
    // A position with no alternatives reports null, not an empty picker.
    expect(branchStateAt(game, 17)).toBeNull()
  })

  it('chooseBranch re-parses with the updated variationPath and re-drives the engine', async () => {
    const calls = stubVariations()
    await useGameStore.getState().open('(;GM[1])')

    useGameStore.getState().seek(18)
    await useGameStore.getState().chooseBranch(18, 1)

    // The re-parse went through sgf:parse with exactly the child index the
    // picker offered — the round-trip the BranchOption.index doc promises.
    expect(calls.parse).toEqual([
      { content: '(;GM[1])' },
      { content: '(;GM[1])', variationPath: [1] },
    ])

    const game = useGameStore.getState().game
    expect(game?.moves).toHaveLength(29)
    expect(useGameStore.getState().cursor).toBe(29)

    // The engine is re-set with the branch-suffixed correlation id, and the
    // analysis stores retarget to the same suffix — a late tick from the
    // mainline id must miss both filters.
    const engineGame = calls.engine.games.at(-1) as { game: { gameId: string } }
    expect(engineGame.game.gameId).toBe('test-id~v1')
    expect(useAnalysisStore.getState().focusGameId).toBe('test-id~v1')
    expect(useAnalysisStore.getState().sweepGameId).toBe('test-id~v1')
    // The library-facing id stays the bare content hash.
    expect(game?.id).toBe('test-id')
  })

  it('after switching, the picker reports the new line as the active one', async () => {
    await useGameStore.getState().chooseBranch(18, 1)
    const game = useGameStore.getState().game
    if (game === null) throw new Error('expected a game')

    // The branch point is on the followed line, and the path says child 1.
    expect(branchStateAt(game, 18)?.activeIndex).toBe(1)
    // Choosing the default child back returns the 33-move mainline — and the
    // engine id records the explicit choice as ~v0 (a non-empty path is a
    // variation line even when it picks child 0).
    await useGameStore.getState().chooseBranch(18, 0)
    expect(useGameStore.getState().game?.moves).toHaveLength(33)
  })

  it('chooseBranch at a position that is not a branch point does nothing', async () => {
    const calls = stubVariations()
    await useGameStore.getState().open('(;GM[1])')
    const before = useGameStore.getState().game

    useGameStore.getState().seek(17)
    await useGameStore.getState().chooseBranch(17, 1)

    expect(calls.parse).toEqual([{ content: '(;GM[1])' }])
    expect(useGameStore.getState().game).toBe(before)
  })

  it('chooseBranch with an index the picker never offered does nothing', async () => {
    const calls = stubVariations()
    await useGameStore.getState().open('(;GM[1])')

    await useGameStore.getState().chooseBranch(18, 99)

    expect(calls.parse).toEqual([{ content: '(;GM[1])' }])
    expect(useGameStore.getState().game?.moves).toHaveLength(33)
  })

  it('a refused re-parse keeps the current record and surfaces the error', async () => {
    const calls = stubVariations()
    await useGameStore.getState().open('(;GM[1])')
    vi.unstubAllGlobals()
    // The re-parse refuses: a corrupt variation must not close the record the
    // user was reviewing.
    stubBridge({
      parse: (request: unknown) =>
        (request as { variationPath?: number[] }).variationPath === undefined
          ? { ok: true, data: loadGame(VARIATIONS) }
          : { ok: false, error: REFUSAL },
    })
    // Re-open against the new bridge, then attempt the switch.
    await useGameStore.getState().open('(;GM[1])')
    await useGameStore.getState().chooseBranch(18, 1)

    expect(useGameStore.getState().error).toEqual(REFUSAL)
    expect(useGameStore.getState().game?.moves).toHaveLength(33)
    expect(calls.parse).toEqual([{ content: '(;GM[1])' }])
  })

  it('close clears the branch state: a later open is the mainline again', async () => {
    const calls = stubVariations()
    await useGameStore.getState().open('(;GM[1])')
    await useGameStore.getState().chooseBranch(18, 1)
    expect(useGameStore.getState().game?.moves).toHaveLength(29)

    useGameStore.getState().close()
    expect(useAnalysisStore.getState().sweepGameId).toBeNull()

    await useGameStore.getState().open('(;GM[1])')
    expect(calls.parse.at(-1)).toEqual({ content: '(;GM[1])' })
    expect(useGameStore.getState().game?.moves).toHaveLength(33)

    const engineGame = calls.engine.games.at(-1) as { game: { gameId: string } }
    expect(engineGame.game.gameId).toBe('test-id')
  })

  it('close after a branch switch does not leak the suffix into the next open', async () => {
    stubVariations()
    await useGameStore.getState().open('(;GM[1])')
    await useGameStore.getState().chooseBranch(18, 1)
    useGameStore.getState().close()

    // The sweep filter is cleared with the record: a fresh sweep for the new
    // open names the bare id, and no stale ~v-suffixed tick can land.
    await useGameStore.getState().open('(;GM[1])')
    expect(useAnalysisStore.getState().sweepGameId).toBe('test-id')
    expect(useAnalysisStore.getState().sweep).toEqual({})
  })
})
