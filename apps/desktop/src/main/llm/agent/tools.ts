import { toGtp } from '@gomentor/core/board/coords'
import type { ToolSchema } from '@gomentor/core/llm/provider'
import {
  AppError,
  isAppError,
  type AnalysisResult,
  type BoardSize,
  type Coord,
  type Game,
  type GameSummary,
  type Player,
  type ProfileSnapshot,
} from '@gomentor/shared'
import { z } from 'zod'
import type { EngineService } from '../../katago/service'
import type { GameStore } from '../../library/store'
import { toEngineGame } from '../../sgf/adapter'
import { AGENT_QUERY_VISITS, playerToMoveAt } from '../../katago/session'
import { scoped } from '../../logger'

/**
 * The LLM agent's read-only tool registry (M3 Stage 1).
 *
 * ## This is main-internal, and that is the point
 *
 * Nothing here adds an IPC channel: the wire-facing surface stays
 * `llm:sendMessage` / `llm:delta` / `llm:cancel`, and the agent loop (Stage 2)
 * is the only consumer of this module. The renderer sees tool activity as
 * `tool_call` / `tool_result` chunks on the existing channel, so the A9
 * meta-test surface is unchanged by design.
 *
 * ## The dispatch contract, stated once because every tool relies on it
 *
 * `dispatchTool` **never throws for a tool-level failure** — it returns an
 * `isError: true` outcome the model can read and self-correct from. The model
 * hallucinating an argument is a normal part of an agent loop, not a run-ending
 * fault; terminating the run for it would trade one retryable mistake for a
 * dead conversation. Exactly one error class escapes, deliberately:
 * cancellation (`LLM_ABORTED`) re-throws, because a cancelled run must not be
 * answered with another provider request carrying an already-dead signal.
 *
 * Error codes inside those results reuse the existing domain codes rather than
 * inventing tool-specific ones, by the mapping a caller can rely on:
 *
 * - `LIBRARY_NOT_FOUND` — no game open / no such id (`library` owns the data);
 * - `IPC_INVALID_REQUEST` — a *request* that failed validation: unknown tool
 *   name, arguments failing the tool's schema, or a `moveNumber` outside the
 *   record. This is the same class of failure `ipc/register.ts` maps to the
 *   same code, and the tool call is a request in exactly that sense;
 * - `ENGINE_UNAVAILABLE` / `ENGINE_QUERY_FAILED` — passed through from
 *   `analyzeOnce` (`main/katago/service.ts` owns those meanings).
 *
 * ## Content bounding is a rule here, not a style choice
 *
 * Everything a tool returns becomes model context and reaches the renderer as
 * a `tool_result` preview. So tools return *compact summaries* — never a full
 * SGF, never an ownership tensor, never a whole library — and every
 * model-supplied string echoed back is sliced to a bound. The same rule that
 * keeps log messages free of user content keeps these payloads affordable and
 * previewable.
 */

const logger = scoped('main:llm:tools')

/** The bound for a model-supplied string echoed back in an error message. */
const ECHO_BOUND = 48

function bound(value: string, max: number = ECHO_BOUND): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** What a tool's execution produces. The runner (Stage 2) attaches `toolCallId`. */
export interface ToolOutcome {
  readonly content: string
  readonly isError: boolean
}

/**
 * What a tool needs from its caller. The engine seam is the `EngineService`
 * interface, so unit tests stub `analyzeOnce` without an engine; the store is
 * the real library store interface for the same reason.
 */
export interface ToolContext {
  /** The open game, from the chat context the renderer sent. Absent when none is open. */
  readonly gameId?: string
  readonly store: GameStore
  readonly engine: EngineService
  /**
   * The student profile, derived on demand (M4). A seam rather than the
   * repository: the derivation is `profile.handlers`' `buildSnapshot`, and the
   * tool must not know how the snapshot came to be — only what it may quote.
   */
  readonly profile: () => ProfileSnapshot
}

/**
 * The type-erased tool. Erasure lives in `defineTool`, so no tool body ever
 * handles `unknown` arguments: the schema is parsed on the way in and the
 * typed value reaches `execute`.
 */
export interface AnyAgentTool {
  readonly name: string
  readonly description: string
  readonly zodSchema: z.ZodType
  readonly execute: (
    args: unknown,
    ctx: ToolContext,
    signal: AbortSignal,
  ) => Promise<ToolOutcome>
}

