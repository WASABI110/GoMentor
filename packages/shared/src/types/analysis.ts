import { z } from 'zod'
import { errorCodeSchema } from './errors'
import { boardSizeSchema, coordSchema, gameSetupSchema, playerSchema } from './game'

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
  /**
   * Present only when status is 'failed'. Parsed through `errorCodeSchema`,
   * not `z.string()`: the renderer translates this value through the `errors`
   * i18n namespace, so an invented code must die at this boundary rather than
   * reach the UI as an untranslatable key. Every code the service assigns is
   * a member of the enum (`main/katago/service.ts`); a new failure path adds
   * its code to `errors.ts` in the same commit.
   */
  errorCode: errorCodeSchema.optional(),
  /** Present only when status is 'downloading'. 0..1 */
  downloadProgress: z.number().min(0).max(1).optional(),
})
export type EngineInfo = z.infer<typeof engineInfoSchema>

/**
 * Query-id namespace prefixes — the routing contract between main and
 * renderer for `engine:analysis` (`design.md` §IPC additions). Focus queries
 * are `focus:<n>`; the sweep tier (Stage 4) reserves `sweep:<moveNumber>`.
 * Kept in the shared contract (not restated per side) so a rename is a
 * compile error in both processes at once.
 */
export const FOCUS_QUERY_PREFIX = 'focus:'
export const SWEEP_QUERY_PREFIX = 'sweep:'

/**
 * The game record an analysis request carries.
 *
 * Self-contained by design (`design.md` §IPC additions): the engine service
 * must not import the library store, so the renderer resends the record (~2KB
 * for 300 moves — noise) instead of referencing a library id. `moves` is the
 * full record; `atMove` in the request selects the analysed position, and the
 * session slices. `rules` is the raw SGF ruleset string — mapping it onto a
 * KataGo ruleset is the session's job, and unknown values fall back to
 * `chinese` there, not here: the contract stays honest about what it holds.
 */
export const engineGameSchema = z.object({
  /** Correlates results; filters answers from a since-closed game. */
  gameId: z.string().min(1),
  boardSize: boardSizeSchema,
  komi: z.number(),
  rules: z.string(),
  setup: gameSetupSchema,
  /** Full mainline record. A pass is `coord: null` and must not be dropped. */
  moves: z.array(
    z.object({
      player: playerSchema,
      coord: coordSchema.nullable(),
    }),
  ),
})
export type EngineGame = z.infer<typeof engineGameSchema>

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
