/**
 * The "is this game the student's own" predicate — the `mine` scope of batch
 * analysis and (from Stage 3) the profile's input filter.
 *
 * ## The contract (M4 scope decision 2)
 *
 * - The manual per-game override is tri-state (`true` | `false` | unset) and
 *   **outranks name matching**: a user who marks a game "not mine" means it,
 *   even if one of their names is on it — and vice versa.
 * - Name matching is **case-insensitive** and matches **either colour**: the
 *   student studies their games as both black and white.
 * - An empty "my names" list matches nothing. With no names and no override
 *   there is no claim to make — "my library" is empty, a state, not an error
 *   (`error-handling.md`).
 *
 * ## Stage 3 relocation
 *
 * This module is pure and dependency-free on purpose: Stage 3 moves it to
 * `packages/core/src/profile/mine.ts` (the profile core is pure and
 * Electron-free, and the predicate is profile input, not library mechanics).
 * Keep it importable without `electron`, the store, or settings — the move
 * should be a path change, nothing more.
 */

/** The names a game summary carries — the only fields the predicate reads. */
export interface GameNames {
  readonly blackName?: string | undefined
  readonly whiteName?: string | undefined
}

/**
 * True when the record counts as the student's own game.
 *
 * `override` comes from `games.is_mine_override` (`GameStore.getIsMineOverride`);
 * `playerNames` from `settings.profile.playerNames`. Both arrive as data so
 * the predicate stays a pure function of its arguments — testable headless,
 * and free of the "which setting wins" drift a stateful version invites.
 */
export function isMyGame(
  names: GameNames,
  playerNames: readonly string[],
  override: boolean | undefined,
): boolean {
  // Priority 1 — the manual mark, whatever the names say.
  if (override !== undefined) return override

  // A list of no real names claims nothing; without it the empty string would
  // match an empty player name, which is not a match by any reading.
  const wanted = new Set(
    playerNames.map((name) => name.toLowerCase()).filter((name) => name.length > 0),
  )
  if (wanted.size === 0) return false

  // Priority 2 — case-insensitive match on either colour.
  return (
    (names.blackName !== undefined && wanted.has(names.blackName.toLowerCase())) ||
    (names.whiteName !== undefined && wanted.has(names.whiteName.toLowerCase()))
  )
}
