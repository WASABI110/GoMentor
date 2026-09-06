import { create } from 'zustand'
import type { EngineGame, ErrorEnvelope, Game } from '@gomentor/shared'
import { replay, type ReplayResult } from '@gomentor/core/board/position'
import { useAnalysisStore } from './analysisStore'

/**
 * The record on the board, and where the cursor sits in it.
 *
 * ## What is stored, and what is not
 *
 * `state-management.md` §Derived state: stores hold inputs, `packages/core`
 * computes outputs. The inputs here are exactly `(game, cursor)`. The board
 * position is **not** stored — `replay` derives it, and a stored copy is a second
 * thing that can disagree with the record it came from.
 *
 * The cost of deriving rather than caching was measured before this was accepted,
 * not assumed: `packages/core/test/board/replay.test.ts` bounds a 300-move replay
 * well under 5ms and fails if that stops holding. `position.ts` also records why
 * an incremental fast-path was rejected — stepping *backwards* cannot reuse the
 * previous position, because captures have no inverse, so one code path means
 * forward and backward cannot drift apart.
 *
 * ## `positionAt` is a plain function, not a hook and not a selector
 *
 * A zustand selector must be cheap and pure of side effects because it runs on
 * every store change. Replay is pure but not free, so it belongs where the caller
 * controls when it runs: the canvas renderer calls it inside
 * `requestAnimationFrame` via `getState()`, which is one of the two reasons
 * `state-management.md` gives for choosing zustand at all. Exported as a
 * standalone function so a test can drive it without React.
 *
 * ## Branch navigation keeps one way a `Game` comes into existence
 *
 * Read-only branch navigation (Stage 4, `design.md` §Branch navigation)
 * extends the parse path instead of adding a second one: `chooseBranch`
 * re-parses the retained source SGF through `sgf:parse` with an updated
 * `variationPath` — the M1 invariant "exactly one way a `Game` comes into
 * existence" (`gameStore.open` → `sgf:parse`) holds for variations too.
 *
 * ## Branch identity for the engine (a Stage 4 decision, recorded)
 *
 * `game.id` is the content hash, so two branches of the same file share it —
 * and the engine correlates results by `gameId`. Letting both branches ride
 * the bare id would let a late focus tick from branch A paint over branch B
 * at the same cursor (the analysis expectation is `(gameId, moveNumber)`).
 * The engine-game id therefore carries a branch suffix: the bare content hash
 * on the mainline, `<hash>~v<dot-separated child indices>` on a variation.
 * The suffix is part of the engine payload only — `game.id` stays the bare
 * hash so the library, dedupe, and `sgf:serialize` are untouched (the AST
 * main stores under the hash is the whole file regardless of branch). The
 * analysis stores' expectation/sweep filters use the suffixed id, which is
 * what makes a since-superseded branch's late ticks miss them.
 *
 * ## This store drives the engine; it never waits for it
 *
 * `design.md` §Renderer: gameStore is the one place that knows when the studied
 * record or cursor changes, so it issues the engine calls imperatively — open →
 * `start` + `setGame`, seek/step → `setCursor`, close → `setGame(null)`. Every
 * call is fire-and-forget: the service holds the latest request and issues it
 * when the engine becomes ready, so a slow or absent engine never blocks the
 * board, and none of these calls can reject (absence is a status, not an
 * exception). The cursor drives `setCursor` only when it actually changed —
 * stepping past the end is a no-op and must not become an engine query.
 *
 * The same moment sets `analysisStore`'s expectation (gameId + cursor) and
 * names its sweep target. That filter is why a late result from a
 * since-closed record can never paint over the board: expectation is cleared
 * before the record is, never after.
 */

/**
 * The source SGF of the open record, retained for branch re-parses.
 *
 * Module-private rather than store state: it is not render input (no
 * component may read it — everything renders the projection), it must survive
 * exactly as long as the open record, and keeping it out of the store avoids
 * a second, shadow copy inside every `useGameStore.getState()` consumer. The
 * M1 invariant stays intact: this string only ever flows back through
 * `sgf:parse`.
 */
let sourceSgf: string | null = null

/** The child index chosen at each branch point of the open record's line. */
let variationPath: number[] = []

/**
 * The branch picker state for a cursor position: the options at that branch
 * point and the SGF child index the current line follows there. Derived from
 * `(game.branches, variationPath, cursor)` — inputs already owned here, so
 * this stays a pure read rather than new store state. Exported (and named) so
 * the MoveTree's prop type resolves to this definition rather than a
 * structural copy that could drift from it.
 */
