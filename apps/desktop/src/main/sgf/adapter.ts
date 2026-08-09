import { createHash } from 'node:crypto'
import {
  getBoardSize,
  getComment,
  getDate,
  getEvent,
  getHandicap,
  getKomi,
  getMove,
  getPlace,
  getPlayerName,
  getPlayerRank,
  getResult,
  getRuleset,
  getSetup,
} from '@gomentor/core/sgf/props'
import { mainline, type SgfCollection, type SgfNode } from '@gomentor/core/sgf/ast'
import {
  AppError,
  type Coord,
  type Game,
  type GameMeta,
  type GameSetup,
  type GameSummary,
  type Move,
} from '@gomentor/shared'

/**
 * Adapter between the SGF AST and the IPC `Game` contract.
 *
 * ## Why this lives in main rather than in core
 *
 * `Game` is an IPC payload shape: flat mainline moves, a content hash for
 * dedupe, an import timestamp. The AST is the full tree with variations,
 * per-property whitespace, and raw undecoded values. Neither is derivable from
 * the other without loss, and that is deliberate — they answer different
 * questions.
 *
 * Putting the conversion in `packages/core` would make the pure domain layer
 * depend on the transport contract, so a change to an IPC payload would ripple
 * into a package that has nothing to do with IPC. Putting it in a handler would
 * duplicate it across `sgf:parse` and `library:import`, which both need it.
 *
 * ## The AST is not thrown away
 *
 * `Game` is lossy by construction: it has no variations and no unknown
 * properties, so a round-trip through it would violate A5. The collection is
 * therefore retained by the caller (`library.handlers.ts` keeps it beside the
 * `Game`), and `sgf:serialize` writes from the **AST**, never from the `Game`.
 * If a future handler is tempted to reconstruct SGF from `Game.moves`, that is
 * the bug this paragraph exists to prevent.
 */

/**
 * Content hash over the original bytes, used for import dedupe.
 *
 * Hashed over the **source**, not over the parsed `Game`. Two files that differ
 * only in a comment or an editor-specific property are genuinely different files
 * a user may want both of, and hashing the lossy projection would silently
 * discard one of them as a duplicate. sha256 truncated to 16 bytes: this is a
 * dedupe key, not a security boundary, and a full digest makes log lines and
 * database rows wider for no benefit.
 */
export function contentHash(source: Uint8Array | string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 32)
}

function toMeta(root: SgfNode): GameMeta {
  // `getBoardSize` throws `SGF_UNSUPPORTED_BOARD_SIZE` for sizes the app does
  // not render. Not caught here: a 21×21 file cannot be shown, and returning a
  // default would put a wrong board in front of the user.
  const boardSize = getBoardSize(root)

  // Every field below is `undefined` when absent, and `GameMeta` has them
  // optional — expected absence is a state, not an exception
  // (`error-handling.md`). Conditional spreads rather than assigning
  // `undefined`, because `exactOptionalPropertyTypes` distinguishes an absent
  // key from a present-but-undefined one.
  const komi = getKomi(root)
  const handicap = getHandicap(root)
  const blackName = getPlayerName(root, 'black')
  const whiteName = getPlayerName(root, 'white')
  const blackRank = getPlayerRank(root, 'black')
  const whiteRank = getPlayerRank(root, 'white')
  const date = getDate(root)
  const event = getEvent(root)
  const place = getPlace(root)
  const result = getResult(root)
  const ruleset = getRuleset(root)

  return {
    boardSize,
    // Schema defaults exist for these two, but applying them here keeps the
    // return type total rather than relying on a later `.parse()` to fill them.
    handicap: handicap ?? 0,
    komi: komi ?? 6.5,
    ...(blackName === undefined ? {} : { blackName }),
    ...(whiteName === undefined ? {} : { whiteName }),
    ...(blackRank === undefined ? {} : { blackRank }),
    ...(whiteRank === undefined ? {} : { whiteRank }),
    ...(date === undefined ? {} : { date }),
    ...(event === undefined ? {} : { event }),
    ...(place === undefined ? {} : { place }),
    ...(result === undefined ? {} : { result }),
    ...(ruleset === undefined ? {} : { ruleset }),
  }
}