function defineTool<A>(definition: {
  readonly name: string
  readonly description: string
  readonly zodSchema: z.ZodType<A>
  readonly execute: (
    args: A,
    ctx: ToolContext,
    signal: AbortSignal,
  ) => ToolOutcome | Promise<ToolOutcome>
}): AnyAgentTool {
  return {
    name: definition.name,
    description: definition.description,
    zodSchema: definition.zodSchema,
    execute: (args, ctx, signal) => {
      // The erasure point, and the only one: the schema is parsed here and the
      // typed value reaches `execute`. A validation failure surfaces as the
      // zod error `dispatchTool` formats, never inside a tool body.
      const parsed = definition.zodSchema.parse(args)
      // `Promise.resolve` rather than an async wrapper, so a synchronous tool
      // stays synchronous and the erased interface stays uniformly awaitable.
      return Promise.resolve(definition.execute(parsed, ctx, signal))
    },
  }
}

// ---------------------------------------------------------------------------
// Pure logic, exported for direct tests and mutation coverage
// ---------------------------------------------------------------------------

/** How many moves leading up to the queried position `get_position` returns. */
export const RECENT_MOVE_LIMIT = 5

/** How many library records `search_library` may return. */
export const SEARCH_RESULT_LIMIT = 10

/** How many candidate moves and pv plies `get_analysis` returns. */
export const TOP_CANDIDATE_LIMIT = 3
export const PV_LIMIT = 6

/**
 * Validates `moveNumber` against a record and returns it unchanged.
 *
 * The bound is inclusive at both ends — `0..moves.length` — because cursor N
 * means N moves applied in this codebase, so the position after the last move
 * is a real, askable position. Setup stones are *not* part of the numbering
 * (they are position, not play — the M1 `setup` field exists precisely for
 * that), which is why the upper bound is the played-move count and not a
 * stone count. The message carries the record's bound because it is what lets
 * the model self-correct on its next call.
 */
export function checkMoveNumber(game: Game, moveNumber: number): number {
  if (
    !Number.isInteger(moveNumber) ||
    moveNumber < 0 ||
    moveNumber > game.moves.length
  ) {
    throw new AppError(
      'IPC_INVALID_REQUEST',
      `moveNumber ${String(moveNumber)} is outside this record: the valid range is 0..${String(game.moves.length)}`,
      { context: { moveCount: game.moves.length } },
    )
  }
  return moveNumber
}

/** The compact position summary `get_position` returns. Never a full record. */
export interface PositionSummary {
  readonly gameId: string
  readonly blackName?: string
  readonly whiteName?: string
  readonly boardSize: BoardSize
  readonly komi: number
  /** The side to move at `moveNumber` — the player whose choice is under discussion. */
  readonly playerToMove: Player
  /** Setup stones placed before move 1, as counts. Position, not play. */
  readonly setupStones: { readonly black: number; readonly white: number }
  readonly moveCount: number
  readonly moveNumber: number
  /** The move recorded *at* this number (`moves[moveNumber - 1]`). Absent at move 0. */
  readonly moveAtNumber?: { readonly player: Player; readonly coord: Coord | null }
  /** The moves immediately before the position, oldest first, ≤ `RECENT_MOVE_LIMIT`. */
  readonly recentMoves: readonly {
    readonly number: number
    readonly player: Player
    readonly coord: Coord | null
  }[]
}

/**
 * Projects the position context for one move number of a record.
 *
 * Bounded by construction: at most `RECENT_MOVE_LIMIT` moves, counts instead
 * of coordinate lists for setup stones, and nothing after the queried
 * position — the moves a player had *not yet seen* are not evidence about the
 * move they played.
 */
export function positionAt(game: Game, moveNumber: number): PositionSummary {
  const at = game.moves[moveNumber - 1]
  const recentStart = Math.max(0, moveNumber - RECENT_MOVE_LIMIT)
  return {
    gameId: game.id,
    ...(game.meta.blackName === undefined ? {} : { blackName: game.meta.blackName }),
    ...(game.meta.whiteName === undefined ? {} : { whiteName: game.meta.whiteName }),
    boardSize: game.meta.boardSize,
    komi: game.meta.komi,
    playerToMove: playerToMoveAt(game, moveNumber),
    setupStones: {
      black: game.setup.black.length,
      white: game.setup.white.length,
    },
    moveCount: game.moves.length,
    moveNumber,
    ...(at === undefined
      ? {}
      : { moveAtNumber: { player: at.player, coord: at.coord } }),
    recentMoves: game.moves.slice(recentStart, moveNumber).map((move, index) => ({
      number: recentStart + index + 1,
      player: move.player,
      coord: move.coord,
    })),
  }
}

