import { z } from 'zod'
import { errorEnvelopeSchema } from './errors'

/**
 * Batch analysis of the library (M4 Stage 2): whole-library (or "my games"
 * subset) analysis at sweep budget, driven by the `batch_state` ledger so a
 * restart resumes instead of re-analysing.
 *
 * ## What the status snapshot is for
 *
 * `batch:status` answers synchronously so a freshly mounted panel can sync
 * without subscribing first — the same pattern as `engine:info`. When no run
 * is active the snapshot is `idle` with zeroed counts: how much of the library
 * has ever been analysed lives in the ledger, and Stage 4's profile section
 * derives it on demand. This face only reports the *run*.
 *
 * ## Why the counts are data, not an error
 *
 * An empty queue — empty library, or a `mine` scope no game matches — is a
 * state (`done` with `total: 0`), exactly the "expected absence" rule in
 * `error-handling.md`. A new user has no games and no weaknesses yet; that is
 * not a failure branch.
 */

/** What a run analyses: everything, or only the student's own games. */
export const batchScopeSchema = z.enum(['all', 'mine'])
export type BatchScope = z.infer<typeof batchScopeSchema>

/**
 * The invoke-side snapshot of the batch service. `scope` is present only while
 * running — an idle service has nothing to name.
 *
 * The trailing refinement is the count invariant, not key strictness: every
 * queued game is `done`, `failed`, or still pending exactly once, so
 * `done + failed` can never exceed `total`. (Unknown KEYS are stripped, not
 * rejected, on every envelope in this repo — the settings.ts forward-compat
 * precedent; only wire values this build produces are held to invariants.)
 */
export const batchStatusSchema = z
  .object({
    status: z.enum(['idle', 'running']),
    scope: batchScopeSchema.optional(),
    total: z.number().int().min(0),
    done: z.number().int().min(0),
    failed: z.number().int().min(0),
  })
  .refine((value) => value.done + value.failed <= value.total, {
    message: 'done + failed exceeds total',
  })
export type BatchStatus = z.infer<typeof batchStatusSchema>

/**
 * The push-side progress event. Emitted on run start, after every game
 * completes, and once with a terminal status. Bounded by the number of games
 * in the run, so no coalescing is needed.
 *
 * Terminal states: `done` (every queued game finished), `cancelled` (the user
 * stopped the run — unfinished games stay `pending` in the ledger and resume
 * next run), `failed` (the engine was lost mid-run; `error` carries the typed
 * envelope, usually an `ENGINE_*` code, so the renderer can translate it).
 */
export const batchProgressSchema = z
  .object({
    status: z.enum(['running', 'done', 'cancelled', 'failed']),
    total: z.number().int().min(0),
    done: z.number().int().min(0),
    failed: z.number().int().min(0),
    error: errorEnvelopeSchema.optional(),
  })
  // Same count invariant as the snapshot: a game is accounted for exactly once.
  .refine((value) => value.done + value.failed <= value.total, {
    message: 'done + failed exceeds total',
  })
  // The envelope rides only on a terminal failure — `running`, `done`, and
  // `cancelled` all have a defined meaning without one, and an error on a
  // non-failure status would contradict the doc contract above.
  .refine((value) => value.status === 'failed' || value.error === undefined, {
    message: 'error is present only on a failed run',
  })
export type BatchProgress = z.infer<typeof batchProgressSchema>
