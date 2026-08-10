import { create } from 'zustand'
import type { ErrorEnvelope, Game } from '@gomentor/shared'
import { replay, type ReplayResult } from '@gomentor/core/board/position'

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
 */

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
    set({ game: result.data, cursor: result.data.moves.length, loading: false })
  },

  close: () => {
    set({ game: null, cursor: 0, error: null })
  },

  seek: (moveNumber) => {
    set({ cursor: clampCursor(get().game, moveNumber) })
  },

  stepForward: () => {
    const { game, cursor } = get()
    set({ cursor: clampCursor(game, cursor + 1) })
  },

  stepBackward: () => {
    const { game, cursor } = get()
    set({ cursor: clampCursor(game, cursor - 1) })
  },

  toStart: () => {
    set({ cursor: 0 })
  },

  toEnd: () => {
    const { game } = get()
    set({ cursor: game === null ? 0 : game.moves.length })
  },
}))
