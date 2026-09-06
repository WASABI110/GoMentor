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

/**
 * The board before move 1: SGF `AB`/`AW` placements.
 *
 * Separate from `moves` and not derivable from them. A handicap game's nine
 * stones are *position*, not play — folding them into `moves` would make move 1
 * belong to the wrong player and shift every move-number label — so
 * `main/sgf/adapter.ts` excludes them there, correctly. But nothing else carried
 * them, and the renderer only ever receives a `Game`, never the AST. The result
 * was that a handicap game reached the board with its nine stones missing.
 *
 * Nor can `handicap` stand in. Measured over the 44-file corpus: three files
 * (`gnugo-ko6-jago`, `sabaki-sgf-no-ca`, `katago-sampletest9x9`) carry `AB`/`AW`
 * with no `HA` at all, one carries 34 *white* setup stones, and a count cannot
 * express placement in any case.
 *
 * ## Why an initial position rather than per-node setup
 *
 * SGF permits setup properties on any node, which would make this a per-move
 * concern. It was measured instead of assumed: across all 44 corpus fixtures,
 * **every mainline setup node occurs before move 1**, and the only four `AE`
 * (erase) nodes in the corpus are off-mainline, inside variations. So the
 * mainline needs an initial position and nothing more, and modelling it as one
 * keeps replay a fold over `moves` from a known start.
 *
 * The bound this accepts, stated so it is not mistaken for coverage: a file that
 * *does* place stones mid-mainline will replay without them. The AST keeps that
 * information and `sgf:serialize` writes from the AST, so nothing is lost on
 * disk — it is the rendered position that would be wrong, and it is the move
 * tree in M2 that needs the per-node model.
 */
export const gameSetupSchema = z.object({
  black: z.array(coordSchema).default([]),
  white: z.array(coordSchema).default([]),
})
export type GameSetup = z.infer<typeof gameSetupSchema>

/**
 * One branch alternative offered at a mainline branch point (Stage 4's
 * read-only branch navigation, `design.md` §Branch navigation).
 *
 * `index` is the SGF **child index** of the alternative: 0 is always the
 * default continuation (SGF's first-child mainline convention), 1.. are the
 * variations. It is a child index, not a display ordinal, because that is
 * exactly what `sgf:parse`'s `variationPath` consumes — the picker round-trips
 * the value without a mapping.
 */
export const branchOptionSchema = z.object({
  /** SGF child index; 0 = the default (first-child) continuation. */
  index: z.number().int().min(0),
  /** Player of the alternative's first move. */
  player: playerSchema,
  /** First move of the alternative, `null` when it opens with a pass. */
  coord: coordSchema.nullable(),
  /** Move count of the alternative's own mainline (first child at each step). */
  moves: z.number().int().min(1),
  /** The alternative's first-node comment, when the file provides one. */
  label: z.string().optional(),
})
export type BranchOption = z.infer<typeof branchOptionSchema>

export const gameSchema = z.object({
  id: z.string().min(1),
  meta: gameMetaSchema,
  /**
   * Stones on the board before move 1. `.prefault({})` rather than `.optional()`:
   * an absent key and an empty setup mean the same thing to every consumer, and
   * making it optional would push a `?? { black: [], white: [] }` into each of
   * them — one of which would eventually be forgotten. `.prefault` not
   * `.default`, for the reason `settings.ts` records: `.default({})` uses the
   * value verbatim, leaving the inner arrays undefined.
   */
  setup: gameSetupSchema.prefault({}),
  /** Mainline moves. Variations live in the GameTree AST, not here. */
  moves: z.array(moveSchema),
  /**
   * Branch options along the projected line, indexed by **arrival index** (the
   * cursor position at which the options apply): entry `c` lists the child
   * alternatives of the node reached with `c` moves applied. Entry 0 (options
   * for the first move) sits at index 0; a branch point after the last move
   * sits at index `moves.length`. Entries where the node has no alternatives
   * are empty arrays, and the array is `[]` for a record with no branches at
   * all (dense, not sparse: JSON has no array holes — a sparse JS array would
   * cross IPC as `null`s and need a hole-tolerant schema for nothing).
   */
  branches: z.array(z.array(branchOptionSchema)).prefault([]),
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
