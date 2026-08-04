import { z } from 'zod'
import { coordSchema, playerSchema } from './game'

/**
 * KataGo analysis payloads and engine lifecycle.
 *
 * Defined in M1 even though the engine lands in M2, so that the renderer can
 * model engine absence as a state from day one and M2 becomes additive.
 */

/**
 * Engine lifecycle as a first-class state, never an exception.
 *
 * KataGo being absent is a normal condition with a UI representation — not an
 * error. Modelling it as a state is what lets the app stay fully usable
 * without an engine, and what makes `downloading` (the tiered installer's
 * first-run fetch, ADR 0003) a normal state rather than an error path.
 */
export const engineStatusSchema = z.enum([
  'unavailable',
  'downloading',
  'starting',
  'ready',
  'failed',
])
export type EngineStatus = z.infer<typeof engineStatusSchema>

/** Compute backend, in the order `backend-detect` probes them. */
export const engineBackendSchema = z.enum(['tensorrt', 'cuda', 'opencl', 'eigen'])
export type EngineBackend = z.infer<typeof engineBackendSchema>

export const engineInfoSchema = z.object({
  status: engineStatusSchema,
  backend: engineBackendSchema.optional(),
  version: z.string().optional(),
  /** Measured, not advertised — the detector benchmarks each candidate. */
  visitsPerSecond: z.number().optional(),
  networkName: z.string().optional(),
  /** Present only when status is 'failed'. */
  errorCode: z.string().optional(),
  /** Present only when status is 'downloading'. 0..1 */
  downloadProgress: z.number().min(0).max(1).optional(),
})
export type EngineInfo = z.infer<typeof engineInfoSchema>

/** One candidate move from KataGo's analysis. */
export const moveInfoSchema = z.object({
  coord: coordSchema.nullable(),
  /** 0..1, from the perspective of the player to move. */
  winrate: z.number().min(0).max(1),
  /** Points. Positive favours black. */
  scoreLead: z.number(),
  visits: z.number().int().min(0),
  /** Principal variation — the engine's expected continuation. */
  pv: z.array(coordSchema.nullable()),
  /** Rank among candidates, 0 = best. */
  order: z.number().int().min(0),
})
export type MoveInfo = z.infer<typeof moveInfoSchema>

/**
 * Per-point ownership estimate, row-major, length = boardSize².
 * Range -1 (certain white) to 1 (certain black).
 */
export const ownershipSchema = z.array(z.number().min(-1).max(1))
export type Ownership = z.infer<typeof ownershipSchema>

export const analysisResultSchema = z.object({
  /** Correlates the response to its request; concurrent queries are in flight. */
  queryId: z.string(),
  gameId: z.string(),
  moveNumber: z.number().int().min(0),
  player: playerSchema,
  winrate: z.number().min(0).max(1),
  scoreLead: z.number(),
  visits: z.number().int().min(0),
  candidates: z.array(moveInfoSchema),
  ownership: ownershipSchema.optional(),
  /** True once the engine has finished, false for a streaming partial. */
  complete: z.boolean(),
})
export type AnalysisResult = z.infer<typeof analysisResultSchema>

/**
 * How much a played move cost against the engine's preference.
 * Derived in `@gomentor/core/profile/weakness`, which is pure and
 * unit-testable — the LLM only explains categories, never assigns them.
 */
export const moveDeltaSchema = z.object({
  moveNumber: z.number().int().min(1),
  /** Winrate lost by the played move versus the engine's best. Non-negative. */
  winrateLoss: z.number().min(0),
  scoreLoss: z.number(),
  bestCoord: coordSchema.nullable(),
  playedCoord: coordSchema.nullable(),
})
export type MoveDelta = z.infer<typeof moveDeltaSchema>

export const gamePhaseSchema = z.enum(['opening', 'middlegame', 'endgame'])
export type GamePhase = z.infer<typeof gamePhaseSchema>
