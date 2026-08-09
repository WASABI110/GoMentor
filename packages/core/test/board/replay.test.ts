import { describe, expect, it } from 'vitest'
import { isAppError, type BoardSize, type Coord, type Player } from '@gomentor/shared'
import { mainline } from '../../src/sgf/ast'
import { parseSgf } from '../../src/sgf/parser'
import { getBoardSize, getMove, getSetup } from '../../src/sgf/props'
import { Position, replay, type ReplayInput } from '../../src/board/position'
import { readFixture, realFiles } from '../sgf/corpus'

/**
 * `replay` — the position after N moves of a record.
 *
 * ## What this file is really guarding
 *
 * The gap that produced it: `Game` carried no setup stones, so a nine-stone
 * handicap game arrived at the board with nine stones missing. Nothing failed,
 * because nothing replayed a real record end to end. The corpus sweep below is
 * that missing check — it derives its expectations from the SGF files themselves
 * rather than from a fixture someone wrote by hand, so a record whose stones go
 * astray between the AST and `ReplayInput` fails here.
 *
 * ## Why expectations are computed from the AST, not hardcoded
 *
 * A hardcoded 19×19 diagram for move 137 of a real game would be transcribed
 * from this implementation's own output, which makes it a snapshot of current
 * behaviour rather than an independent reference. Instead the sweep replays each
 * record twice by two routes that share no code below `Position`: once through
 * `replay(ReplayInput)`, once by walking the AST directly. They agree only if the
 * `Move[]`/`setup` projection is faithful — which is exactly the property that was
 * broken.
 *
 * The hand-built cases that follow do use explicit diagrams, because there the
 * expectation *is* independent: capture and ko outcomes are dictated by the rules,
 * not by what this code happens to do.
 */

/** Diagram rendering, so a failure shows a board rather than 361 array slots. */
function diagramOf(position: Position): string[] {
  const rows: string[] = []
  for (let y = 0; y < position.size; y += 1) {
    let row = ''
    for (let x = 0; x < position.size; x += 1) {
      const stone = position.at({ x, y })
      row += stone === 'black' ? 'X' : stone === 'white' ? 'O' : '.'
    }
    rows.push(row)
  }
  return rows
}

/**
 * Independent replay: walks the AST node by node instead of consuming the
 * projected `Move[]`.
 *
 * This is the second route the sweep compares against. It deliberately does not
 * call `replay`, and it reads setup and moves straight off the nodes, so it cannot
 * inherit a mistake in the projection. Returns `null` for a record whose mainline
 * hits an illegal move — those are compared on `applied` instead.
 */
function replayViaAst(
  root: ReturnType<typeof parseSgf>['roots'][number],
  size: BoardSize,
): { position: Position; moves: number } | null {
  const setup = getSetup(root, size)
  let position = Position.empty(size).setup([
    ...setup.black.map((coord) => ({ coord, player: 'black' as const })),
    ...setup.white.map((coord) => ({ coord, player: 'white' as const })),
  ])

  let moves = 0
  let started = false

  for (const node of mainline(root)) {
    if (!started && node !== root) {
      // Setup on a pre-first-move node, which `katago-foxlike.sgf` actually has.
      const extra = getSetup(node, size)
      position = position.setup([
        ...extra.black.map((coord) => ({ coord, player: 'black' as const })),
        ...extra.white.map((coord) => ({ coord, player: 'white' as const })),
      ])
    }

    let move
    try {
      move = getMove(node, size)
    } catch {
      // A property this record cannot express as a move. `toMoves` skips it too,
      // so skipping keeps the two routes comparable.
      continue
    }
    if (move === null) continue
    started = true
    moves += 1
    if (move.coord === null) continue

    try {
      position = position.place(move.coord, move.player).position
    } catch {
      return null
    }
  }

  return { position, moves }
}

/** Projects an AST into the `ReplayInput` shape, the way `main/sgf/adapter.ts` does. */
function toReplayInput(
  root: ReturnType<typeof parseSgf>['roots'][number],
  size: BoardSize,
): ReplayInput {
  const black: Coord[] = []
  const white: Coord[] = []
  for (const node of mainline(root)) {
    const setup = getSetup(node, size)
    black.push(...setup.black)
    white.push(...setup.white)
    let move
    try {
      move = getMove(node, size)
    } catch {
      continue
    }
    if (move !== null) break
  }

  const moves: { player: Player; coord: Coord | null }[] = []
  for (const node of mainline(root)) {
    let move
    try {
      move = getMove(node, size)
    } catch {
      continue
    }
    if (move === null) continue
    moves.push({ player: move.player, coord: move.coord })
  }

  return { meta: { boardSize: size }, setup: { black, white }, moves }
}

