import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSgf } from '@gomentor/core/sgf/parser'
import type { ErrorEnvelope, Game } from '@gomentor/shared'
import { toGame } from '../../src/main/sgf/adapter'
import { positionAt, useGameStore } from '../../src/renderer/src/state/gameStore'

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
} as const

interface BridgeCalls {
  parse: unknown[]
}

/**
 * Installs a fake `window.gomentor` and records what the store asked for.
 *
 * Same seam as `settingsStore.test.ts`: `contextBridge` injects a global, so there
 * is no module to `vi.mock`, and stubbing the global keeps a test-only injection
 * point out of the store.
 */
function stubBridge(handlers: { parse?: (request: unknown) => unknown }): BridgeCalls {
  const calls: BridgeCalls = { parse: [] }
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