/**
 * What `search_library` filters on. All criteria are optional substrings.
 * `| undefined` is explicit because the zod-parsed args carry it: the tool's
 * schema output assigns `undefined` to absent keys under
 * `exactOptionalPropertyTypes`, and the criteria type must accept that shape
 * unchanged rather than make the call site strip keys.
 */
export interface LibrarySearchCriteria {
  readonly player?: string | undefined
  readonly event?: string | undefined
  readonly date?: string | undefined
}

export interface LibrarySearchResult {
  /** Matches before the cap, so the model knows when the list was cut short. */
  readonly matched: number
  readonly results: readonly GameSummary[]
}

/** Substring, case-insensitive. A criterion on an absent field never matches. */
function matchesField(value: string | undefined, needle: string): boolean {
  // `?.` yields `boolean | undefined` when the field is absent; comparing
  // against `true` makes "absent does not match" explicit rather than truthy.
  return value?.toLowerCase().includes(needle.toLowerCase()) === true
}

/**
 * Filters library summaries on metadata substrings.
 *
 * Criteria present are ANDed — "find Lee's 2023 games" means both, not either.
 * The player criterion matches *either* colour, because people remember who
 * played, not which stones they held. With no criteria at all every record
 * matches, which makes a criterion-less call mean "what is in the library",
 * answered in `list()`'s most-recent-first order.
 */
export function filterGames(
  summaries: readonly GameSummary[],
  criteria: LibrarySearchCriteria,
  limit: number = SEARCH_RESULT_LIMIT,
): LibrarySearchResult {
  const matching = summaries.filter((summary) => {
    const { player, event, date } = criteria
    if (player !== undefined) {
      const playerMatched =
        matchesField(summary.blackName, player) ||
        matchesField(summary.whiteName, player)
      if (!playerMatched) return false
    }
    if (event !== undefined && !matchesField(summary.event, event)) return false
    if (date !== undefined && !matchesField(summary.date, date)) return false
    return true
  })
  return { matched: matching.length, results: matching.slice(0, limit) }
}

/** The compact analysis summary `get_analysis` returns. Never an ownership tensor. */
export interface AnalysisSummary {
  readonly gameId: string
  readonly moveNumber: number
  /** Side to move: `winrate` is from this side's perspective (the contract's rule). */
  readonly player: Player
  readonly winrate: number
  /** Points, positive favours black — the shared contract's convention. */
  readonly scoreLead: number
  readonly visits: number
  readonly candidates: readonly {
    /** GTP string (`D4`, `pass`) — the form the teacher can quote to a human. */
    readonly move: string
    readonly winrate: number
    readonly scoreLead: number
    readonly visits: number
    readonly pv: readonly string[]
  }[]
  /**
   * Estimated net territory in points (positive favours black), summed over
   * the ownership tensor and rounded. A one-number summary is what a teacher
   * can use; the 361-value tensor is what it would cost to send anything more.
   */
  readonly ownershipNetPoints?: number
}

function describeCoord(coord: Coord | null, boardSize: BoardSize): string {
  return coord === null ? 'pass' : toGtp(coord, boardSize)
}

/**
 * Projects an analysis result onto what the teacher can quote.
 *
 * Candidates are ordered by the engine's own `order` rank before the cap,
 * because the wire makes no promise about array position — only `order` is the
 * rank, and "the top candidate" taken positionally would be whatever the
 * serialiser happened to emit first. Coordinates become GTP strings so the
 * model speaks the notation a human reads.
 */
