import { z } from 'zod'

/**
 * Board geometry and game records.
 *
 * The canonical coordinate form is `[x, y]`, zero-indexed from the top-left.
 * Converters to and from SGF letters, GTP labels, and pixel space live in
 * `@gomentor/core/board/coords` — every historical Go software bug lives in
 * those conversions, so they are centralised and property-tested.
 */

export const BOARD_SIZES = [9, 13, 19] as const

export const boardSizeSchema = z.union([z.literal(9), z.literal(13), z.literal(19)])
export type BoardSize = z.infer<typeof boardSizeSchema>

export const playerSchema = z.enum(['black', 'white'])
export type Player = z.infer<typeof playerSchema>

/** Zero-indexed from the top-left. A pass is represented by `null`, not by a sentinel coord. */
export const coordSchema = z.object({
  x: z.number().int().min(0).max(18),
  y: z.number().int().min(0).max(18),
})
export type Coord = z.infer<typeof coordSchema>

export const moveSchema = z.object({
  /** 1-based; move 0 is the empty board, so the first played move is 1. */
  number: z.number().int().min(1),
  player: playerSchema,
  /** `null` is a pass. Keeping pass out of the coord type stops it being confused with (0,0). */
  coord: coordSchema.nullable(),
  comment: z.string().optional(),
})
export type Move = z.infer<typeof moveSchema>

export const gameResultSchema = z.object({
  winner: z.union([playerSchema, z.literal('draw'), z.literal('unknown')]),
  /** Point margin. Absent for resignation, timeout, or forfeit. */
  score: z.number().optional(),
  by: z.enum(['points', 'resignation', 'timeout', 'forfeit', 'unknown']),
})
export type GameResult = z.infer<typeof gameResultSchema>

export const gameMetaSchema = z.object({
  boardSize: boardSizeSchema,
  handicap: z.number().int().min(0).max(9).default(0),
  komi: z.number().default(6.5),
  blackName: z.string().optional(),
  whiteName: z.string().optional(),
  blackRank: z.string().optional(),
  whiteRank: z.string().optional(),
  /** ISO 8601 date string. SGF dates are unreliable, so this stays a string. */
  date: z.string().optional(),
  event: z.string().optional(),
  place: z.string().optional(),
  result: gameResultSchema.optional(),
  ruleset: z.string().optional(),
})
export type GameMeta = z.infer<typeof gameMetaSchema>

/** Where a game came from. Determines which sync path can refresh it. */
export const gameSourceSchema = z.enum(['import', 'fox', 'readboard', 'manual'])
export type GameSource = z.infer<typeof gameSourceSchema>

export const gameSchema = z.object({
  id: z.string().min(1),
  meta: gameMetaSchema,
  /** Mainline moves. Variations live in the GameTree AST, not here. */
  moves: z.array(moveSchema),
  source: gameSourceSchema,
  /** Content hash of the original SGF, used for import dedupe. */
  contentHash: z.string(),
  /** Absent for games that never came from a file (readboard, manual). */
  filePath: z.string().optional(),
  importedAt: z.string(),
})
export type Game = z.infer<typeof gameSchema>

/** Summary row for the library list. Avoids shipping every move to render a list. */
export const gameSummarySchema = z.object({
  id: z.string().min(1),
  blackName: z.string().optional(),
  whiteName: z.string().optional(),
  date: z.string().optional(),
  moveCount: z.number().int().min(0),
  boardSize: boardSizeSchema,
  result: gameResultSchema.optional(),
  source: gameSourceSchema,
})
export type GameSummary = z.infer<typeof gameSummarySchema>