export interface MoveTreeBranchState {
  readonly options: Game['branches'][number]
  readonly activeIndex: number
}

export function branchStateAt(game: Game, cursor: number): MoveTreeBranchState | null {
  const options = game.branches[cursor]
  if (options === undefined || options.length < 2) return null
  let ordinal = 0
  for (let index = 0; index <= cursor; index += 1) {
    const entry = game.branches[index]
    if (entry !== undefined && entry.length >= 2) ordinal += 1
  }
  return { options, activeIndex: variationPath[ordinal - 1] ?? 0 }
}

interface GameState {
  /** `null` when no record is open. Not a blank game — see below. */
  game: Game | null
  /**
   * Move count, matching `Move.number`: 0 is the position before move 1, which
   * is not necessarily an empty board because setup stones are position, not play.
   */
  cursor: number
  /** Last failure from `open`, translated by `code` in the UI. */
  error: ErrorEnvelope | null
  /** True while `sgf:parse` is in flight. */
  loading: boolean

  open: (content: string) => Promise<void>
  close: () => void
  /** Clamped to `[0, moves.length]`; an out-of-range cursor is corrected, not rejected. */
  seek: (moveNumber: number) => void
  stepForward: () => void
  stepBackward: () => void
  toStart: () => void
  toEnd: () => void
  /**
   * Read-only branch navigation: re-parse the retained source following the
   * `childIndex` alternative at the branch point the cursor sits on
   * (`atIndex` is that branch point's arrival index). No-op with no record
   * open or when the position is not a branch point.
   */
  chooseBranch: (atIndex: number, childIndex: number) => Promise<void>
}

/**
 * The position at a cursor, or `null` when no record is open.
 *
 * Returns the whole `ReplayResult` rather than only `position`, because the three
 * other fields are all things the board must draw and none of them can be
 * recovered from the position alone: `lastMove` (the move marker — `null` after a
 * pass, which must mean *draw nothing* rather than the origin), `captured` (the
 * capture animation), and `stopped` (a record whose move N is illegal is still a
 * record with N-1 good moves, and the UI has to say so rather than silently show
 * a truncated game).
 */
export function positionAt(state: {
  game: Game | null
  cursor: number
}): ReplayResult | null {
  if (state.game === null) return null
  return replay(state.game, state.cursor)
}

/**
 * Clamps a cursor against a record.
 *
 * Shared by `seek` and the step actions so there is one definition of the bound.
 * `Math.trunc` because a fractional cursor would otherwise index between moves;
 * `replay` clamps identically, and the duplication is deliberate — the store must
 * not hold a cursor it would render differently from the one it stores.
 */
function clampCursor(game: Game | null, moveNumber: number): number {
  if (game === null) return 0
  return Math.max(0, Math.min(Math.trunc(moveNumber), game.moves.length))
}

/**
 * The self-contained engine payload for a record (`design.md` §IPC additions).
 * The engine service must not import the library store, so the renderer resends
 * the record (~2KB for 300 moves — noise) rather than referencing an id main
 * could not resolve. `rules` is the raw SGF RU string; mapping it onto a KataGo
 * ruleset is the session's job, and an absent RU rides as '' and falls back to
 * `chinese` there — recorded, not silently defaulted.
 *
 * `gameId` is passed in rather than read from `game.id` because engine
 * correlation uses the branch-suffixed id (`engineGameId`) while `game.id`
 * stays the bare content hash — see the module header.
 */
function toEngineGame(game: Game, gameId: string): EngineGame {
  return {
    gameId,
    boardSize: game.meta.boardSize,
    komi: game.meta.komi,
    rules: game.meta.ruleset ?? '',
    setup: game.setup,
    moves: game.moves.map((move) => ({ player: move.player, coord: move.coord })),
  }
}

/**
 * The engine-correlation id for the open line: the bare content hash on the
 * mainline, `~v`-suffixed on a variation (see the module header, "Branch
 * identity for the engine"). `game.id` itself is never suffixed — the
 * library and `sgf:serialize` key on the bare hash.
 */
function engineGameId(game: Game): string {
  return variationPath.length === 0 ? game.id : `${game.id}~v${variationPath.join('.')}`
}

/**
 * Opened a record: start the engine (idempotent — a running engine answers
 * immediately) and hand it the record at the cursor. `start` first so the
 * service's hold-and-issue sees the full intent either way; both orders work
 * because the service serializes its own state, but this reads in causal order.
 */
