import type { CategoryId, CategoryMark } from './categories'
import { CATEGORY_IDS } from './categories'

/**
 * The profile assembly (M4 design §3): one game's category marks in, the
 * student's three weaknesses out. Pure and synchronous — the profile is
 * derived on demand from the persisted analysis rows, never stored as a
 * snapshot, so there is nothing to invalidate when a re-import drops stale
 * rows (the same reasoning the batch tier's ledger runs on).
 *
 * ## The EMA and its half-life
 *
 * Each game contributes to a category the sum of its mark losses in that
 * category, in winrate points. Games are folded in oldest-first with an
 * exponential moving average whose half-life is `HALF_LIFE_GAMES`: a game ten
 * games back weighs half of the newest one. Recency is the point — the
 * profile describes the student *now*; a weakness they have outgrown fades
 * out instead of haunting the panel. The first game seeds the average
 * directly (there is nothing to smooth into).
 *
 * ## Trend, honestly named
 *
 * The score alone cannot say whether a weakness is growing. The trend
 * compares the full-series EMA against the EMA of the older half only: if the
 * recent games moved the number up past `TREND_EPSILON`, the weakness is
 * worsening; down, improving; inside the band, steady. With fewer than two
 * games there is no "older half" to compare against and the trend is steady
 * — one data point is not a trend.
 *
 * ## Evidence is the click-through contract (C5)
 *
 * Each weakness carries up to `EVIDENCE_LIMIT` marks, biggest loss first,
 * each naming the game and move so the panel can open the record at that
 * move. Every mark ever earned is eligible — a small slip in an old game is
 * still the concrete "show me" a student asks for — but only the biggest few
 * travel, because evidence exists to be clicked, not to be exhaustive.
 */

/** A game's EMA weight halves this many games back. */
export const HALF_LIFE_GAMES = 10

/** How many evidence marks one weakness carries (the teacher tool quotes the same cap). */
export const EVIDENCE_LIMIT = 3

/** How many weaknesses the profile names. */
export const WEAKNESS_LIMIT = 3

/**
 * The winrate-point movement past which the trend reads as a direction.
 * Below this the EMA is noise — a fraction of the smallest classified loss.
 */
export const TREND_EPSILON = 0.005

/** One game's contribution — the classifier's marks plus the identity the evidence needs. */
export interface ProfileGameInput {
  readonly gameId: string
  /**
   * The time axis. ISO timestamp — `importedAt` in practice, the same ordering
   * the library list shows the student.
   */
  readonly importedAt: string
  readonly marks: readonly CategoryMark[]
}

/** One piece of click-through evidence: open this game at this move. */
export interface ProfileEvidence {
  readonly gameId: string
  readonly moveNumber: number
  readonly loss: number
}

export type ProfileTrend = 'improving' | 'steady' | 'worsening'

export interface CategoryWeakness {
  readonly category: CategoryId
  /** The EMA of per-game category losses, in winrate points. */
  readonly score: number
  readonly trend: ProfileTrend
  readonly evidence: readonly ProfileEvidence[]
}

export interface ProfileSnapshot {
  readonly weaknesses: readonly CategoryWeakness[]
}

/** Per-game category loss sums, one entry per game in the input's given order. */
function categoryValues(
  games: readonly ProfileGameInput[],
  category: CategoryId,
): number[] {
  return games.map((game) =>
    game.marks.reduce(
      (total, mark) => (mark.category === category ? total + mark.loss : total),
      0,
    ),
  )
}

/**
 * The exponentially weighted average over oldest-first values, half-life
 * `HALF_LIFE_GAMES`: each game's weight is `0.5^(age / halfLife)`, ages
 * counted in games from the newest, normalized by the total weight.
 *
 * The textbook recurrence (`ema = alpha·v + (1−alpha)·ema`, seeded with the
 * first value) was rejected for a measured reason: with a 10-game half-life
 * and a 2-game library, the seed holds ~93% of the weight — the OLDEST game
 * would dominate exactly where the student is newest, inverting the intent
 * for everyone before their eleventh game. Normalizing the decaying weights
 * keeps the same half-life semantics while being well-defined from the first
 * game on.
 */
function ema(values: readonly number[]): number {
  if (values.length === 0) return 0
  let weighted = 0
  let totalWeight = 0
  for (let i = 0; i < values.length; i += 1) {
    const age = values.length - 1 - i
    const weight = Math.pow(0.5, age / HALF_LIFE_GAMES)
    weighted += weight * (values[i] ?? 0)
    totalWeight += weight
  }
  return weighted / totalWeight
}

function trendOf(values: readonly number[]): ProfileTrend {
  if (values.length < 2) return 'steady'
  const mid = Math.floor(values.length / 2)
  const older = ema(values.slice(0, mid))
  const overall = ema(values)
  if (overall > older + TREND_EPSILON) return 'worsening'
  if (overall < older - TREND_EPSILON) return 'improving'
  return 'steady'
}

export function buildProfile(games: readonly ProfileGameInput[]): ProfileSnapshot {
  // The EMA's time axis: oldest first. Ties keep the caller's order (stable
  // sort), so equal timestamps — a same-batch import — fold deterministically.
  const ordered = [...games].sort((a, b) => a.importedAt.localeCompare(b.importedAt))

  const weaknesses: CategoryWeakness[] = []
  for (const category of CATEGORY_IDS) {
    // Evidence gathers across every game first: eligibility is "a mark was
    // earned", not "the game made the EMA move".
    const evidence: ProfileEvidence[] = []
    for (const game of ordered) {
      for (const mark of game.marks) {
        if (mark.category !== category) continue
        evidence.push({
          gameId: game.gameId,
          moveNumber: mark.moveNumber,
          loss: mark.loss,
        })
      }
    }
    if (evidence.length === 0) continue

    evidence.sort((a, b) => b.loss - a.loss)

    const values = categoryValues(ordered, category)
    weaknesses.push({
      category,
      score: ema(values),
      trend: trendOf(values),
      evidence: evidence.slice(0, EVIDENCE_LIMIT),
    })
  }

  weaknesses.sort((a, b) => b.score - a.score)
  return { weaknesses: weaknesses.slice(0, WEAKNESS_LIMIT) }
}