export function summariseAnalysis(
  result: AnalysisResult,
  boardSize: BoardSize,
): AnalysisSummary {
  const ordered = [...result.candidates].sort((a, b) => a.order - b.order)
  return {
    gameId: result.gameId,
    moveNumber: result.moveNumber,
    player: result.player,
    winrate: result.winrate,
    scoreLead: result.scoreLead,
    visits: result.visits,
    candidates: ordered.slice(0, TOP_CANDIDATE_LIMIT).map((candidate) => ({
      move: describeCoord(candidate.coord, boardSize),
      winrate: candidate.winrate,
      scoreLead: candidate.scoreLead,
      visits: candidate.visits,
      pv: candidate.pv
        .slice(0, PV_LIMIT)
        .map((coord) => describeCoord(coord, boardSize)),
    })),
    ...(result.ownership === undefined
      ? {}
      : {
          ownershipNetPoints: Math.round(
            result.ownership.reduce((total, value) => total + value, 0),
          ),
        }),
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Shared by `get_position` and `get_analysis`: both address a position the same
 * way, and one schema is the single source of truth for that shape — a field
 * added to one and not the other is exactly the drift a second copy invites.
 */
const positionArgsSchema = z.object({
  /** Omitted: the game open when the message was sent. */
  gameId: z.string().min(1).optional(),
  moveNumber: z.number().int().min(0),
})

const getPositionTool = defineTool({
  name: 'get_position',
  description:
    'Read the position at a move number of a game in the library: players, the ' +
    'move played there, the few moves before it, setup (handicap) stones, and ' +
    'the side to move. Use it to ground statements about what happened in a ' +
    'record before analysing or criticising a move.',
  zodSchema: positionArgsSchema,
  execute: (args, ctx) => {
    const game = resolveGame(args.gameId, ctx)
    const moveNumber = checkMoveNumber(game, args.moveNumber)
    return { content: JSON.stringify(positionAt(game, moveNumber)), isError: false }
  },
})

const getAnalysisTool = defineTool({
  name: 'get_analysis',
  description:
    // Interpolated, not hardcoded: the description is the budget the model is
    // promised, and the constant is the budget the engine delivers. A second
    // copy of the number here is how the two drift apart.
    `Run a fresh KataGo analysis (${String(AGENT_QUERY_VISITS)} visits) of the position after ` +
    '`moveNumber` ' +
    'moves and quote the numbers: winrate (side to move), scoreLead (points, ' +
    'positive favours black), top candidate moves with principal variations, ' +
    "and a net-territory estimate. Runs independently of the user's live " +
    'analysis. Quote these numbers as returned — never extrapolate or ' +
    'interpolate between them.',
  zodSchema: positionArgsSchema,
  execute: async (args, ctx, signal) => {
    const game = resolveGame(args.gameId, ctx)
    const moveNumber = checkMoveNumber(game, args.moveNumber)
    const result = await ctx.engine.analyzeOnce(toEngineGame(game), moveNumber, signal)
    return {
      content: JSON.stringify(summariseAnalysis(result, game.meta.boardSize)),
      isError: false,
    }
  },
})

const searchLibraryTool = defineTool({
  name: 'search_library',
  description:
    'Search the imported game library by metadata substring: player name ' +
    '(either colour), event name, or date (a year matches the year of an ISO ' +
    'date). All criteria are optional and combined with AND; with none given ' +
    'it returns the most recently imported games. Returns compact summaries ' +
    'only.',
  zodSchema: z.object({
    player: z.string().min(1).optional(),
    event: z.string().min(1).optional(),
    date: z.string().min(1).optional(),
  }),
  execute: (args, ctx) => {
    const filtered = filterGames(ctx.store.list(), args)
    return { content: JSON.stringify(filtered), isError: false }
  },
})

/**
 * The student's profile as the teacher may quote it. The snapshot already
 * carries at most three weaknesses with at most three evidence rows each (the
 * core's own caps, mirrored by the shared schema), so the tool's job is only
 * to hand the derivation over verbatim — no summarising layer to drift from
 * the panel the student sees.
 */
const getProfileTool = defineTool({
  name: 'get_profile',
  description:
    "Read the student's weakness profile, derived from the analysis of their " +
    'own games: at most three weakness categories, each with a score (winrate ' +
    'points lost per recent game, exponentially weighted toward recent games), ' +
    'a trend, and up to three concrete evidence rows (game id and move number) ' +
    'you may cite. Quote these categories and numbers as returned — the ' +
    'categories are the app’s, not yours to invent.',
  zodSchema: z.object({}),
  execute: (_args, ctx) => {
    return { content: JSON.stringify(ctx.profile()), isError: false }
  },
})

/** The whole registry, in the order the model is offered it. */
export const AGENT_TOOLS: readonly AnyAgentTool[] = [
  getPositionTool,
  getAnalysisTool,
  searchLibraryTool,
  getProfileTool,
]

/**
 * Resolves the game a tool call addresses: the call's own `gameId`, else the
 * game open when the message was sent. Both absent is a readable error, not a
 * guess — a tool that silently picked "some game" would be a correctness
 * hazard dressed up as convenience.
 */
function resolveGame(gameId: string | undefined, ctx: ToolContext): Game {
  const id = gameId ?? ctx.gameId
  if (id === undefined) {
    throw new AppError(
      'LIBRARY_NOT_FOUND',
      'no game is open and no gameId was supplied — ask the user which game, ' +
        'or search the library first',
    )
  }
  const stored = ctx.store.get(id)
  if (stored === undefined) {
    throw new AppError(
      'LIBRARY_NOT_FOUND',
      `no game in the library has id ${bound(id)} — call search_library to list games`,
      { context: { gameId: bound(id) } },
    )
  }
  return stored.game
}

/**
 * The wire form of the registry: `ToolSchema` derived from each tool's zod
 * schema, so the JSON Schema can never disagree with the validation the
 * dispatch actually performs. The `$schema` key is stripped — the model pays
 * for those bytes on every request and no provider needs them.
 */
export function toolSchemas(): ToolSchema[] {
  return AGENT_TOOLS.map((tool) => {
    const jsonSchema: unknown = z.toJSONSchema(tool.zodSchema)
    const { $schema: _dropped, ...parameters } = jsonSchema as Record<string, unknown>
    return { name: tool.name, description: tool.description, parameters }
  })
}

function formatArgumentIssues(error: z.ZodError): string {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }))
  return `IPC_INVALID_REQUEST: invalid arguments ${JSON.stringify(issues)}`
}