function driveEngineOpen(game: Game, cursor: number): void {
  const id = engineGameId(game)
  useAnalysisStore.getState().setExpectation(id, cursor)
  useAnalysisStore.getState().beginSweep(id)
  void window.gomentor.engine.start({})
  void window.gomentor.engine.setGame({ game: toEngineGame(game, id), atMove: cursor })
}

/** The cursor moved: re-point the analysis. Debounce/supersede live in main. */
function driveEngineCursor(game: Game, cursor: number): void {
  useAnalysisStore.getState().setExpectation(engineGameId(game), cursor)
  void window.gomentor.engine.setCursor({ moveNumber: cursor })
}

export const useGameStore = create<GameState>((set, get) => ({
  game: null,
  cursor: 0,
  error: null,
  loading: false,

  open: async (content) => {
    set({ loading: true, error: null })
    const result = await window.gomentor.sgf.parse({ content })
    if (!result.ok) {
      // No throw: a bridge call resolves to the union, and an unparseable file is
      // a state the UI renders — the user picked a bad file, which is not an
      // exception. `directory-structure.md` §Forbidden patterns.
      //
      // The previously open record stays open. Replacing it with `null` would
      // punish the user for a failed *second* import by closing the game they
      // were already studying.
      set({ loading: false, error: result.error })
      return
    }

    // Cursor to the end, not to 0. Opening a record to an empty board and making
    // the user seek 200 moves to see the game is the wrong default for a study
    // tool; the final position is what a review starts from.
    sourceSgf = content
    variationPath = []
    set({ game: result.data, cursor: result.data.moves.length, loading: false })
    driveEngineOpen(result.data, result.data.moves.length)
  },

  close: () => {
    // Expectation clears before the record drops: a result already in flight
    // for this game must find no expectation to match, not a stale one.
    useAnalysisStore.getState().setExpectation(null, null)
    useAnalysisStore.getState().beginSweep(null)
    void window.gomentor.engine.setGame({ game: null, atMove: 0 })
    sourceSgf = null
    variationPath = []
    set({ game: null, cursor: 0, error: null })
  },

  chooseBranch: async (atIndex, childIndex) => {
    const { game } = get()
    if (game === null || sourceSgf === null) return
    const options = game.branches[atIndex]
    if (options === undefined || options.length < 2) return
    if (!options.some((option) => option.index === childIndex)) return

    // The ordinal of this branch point among the line's branch points — one
    // path element each, in walk order (`followLine`). Elements deeper than
    // the switch were chosen on the old line and do not apply to the new one,
    // so the replacement truncates them.
    let ordinal = 0
    for (let index = 0; index <= atIndex; index += 1) {
      const entry = game.branches[index]
      if (entry !== undefined && entry.length >= 2) ordinal += 1
    }
    const nextPath = [...variationPath.slice(0, ordinal - 1), childIndex]

    const result = await window.gomentor.sgf.parse({
      content: sourceSgf,
      variationPath: nextPath,
    })
    if (!result.ok) {
      set({ error: result.error })
      return
    }

    // Same open semantics as `open`: land on the new line's final position,
    // re-point everything. `game.id` is unchanged (the content hash) — the
    // engine correlation id is suffixed via `variationPath`, so a late tick
    // from the old branch misses the analysis stores' filters.
    variationPath = nextPath
    set({ game: result.data, cursor: result.data.moves.length, error: null })
    driveEngineOpen(result.data, result.data.moves.length)
  },

  seek: (moveNumber) => {
    const { game, cursor } = get()
    const next = clampCursor(game, moveNumber)
    if (next === cursor) return
    set({ cursor: next })
    if (game !== null) driveEngineCursor(game, next)
  },

  stepForward: () => {
    const { game, cursor } = get()
    const next = clampCursor(game, cursor + 1)
    if (next === cursor) return
    set({ cursor: next })
    if (game !== null) driveEngineCursor(game, next)
  },

  stepBackward: () => {
    const { game, cursor } = get()
    const next = clampCursor(game, cursor - 1)
    if (next === cursor) return
    set({ cursor: next })
    if (game !== null) driveEngineCursor(game, next)
  },

  toStart: () => {
    const { game, cursor } = get()
    if (cursor === 0) return
    set({ cursor: 0 })
    if (game !== null) driveEngineCursor(game, 0)
  },

  toEnd: () => {
    const { game, cursor } = get()
    const next = game === null ? 0 : game.moves.length
    if (next === cursor) return
    set({ cursor: next })
    if (game !== null) driveEngineCursor(game, next)
  },
}))
