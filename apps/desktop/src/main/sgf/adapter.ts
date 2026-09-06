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
import { type SgfCollection, type SgfNode } from '@gomentor/core/sgf/ast'
import {
  AppError,
  type BoardSize,
  type BranchOption,
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
 * Walks the given line (the mainline, or the variation-selected line of
 * Stage 4's branch navigation) and collects setup placements until the first
 * move, rather than reading the root alone. That is not defensive generality —
 * the corpus requires it: `katago-foxlike.sgf` carries `;AB[pd][dp]` on the node
 * *after* the root, before any move, which a root-only read would drop, losing
 * both stones of a two-stone handicap game.
 *
 * Stops at the first move because that is what the corpus supports: measured
 * across all 44 fixtures, every mainline setup node occurs before move 1 (the
 * only mid-tree setup and all four `AE` nodes are inside variations). A file
 * that placed stones mid-mainline would have them silently omitted here, which
 * is why `gameSetupSchema` records that bound explicitly rather than implying
 * the general SGF model is covered.
 *
 * `AE` is deliberately not applied. It erases points, so honouring it needs an
 * ordered per-node model rather than an accumulated initial position — and no
 * corpus file needs it before move 1. Applying it approximately would be worse
 * than not applying it, because a wrong board looks authoritative.
 */
function toSetup(
  line: readonly SgfNode[],
  boardSize: GameMeta['boardSize'],
): GameSetup {
  const black: Coord[] = []
  const white: Coord[] = []

  for (const node of line) {
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
 * The moves of one line (the mainline, or a variation-selected line). Setup
 * stones (`AB`/`AW`) are **not** moves and are excluded: a handicap game's
 * placed stones are position, not play, and folding them into `moves` would
 * make move 1 belong to the wrong player and break every move-number label.
 * They are carried by `Game.setup` instead — see `toSetup`, which exists
 * because for one stage they were carried by nothing at all.
 *
 * Other variations branching off this line are not moves either; their
 * existence is reported separately through `Game.branches` (see
 * `collectBranches`), which is what keeps this projection the single place a
 * line becomes a record.
 */
function toMoves(line: readonly SgfNode[], boardSize: GameMeta['boardSize']): Move[] {
  const moves: Move[] = []
  for (const node of line) {
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

/**
 * Reads one alternative's own mainline (first child at each step): its first
 * move and its move count, leniently. Lenient because an alternative is
 * optional content — a corrupt vertex in a variation must not block opening
 * the record itself (the mainline stays strict and throws in `toMoves`). An
 * alternative with no usable move at all is not an alternative the picker can
 * offer; `branchAlternatives` filters those out and the caller is told.
 */
function alternativeSummary(
  node: SgfNode,
  boardSize: BoardSize,
): { first: Move['player'] | null; coord: Coord | null; count: number } {
  let count = 0
  let firstPlayer: Move['player'] | null = null
  let firstCoord: Coord | null = null
  let current: SgfNode | undefined = node
  while (current !== undefined) {
    let move: { player: Move['player']; coord: Coord | null } | null = null
    try {
      move = getMove(current, boardSize)
    } catch {
      move = null // corrupt alternative content — skip the node, keep walking
    }
    if (move !== null) {
      count += 1
      if (firstPlayer === null) {
        firstPlayer = move.player
        firstCoord = move.coord
      }
    }
    current = current.children[0]
  }
  return { first: firstPlayer, coord: firstCoord, count }
}

/**
 * The single definition of a **branch point** (a Stage 4 correction, recorded):
 * a node with at least two *usable* alternatives — children whose own mainline
 * carries at least one move. Both readers of the definition derive from this
 * helper, so they cannot drift:
 *
 * - `followLine` consumes one `variationPath` element at every branch point;
 * - `collectBranches` reports options at exactly the same nodes.
 *
 * The definition is usability-based, not `children.length`-based, because a
 * node whose extra children are move-less chains (setup-only, comment-only, or
 * corrupt — e.g. `ff4_ex`'s children 1 and 2) offers the renderer no choice:
 * no picker renders, so the renderer stores no path element for it. Had the
 * walk consumed an element there anyway, every element meant for a later real
 * branch point would be spent one node early and the re-parse would follow the
 * wrong child — a silent wrong line, measured with a setup-only alternative
 * before a real branch point (the adapter test suite carries the fixture).
 */
function branchAlternatives(
  node: SgfNode,
  boardSize: BoardSize,
): {
  readonly childIndex: number
  readonly child: SgfNode
  readonly summary: {
    readonly first: Move['player']
    readonly coord: Coord | null
    readonly count: number
  }
}[] {
  const offers: {
    childIndex: number
    child: SgfNode
    summary: { first: Move['player']; coord: Coord | null; count: number }
  }[] = []
  for (let childIndex = 0; childIndex < node.children.length; childIndex += 1) {
    const child = node.children[childIndex]
    if (child === undefined) continue
    const summary = alternativeSummary(child, boardSize)
    if (summary.first === null || summary.count < 1) continue
    // Guarded above: this summary's `first` is narrowed non-null here, and the
    // fresh literal keeps that narrow into the offer's type.
    offers.push({
      childIndex,
      child,
      summary: { first: summary.first, coord: summary.coord, count: summary.count },
    })
  }
  return offers
}

/**
 * Follows the line selected by a variation path: the mainline walk with a
 * branch choice applied at every branch point.
 *
 * ## The path semantics (the contract `sgf:parse` exposes)
 *
 * One element per branch point on the followed line, in walk order, where
 * "branch point" is exactly `branchAlternatives(node).length >= 2`; the value
 * is the **SGF child index** to follow (0 = the default first-child
 * continuation). A path shorter than the number of branch points means
 * "mainline everywhere not listed" — this is what lets the renderer store only
 * the deviations it actually chose and still round-trip: choosing a branch
 * replaces the element at that branch point's ordinal and truncates anything
 * deeper (the deeper elements were chosen on the old line and do not apply to
 * the new one). Extra elements are never consumed: the walk simply runs out of
 * branch points. An out-of-range index is a caller bug, not a file defect —
 * the renderer can only build indices from `branches` options the projection
 * itself offered — so it gets `IPC_INVALID_REQUEST`, and the message bounds
 * the values at the point of construction. The bound stays `node.children.
 * length` (not the usable-alternative count): a choice is an SGF child index,
 * and skipped move-less children are still addressable indices — `ff4_ex`
 * offers `[0, 3, 4]` of five.
 */
export function followLine(
  root: SgfNode,
  path: readonly number[],
  boardSize: BoardSize,
): SgfNode[] {
  const line: SgfNode[] = []
  let node = root
  let pathIndex = 0
  for (;;) {
    line.push(node)
    let childIndex = 0
    if (branchAlternatives(node, boardSize).length >= 2) {
      const chosen = path[pathIndex]
      pathIndex += 1
      childIndex = chosen ?? 0
      if (!Number.isInteger(childIndex) || childIndex >= node.children.length) {
        throw new AppError(
          'IPC_INVALID_REQUEST',
          'variation path selects a child that does not exist',
          {
            context: {
              branchPoint: pathIndex - 1,
              childIndex: Number.isInteger(childIndex) ? childIndex : null,
              children: node.children.length,
            },
          },
        )
      }
    }
    const next = node.children[childIndex]
    if (next === undefined) break
    node = next
  }
  return line
}

/**
 * Collects the branch options along a line, at exactly the nodes `followLine`
 * treats as branch points (`branchAlternatives(node).length >= 2` — the two
 * read one definition, so a choice the picker offers always round-trips),
 * indexed by arrival index: entry `c` holds the alternatives of the node
 * reached with `c` moves applied (the node the cursor sits on at position
 * `c`), present when that node is a branch point. Entry 0 is therefore the
 * options for the first move and a branch point after the record's last move
 * sits at index `moves.length`.
 *
 * Option `index` is the SGF child index: 0 is always the default (first-child)
 * continuation per SGF's mainline convention — even at an end-of-record branch
 * point, where "the mainline" simply continues into the first variation, which
 * is how the M1 mainline walk already treated it.
 */
function collectBranches(
  line: readonly SgfNode[],
  boardSize: BoardSize,
): BranchOption[][] {
  const branches: BranchOption[][] = []
  let applied = 0
  for (const node of line) {
    const hasMove = getMove(node, boardSize) !== null
    const index = applied + (hasMove ? 1 : 0)
    const offers = branchAlternatives(node, boardSize)
    if (offers.length >= 2) {
      const options: BranchOption[] = []
      for (const offer of offers) {
        const label = getComment(offer.child)
        options.push({
          index: offer.childIndex,
          player: offer.summary.first,
          coord: offer.summary.coord,
          moves: offer.summary.count,
          ...(label === undefined ? {} : { label }),
        })
      }
      branches[index] = options
    }
    if (hasMove) applied += 1
  }
  // Dense, not sparse: JSON has no array holes. A hole at index k would cross
  // IPC as `null` and need a hole-tolerant schema for nothing.
  for (let index = 0; index < branches.length; index += 1) {
    branches[index] ??= []
  }
  return branches
}

export interface ToGameOptions {
  id: string
  source: Game['source']
  /** ISO 8601. Passed in rather than stamped here so callers stay testable. */
  importedAt: string
  contentHash: string
  filePath?: string
  /**
   * Branch navigation (`design.md` §Branch navigation): the SGF child index to
   * follow at each branch point along the line. Absent/empty = the mainline.
   * See `followLine` for the exact semantics and the out-of-range error.
   */
  variationPath?: readonly number[]
}

/**
 * Projects the first root of a collection into a `Game`.
 *
 * Multi-game files (`roots.length > 1`) are common in problem collections. Only
 * the first is projected; the caller decides whether to split the rest into
 * separate library entries, because that is a library policy question rather
 * than a parsing one.
 *
 * ## One projection, two line selectors
 *
 * With no `variationPath` this is the M1 mainline projection. With one, the
 * same machinery walks the selected variation line — `followLine` is the only
 * difference, and `moves`/`setup`/`branches` are all read off the line it
 * returns, so a branch and the mainline can never drift apart in how they are
 * projected.
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
  const line = followLine(root, options.variationPath ?? [], meta.boardSize)
  return {
    id: options.id,
    meta,
    setup: toSetup(line, meta.boardSize),
    moves: toMoves(line, meta.boardSize),
    branches: collectBranches(line, meta.boardSize),
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
