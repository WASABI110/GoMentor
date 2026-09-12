import { z } from 'zod'

/**
 * The student profile (M4 Stage 3/4): derived on demand from the persisted
 * analysis rows of the student's own games — never stored, so there is
 * nothing to invalidate. The four categories and their thresholds live in
 * `core/profile`; this file is the wire face the renderer and the teacher
 * tool both read.
 */

/** The classifier's category set (`core/profile/categories.ts` is the authority). */
export const profileCategorySchema = z.enum([
  'opening-direction',
  'middlegame-fighting',
  'endgame-precision',
  'whole-board-blindspot',
])
export type ProfileCategory = z.infer<typeof profileCategorySchema>

export const profileTrendSchema = z.enum(['improving', 'steady', 'worsening'])
export type ProfileTrend = z.infer<typeof profileTrendSchema>

/** One click-through: open this game at this move (C5's jump parameters). */
export const profileEvidenceSchema = z.object({
  gameId: z.string().min(1),
  moveNumber: z.number().int().min(1),
  /** The move's cost in winrate points (0..1 scale, signed by design). */
  loss: z.number(),
})
export type ProfileEvidence = z.infer<typeof profileEvidenceSchema>

/** Three is the profile core's `EVIDENCE_LIMIT` — pinned here so the wire cannot widen it. */
export const PROFILE_EVIDENCE_LIMIT = 3

export const profileWeaknessSchema = z.object({
  category: profileCategorySchema,
  /** EMA of per-game category losses, in winrate points (0..1 scale). */
  score: z.number(),
  trend: profileTrendSchema,
  // A weakness exists because marks were earned — the core skips a category
  // with no evidence, so an evidence-less weakness would be a contract lie.
  // Both arrays are readonly on the wire: the snapshot is a derivation the
  // renderer reads, never a structure it edits (the core returns readonly).
  evidence: z
    .array(profileEvidenceSchema)
    .min(1)
    .max(PROFILE_EVIDENCE_LIMIT)
    .readonly(),
})
export type ProfileWeakness = z.infer<typeof profileWeaknessSchema>

/** The profile core names at most three weaknesses. */
export const PROFILE_WEAKNESS_LIMIT = 3

/**
 * The `profile:get` response. The counts frame the weaknesses: `myGames` is
 * how many of the student's own games the library holds, `analysedMyGames`
 * how many of those have any analysis rows — a profile panel showing three
 * weaknesses over a library where nothing is analysed yet would be a lie, so
 * the UI can say "run the batch analysis" instead.
 *
 * An empty weaknesses list is a state, not an error (`error-handling.md`): a
 * student whose games show no classified weaknesses — or whose library is
 * empty — simply has nothing to work on from here.
 */
export const profileSnapshotSchema = z.object({
  weaknesses: z.array(profileWeaknessSchema).max(PROFILE_WEAKNESS_LIMIT).readonly(),
  myGames: z.number().int().min(0),
  analysedMyGames: z.number().int().min(0),
})
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>
