/**
 * The "is this game the student's own" predicate — the `mine` scope of batch
 * analysis and the profile's input filter.
 *
 * ## The contract (M4 scope decision 2 + C4)
 *
 * - The manual per-game override is tri-state (`true` | `false` | unset) and
 *   **outranks everything**: a user who marks a game "not mine" means it, even
 *   if one of their names is on it — and a user who claims a professional
 *   demonstration game as study material gets it into their profile.
 * - A **professional game is not the student's game by default** (C4): ranks
 *   are free-text SGF (`BR`/`WR`), so professionalism is a pattern on the
 *   string — an explicit "pro" word, or the `1p`–`9p` convention. The rule
 *   errs toward exclusion, which is the safe direction: a game left out of
 *   the profile costs nothing, a teacher's game analysed as the student's own
 *   mistakes poisons every threshold. Absent ranks never read as professional.
 * - Name matching is **case-insensitive** and matches **either colour**: the
 *   student studies their games as both black and white.
 * - An empty "my names" list matches nothing. With no names and no override
 *   there is no claim to make — "my library" is empty, a state, not an error
 *   (`error-handling.md`).
 *
 * Pure and dependency-free: importable without `electron`, the store, or
 * settings, so the batch queue and the on-demand profile derivation test the
 * same predicate the renderer-visible behaviour runs.
 */

/** The name and rank fields a game carries — the only inputs the predicate reads. */
export interface GameNames {
  readonly blackName?: string | undefined
  readonly whiteName?: string | undefined
  readonly blackRank?: string | undefined
  readonly whiteRank?: string | undefined
}

/**
 * True when the rank string denotes a professional player.
 *
 * Two patterns, both anchored on word boundaries: the explicit word ("pro"),
 * and the professional dan convention written as digits plus "p" ("9p"). The
 * digit anchor stops "p"-containing words ("champion") from matching; the word
 * boundary stops a substring inside a longer token. SGF ranks are free text
 * and this cannot be exhaustive — an unrecognised pro notation lands in the
 * profile until the user marks the game "not mine", which is the documented
 * escape hatch, not a silent failure.
 */
export function isProfessionalRank(rank: string): boolean {
  return /\bpro(fessional)?\b/i.test(rank) || /\d\s*p\b/i.test(rank)
}

function isProfessional(names: GameNames): boolean {
  return (
    (names.blackRank !== undefined && isProfessionalRank(names.blackRank)) ||
    (names.whiteRank !== undefined && isProfessionalRank(names.whiteRank))
  )
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
  // Priority 1 — the manual mark, whatever the names and ranks say.
  if (override !== undefined) return override

  // Priority 2 — a professional's game teaches, it is not the student's own
  // play. Overridable by design ("默认不入画像").
  if (isProfessional(names)) return false

  // A list of no real names claims nothing; without it the empty string would
  // match an empty player name, which is not a match by any reading.
  const wanted = new Set(
    playerNames.map((name) => name.toLowerCase()).filter((name) => name.length > 0),
  )
  if (wanted.size === 0) return false

  // Priority 3 — case-insensitive match on either colour.
  return (
    (names.blackName !== undefined && wanted.has(names.blackName.toLowerCase())) ||
    (names.whiteName !== undefined && wanted.has(names.whiteName.toLowerCase()))
  )
}