/**
 * Reads the signal live. Necessary as a function boundary, not a style choice:
 * after the entry check above, TypeScript narrows `signal.aborted` to `false`
 * — property narrowing cannot see `abort()` firing on another stack — and
 * would report the catch-path cancellation branch as dead code. At runtime it
 * is the branch that fires.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Runs one tool call. See the module header for the never-throws contract and
 * its one exception.
 */
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  // A dead signal means the run is over — before the tool lookup, before
  // anything. Producing a result here would hand the model a reason to issue
  // another provider request on a signal that can only abort again.
  if (signal.aborted) {
    throw new AppError('LLM_ABORTED', 'the run was cancelled before the tool ran')
  }
  const tool = AGENT_TOOLS.find((candidate) => candidate.name === name)
  if (tool === undefined) {
    return {
      content:
        `IPC_INVALID_REQUEST: unknown tool ${bound(name)} — available tools: ` +
        AGENT_TOOLS.map((candidate) => candidate.name).join(', '),
      isError: true,
    }
  }

  const startedAtMs = Date.now()
  try {
    const outcome = await tool.execute(rawArgs, ctx, signal)
    logger.debug('tool executed', {
      tool: name,
      isError: outcome.isError,
      durationMs: Date.now() - startedAtMs,
    })
    return outcome
  } catch (error) {
    // Checked first: whatever else went wrong, a dead signal — or an error the
    // engine service already classified as cancellation — means the run is
    // over, and reporting that as a tool result would send the model straight
    // back to the provider with a signal that can only abort again.
    if (isAborted(signal) || (isAppError(error) && error.code === 'LLM_ABORTED')) {
      throw new AppError('LLM_ABORTED', 'the run was cancelled during tool execution')
    }
    if (error instanceof z.ZodError) {
      logger.debug('tool arguments rejected', {
        tool: name,
        issues: error.issues.length,
      })
      return { content: formatArgumentIssues(error), isError: true }
    }
    if (isAppError(error)) {
      // The code is the enumerable, safe part; the message was built by the
      // throwing module, which owns its content bounding.
      logger.debug('tool failed with a typed error', { tool: name, code: error.code })
      return { content: `${error.code}: ${error.message}`, isError: true }
    }
    // A non-typed throw is a bug. Log it with its cause here, in main, and
    // give the model an unremarkable failure it can move past.
    logger.failure('tool failed unexpectedly', error, { tool: name })
    return { content: 'the tool failed for an unexpected reason', isError: true }
  }
}