interface Fixture {
  name: string
  size: BoardSize
  input: ReplayInput
  root: ReturnType<typeof parseSgf>['roots'][number]
}

/** Files whose *setup* cannot be read at all, kept as data rather than skipped. */
const refused: { name: string; code: unknown }[] = []

/**
 * Every real corpus file that parses, declares a supported board size, and whose
 * setup properties are on the board.
 *
 * Built from `realFiles` — the corpus module's own list — rather than from a
 * filename array here, so a fixture added to the corpus is swept automatically
 * rather than needing a second registration nobody remembers.
 *
 * A file that cannot be projected is recorded in `refused` instead of being
 * dropped. Dropping it would shrink the sweep silently, which is the exact
 * failure this suite exists to catch elsewhere.
 */
const FIXTURES: Fixture[] = realFiles.flatMap((name) => {
  let root
  let size: BoardSize
  try {
    const collection = parseSgf(readFixture(name))
    const first = collection.roots[0]
    if (first === undefined) return []
    root = first
    size = getBoardSize(first)
  } catch {
    // Unsupported board size or a file the parser rejects. Both are covered by
    // the SGF suites; neither is replay's subject.
    return []
  }

  try {
    return [{ name, size, input: toReplayInput(root, size), root }]
  } catch (error) {
    refused.push({
      name,
      code: isAppError(error) ? error.code : 'NON_APP_ERROR',
    })
    return []
  }
})

describe('a file whose setup is off the board', () => {
  /**
   * `gogui-size-after-invalid-points.sgf` is `(;AB[pp]AW[cp]SZ[9])` — setup
   * points outside a 9×9 board, from a real editor that wrote `SZ` last.
   *
   * It is refused rather than read with the bad points dropped, and this suite
   * records that because the behaviour *changed*: before `Game` carried setup,
   * nothing read these properties, so the file imported cleanly with its stones
   * silently missing. `props.ts` had already decided the question for moves —
   * dropping an off-board point "produces a plausible-looking wrong board" — and
   * a problem diagram missing a stone is the same wrong board. Refusing costs
   * nothing here: the setup *is* the entire file, so there is no good content to
   * salvage.
   *
   * Nothing user-facing regresses. `library:import` maps a per-file throw to a
   * `failures` row and keeps the rest of the batch, which is what that channel's
   * partial-success contract is for.
   */
  it('is refused with a code that blames the file, not the board module', () => {
    expect(refused.map((r) => r.name)).toEqual(['gogui-size-after-invalid-points.sgf'])
    // `SGF_INVALID_PROPERTY`, not `BOARD_INVALID_COORD`: the coordinate came out
    // of a file, so the file is what is malformed, and the renderer's message for
    // the two differs.
    expect(refused[0]?.code).toBe('SGF_INVALID_PROPERTY')
  })

  it('has a valid twin in the corpus that is not refused', () => {
    // Same bytes with `SZ[19]`. If both were refused, the assertion above would
    // pass for the wrong reason — a projection that threw on all setup.
    const twin = FIXTURES.find((f) => f.name === 'gogui-size-after-valid-points.sgf')
    expect(twin).toBeDefined()
    expect(twin?.input.setup.black).toHaveLength(1)
    expect(twin?.input.setup.white).toHaveLength(1)
  })
})

describe('the corpus sweep is looking at a real corpus', () => {
  // Guards the sweep itself: if `realFiles` or the parser changed such that
  // nothing is collected, every `it` below would vacuously pass. Bounds are stated
  // as minima from a measured count (40 of the 44 files reach here) so adding
  // fixtures does not break the test while emptying it still does.
  it('collected enough fixtures to be worth sweeping', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(35)
  })

  it('covers all three board sizes A3 names', () => {
    const sizes = new Set(FIXTURES.map((f) => f.size))
    expect([...sizes].sort((a, b) => a - b)).toEqual([9, 13, 19])
  })

  it('includes records that carry setup stones, or the setup path is untested', () => {
    const withSetup = FIXTURES.filter(
      (f) => f.input.setup.black.length + f.input.setup.white.length > 0,
    )
    // Measured: 10 corpus files carry `AB`/`AW`. A regression that dropped setup
    // stones during projection would empty this list, and every position
    // assertion below would then agree — on two wrong boards.
    expect(withSetup.length).toBeGreaterThanOrEqual(8)
  })
})

