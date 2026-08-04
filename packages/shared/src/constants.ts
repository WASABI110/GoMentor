/** Values shared across processes. Anything with a schema belongs in types/. */

export const APP_ID = 'app.gomentor.desktop'
export const APP_NAME = 'GoMentor'

/** The bridge object exposed by preload. The renderer's only route to main. */
export const BRIDGE_KEY = 'gomentor'

export const DEFAULT_BOARD_SIZE = 19
export const DEFAULT_KOMI = 6.5

/** Star points (hoshi) per board size, as [x, y] zero-indexed from top-left. */
export const STAR_POINTS: Record<number, readonly (readonly [number, number])[]> = {
  9: [
    [2, 2],
    [6, 2],
    [4, 4],
    [2, 6],
    [6, 6],
  ],
  13: [
    [3, 3],
    [9, 3],
    [6, 6],
    [3, 9],
    [9, 9],
  ],
  19: [
    [3, 3],
    [9, 3],
    [15, 3],
    [3, 9],
    [9, 9],
    [15, 9],
    [3, 15],
    [9, 15],
    [15, 15],
  ],
}

/**
 * GTP column labels skip 'I' to avoid confusion with 'J' on hand-drawn
 * diagrams. This is the single most common source of off-by-one bugs in Go
 * software, which is why coordinate conversion is property-tested.
 */
export const GTP_COLUMNS = 'ABCDEFGHJKLMNOPQRST' as const

/** SGF uses lowercase letters, and does not skip any. */
export const SGF_COLUMNS = 'abcdefghijklmnopqrs' as const

/**
 * Cap on main→renderer analysis events. Engines emit far faster than a UI can
 * paint, and flooding IPC is a known Electron performance cliff. Used from M2.
 */
export const ANALYSIS_EVENT_HZ = 20

/** Consecutive engine start failures before the circuit breaker opens. */
export const ENGINE_RESTART_LIMIT = 3

/** Max tool-calling steps per agent run, so a loop cannot run away. Used from M3. */
export const AGENT_MAX_STEPS = 8

/** Animation budget in ms. Cancellable and skippable — holding an arrow key
 * to scan a game must not queue hundreds of animations. */
export const ANIMATION_BUDGET_MS = 120