/**
 * Stones on the board before move 1.
 *
 * Walks the mainline and collects setup placements until the first move, rather
 * than reading the root alone. That is not defensive generality — the corpus
 * requires it: `katago-foxlike.sgf` carries `;AB[pd][dp]` on the node *after* the
 * root, before any move, which a root-only read would drop, losing both stones
 * of a two-stone handicap game.
 *
 * Stops at the first move because that is what the corpus supports: measured
 * across all 44 fixtures, every mainline setup node occurs before move 1 (the
 * only mid-tree setup and all four `AE` nodes are inside variations). A file that
 * placed stones mid-mainline would have them silently omitted here, which is why
 * `gameSetupSchema` records that bound explicitly rather than implying the
 * general SGF model is covered.
 *
 * `AE` is deliberately not applied. It erases points, so honouring it needs an
 * ordered per-node model rather than an accumulated initial position — and no
 * corpus file needs it before move 1. Applying it approximately would be worse
 * than not applying it, because a wrong board looks authoritative.
 */
function toSetup(root: SgfNode, boardSize: GameMeta['boardSize']): GameSetup {
  const black: Coord[] = []
  const white: Coord[] = []

  for (const node of mainline(root)) {
    // A node may carry both setup stones and a move (SGF permits it). Setup is
    // read first so such a node contributes its stones before the loop ends.
    const setup = getSetup(node, boardSize)
    black.push(...setup.black)
    white.push(...setup.white)

    if (getMove(node, boardSize) !== null) break
  }

  return { black, white }
}

/**
 * Mainline moves only. Variations are reachable through the AST, which the
 * caller keeps — see the note above about `Game` being lossy on purpose.
 *
 * Setup stones (`AB`/`AW`) are **not** moves and are excluded: a handicap game's
 * placed stones are position, not play, and folding them into `moves` would make
 * move 1 belong to the wrong player and break every move-number label. They are
 * carried by `Game.setup` instead — see `toSetup`, which exists because for one
 * stage they were carried by nothing at all.
 */
function toMoves(root: SgfNode, boardSize: GameMeta['boardSize']): Move[] {
  const moves: Move[] = []
  for (const node of mainline(root)) {
    const move = getMove(node, boardSize)
    if (move === null) continue
    // `number` is 1-based and counts *moves*, not nodes — the root node and any
    // setup-only node carries none, so it cannot be derived from a node index.
    // Deriving it from `moves.length` is what keeps it contiguous.
    const comment = getComment(node)
    moves.push({
      number: moves.length + 1,
      player: move.player,
      // `null` is a pass, kept out of the coord type so it cannot be confused
      // with (0,0) — the contract's own reasoning, preserved here.
      coord: move.coord,
      ...(comment === undefined ? {} : { comment }),
    })
  }
  return moves
}

export interface ToGameOptions {
  id: string
  source: Game['source']
  /** ISO 8601. Passed in rather than stamped here so callers stay testable. */
  importedAt: string
  contentHash: string
  filePath?: string
}

/**
 * Projects the first root of a collection into a `Game`.
 *
 * Multi-game files (`roots.length > 1`) are common in problem collections. Only
 * the first is projected; the caller decides whether to split the rest into
 * separate library entries, because that is a library policy question rather
 * than a parsing one.
 */
export function toGame(collection: SgfCollection, options: ToGameOptions): Game {
  const root = collection.roots[0]
  if (root === undefined) {
    // A collection with no roots is not something the parser produces for valid
    // input, so this is a contract violation rather than a malformed file — but
    // it still gets a code rather than a bare throw.
    throw new AppError('SGF_NOT_SGF', 'the file contains no game tree')
  }

  const meta = toMeta(root)
  return {
    id: options.id,
    meta,
    setup: toSetup(root, meta.boardSize),
    moves: toMoves(root, meta.boardSize),
    source: options.source,
    contentHash: options.contentHash,
    importedAt: options.importedAt,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
  }
}

/**
 * Summary row for the library list. Derived from a `Game` rather than from the
 * AST so the two can never disagree about move count — the list showing 178 and
 * the board showing 177 is exactly the kind of drift a second traversal invites.
 */
export function toSummary(game: Game): GameSummary {
  return {
    id: game.id,
    moveCount: game.moves.length,
    boardSize: game.meta.boardSize,
    source: game.source,
    ...(game.meta.blackName === undefined ? {} : { blackName: game.meta.blackName }),
    ...(game.meta.whiteName === undefined ? {} : { whiteName: game.meta.whiteName }),
    ...(game.meta.date === undefined ? {} : { date: game.meta.date }),
    ...(game.meta.result === undefined ? {} : { result: game.meta.result }),
  }
}