describe('replaying a real record', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: the projected mainline agrees with the AST`, () => {
      const viaAst = replayViaAst(fixture.root, fixture.size)
      const result = replay(fixture.input, fixture.input.moves.length)

      if (viaAst === null) {
        // The record contains an illegal move. Both routes must stop, and
        // `replay` must say so rather than reporting a complete replay.
        expect(result.stopped).toBeDefined()
        return
      }

      expect(result.stopped).toBeUndefined()
      expect(result.applied).toBe(viaAst.moves)
      expect(diagramOf(result.position)).toEqual(diagramOf(viaAst.position))
    })
  }
})

describe('setup stones reach the board', () => {
  /**
   * A nine-stone handicap game. The reference is the SGF file's own `AB`
   * property, read here rather than transcribed, and the assertion is that all
   * nine are on the board *before move 1* — which is precisely what failed
   * silently when `Game` had no `setup` field.
   */
  it('places all nine handicap stones at move 0', () => {
    const name = 'gnugo-9handicap-glgo-latin1.sgf'
    const fixture = FIXTURES.find((f) => f.name === name)
    expect(fixture).toBeDefined()
    if (fixture === undefined) return

    const expected = getSetup(fixture.root, fixture.size).black
    expect(expected).toHaveLength(9)

    const { position } = replay(fixture.input, 0)
    expect(position.stoneCount()).toBe(9)
    for (const coord of expected) {
      expect(position.at(coord)).toBe('black')
    }
  })

  it('places setup stones that sit on a node after the root', () => {
    // `katago-foxlike.sgf` carries `;AB[pd][dp]` on the node *after* the root. A
    // root-only read loses both stones of a two-stone handicap game, and this is
    // the corpus file that proves the mainline walk is load-bearing.
    const fixture = FIXTURES.find((f) => f.name === 'katago-foxlike.sgf')
    expect(fixture).toBeDefined()
    if (fixture === undefined) return

    expect(fixture.input.setup.black).toHaveLength(2)
    const { position } = replay(fixture.input, 0)
    expect(position.stoneCount()).toBe(2)
  })

  it('keeps setup stones out of the move numbering', () => {
    // The reason setup is a separate field rather than leading entries in
    // `moves`: with nine stones folded in, move 1 would be black's ninth
    // placement and every label in the move list would be off by nine.
    const fixture = FIXTURES.find((f) => f.name === 'gnugo-9handicap-glgo-latin1.sgf')
    expect(fixture).toBeDefined()
    if (fixture === undefined) return

    // The file's first *played* move is white's, which is what a handicap game
    // requires and what a setup-as-moves projection would get wrong.
    expect(fixture.input.moves[0]?.player).toBe('white')
    const { position, lastMove } = replay(fixture.input, 1)
    expect(position.stoneCount()).toBe(10)
    expect(lastMove?.player).toBe('white')
  })
})

/** Builds a small record inline, for the rule-outcome cases. */
function record(
  size: BoardSize,
  moves: { player: Player; coord: Coord | null }[],
  setup: { black?: Coord[]; white?: Coord[] } = {},
): ReplayInput {
  return {
    meta: { boardSize: size },
    setup: { black: setup.black ?? [], white: setup.white ?? [] },
    moves,
  }
}

describe('the cursor', () => {
  const game = record(9, [
    { player: 'black', coord: { x: 2, y: 2 } },
    { player: 'white', coord: { x: 6, y: 6 } },
    { player: 'black', coord: { x: 2, y: 6 } },
  ])

  it('at 0 shows the board before any move', () => {
    expect(replay(game, 0).position.stoneCount()).toBe(0)
    expect(replay(game, 0).lastMove).toBeNull()
  })

  it('counts moves, so N leaves N stones on an empty-start record', () => {
    expect(replay(game, 1).position.stoneCount()).toBe(1)
    expect(replay(game, 2).position.stoneCount()).toBe(2)
    expect(replay(game, 3).position.stoneCount()).toBe(3)
  })

  it('marks the stone the cursor is on, not the one after it', () => {
    expect(replay(game, 2).lastMove).toEqual({
      coord: { x: 6, y: 6 },
      player: 'white',
    })
  })

  it('clamps past the end rather than reporting a stop', () => {
    const result = replay(game, 999)
    expect(result.applied).toBe(3)
    expect(result.stopped).toBeUndefined()
  })

  it('clamps a negative cursor to the start', () => {
    expect(replay(game, -5).applied).toBe(0)
    expect(replay(game, -5).position.stoneCount()).toBe(0)
  })

  it('truncates a fractional cursor rather than rounding it', () => {
    // A fractional cursor should never arrive, but "should never" is not a
    // behaviour. Truncation means 1.9 shows move 1 — the move that has actually
    // been played — rather than move 2, which has not.
    expect(replay(game, 1.9).applied).toBe(1)
  })

  it('is a pure function of (record, cursor)', () => {
    // Stepping backwards must give the same board as arriving there forwards.
    // Incremental replay is where this stops being true, and the store steps in
    // both directions.
    const forwards = diagramOf(replay(game, 2).position)
    replay(game, 3)
    expect(diagramOf(replay(game, 2).position)).toEqual(forwards)
  })
})

describe('passes', () => {
  const game = record(9, [
    { player: 'black', coord: { x: 2, y: 2 } },
    { player: 'white', coord: null },
    { player: 'black', coord: { x: 4, y: 4 } },
  ])

  it('places no stone and counts as a move', () => {
    const result = replay(game, 2)
    expect(result.applied).toBe(2)
    expect(result.position.stoneCount()).toBe(1)
  })

  it('clears the last-move marker rather than leaving the previous stone marked', () => {
    // A marker left on black's stone would tell the user black just played, when
    // in fact white passed and it is black's turn.
    expect(replay(game, 2).lastMove).toBeNull()
  })
})

describe('captures', () => {
  /**
   * White plays into black's atari and is captured. The expectation is dictated
   * by the rules, so the diagram is an independent reference rather than a
   * snapshot.
   */
  const game = record(9, [{ player: 'black', coord: { x: 0, y: 1 } }], {
    black: [{ x: 1, y: 0 }],
    white: [{ x: 0, y: 0 }],
  })

  it('removes the captured stone from the board', () => {
    const { position } = replay(game, 1)
    expect(position.at({ x: 0, y: 0 })).toBeNull()
    expect(position.at({ x: 0, y: 1 })).toBe('black')
  })

  it('reports what was captured, for the animation', () => {
    expect(replay(game, 1).captured).toEqual([{ x: 0, y: 0 }])
  })

  it('reports no captures for a quiet move', () => {
    const quiet = record(9, [{ player: 'black', coord: { x: 4, y: 4 } }])
    expect(replay(quiet, 1).captured).toEqual([])
  })

  it('un-captures when the cursor steps back', () => {
    // The property that rules out incremental replay: a capture has no inverse,
    // so stepping back must rebuild rather than undo.
    expect(replay(game, 0).position.at({ x: 0, y: 0 })).toBe('white')
  })
})

describe('an illegal move', () => {
  // Move 2 plays where black already is. A real file can contain this; the
  // corpus has files from clients that disagree about legality.
  const game = record(9, [
    { player: 'black', coord: { x: 4, y: 4 } },
    { player: 'white', coord: { x: 4, y: 4 } },
    { player: 'black', coord: { x: 5, y: 5 } },
  ])

  it('stops rather than throwing, so the record stays openable', () => {
    expect(() => replay(game, 3)).not.toThrow()
  })

  it('names the move that failed, 1-based to match the move list', () => {
    expect(replay(game, 3).stopped).toEqual({ moveNumber: 2, reason: 'occupied' })
  })

  it('returns the last position it can vouch for', () => {
    const result = replay(game, 3)
    expect(result.applied).toBe(1)
    expect(result.position.stoneCount()).toBe(1)
  })

  it('does not silently skip the move and continue', () => {
    // Skipping would leave move 3's stone on the board and no indication that
    // the position diverged from the record. That is the failure mode this
    // assertion exists to rule out.
    expect(replay(game, 3).position.at({ x: 5, y: 5 })).toBeNull()
  })

  it('is not reported when the cursor stops before the bad move', () => {
    expect(replay(game, 1).stopped).toBeUndefined()
  })
})

describe('cost', () => {
  it('replays a full-length record fast enough to do it per cursor step', () => {
    // The design note in `position.ts` claims full replay is cheap enough to run
    // on every cursor move rather than stepping incrementally. That claim is
    // asserted here so it fails if it stops being true, rather than being taken
    // on trust.
    const longest = FIXTURES.reduce((best, f) =>
      f.input.moves.length > best.input.moves.length ? f : best,
    )
    expect(longest.input.moves.length).toBeGreaterThan(100)

    const started = performance.now()
    for (let i = 0; i < 50; i += 1) replay(longest.input, longest.input.moves.length)
    const perReplay = (performance.now() - started) / 50

    // A generous bound: the point is to catch an accidental quadratic, not to
    // pin a number to this machine. A 300-move replay measured well under 5ms.
    expect(perReplay).toBeLessThan(50)
  })
})
