import {
  encodeAnalysisRequest,
  encodeTerminateRequest,
  parseAnalysisResponse,
  type AnalysisQuery,
} from '@gomentor/core/katago/analysis'
import type { KataGoRuleset } from '@gomentor/core/katago/commands'
import {
  isAppError,
  FOCUS_QUERY_PREFIX,
  type AnalysisResult,
  type BoardSize,
  type EngineGame,
  type Player,
} from '@gomentor/shared'
import { scoped, type Logger } from '../logger'
import { createTickCoalescer, type TickCoalescer } from './coalesce'
import { normalizeAnalysisResult } from './perspective'
import {
  SWEEP_CONCURRENCY,
  SWEEP_MAX_VISITS,
  markSweepComplete,
  markSweepFailed,
  resumeFrom,
  sweepQueryId,
  type SweepLedger,
} from './sweep'

/**
 * The live analysis session: owns everything about *queries* on a running
 * engine — the record being analysed, focus-query issue/supersede, the
 * whole-record sweep, the cursor-stream debounce, result correlation,
 * coalesced emission, and the KataGo→contract perspective adaptation.
 *
 * The process layer (`process.ts`) owns bytes and exits; the service
 * (`service.ts`) owns lifecycle and status. This module owns meaning: which
 * query a stdout line answers, which query is worth an engine termination,
 * and what a result means once it arrives.
 *
 * ## Query-id namespacing is the routing contract
 *
 * Focus queries are `focus:<n>` with a per-session counter; sweep queries are
 * `sweep:<moveNumber>` (see `sweep.ts` for the ledger and the sweep's
 * semantics). The prefixes are shared constants (`@gomentor/shared`) — the
 * renderer routes `engine:analysis` by prefix without a schema change, and
 * `gameId` filters results from a since-closed game: a late tick for game A
 * must never paint over game B.
 *
 * ## Focus and sweep terminate independently (a Stage 4 decision)
 *
 * The two tiers share the process and the in-flight routing but nothing else.
 * A cursor move supersedes only the in-flight *focus* query — the sweep is
 * the whole record's background work and a cursor move says nothing about it.
 * Conversely, `setGame`/`clearGame` stop the sweep (its queries describe the
 * old record) but leave the focus machinery to its own paths. Sweep state
 * lives in its own driver object, so sweep entries live in their own
 * in-flight map: every entry has exactly one owner, and stopping the sweep
 * cannot touch focus bookkeeping.
 *
 * ## Terminate-on-supersede, and the reply that follows
 *
 * A new focus query terminates the prior in-flight one via the production
 * `encodeTerminateRequest`. KataGo's documented behaviour (Analysis_Engine.md,
 * fetched 2026-09-05): a terminated query still concludes with exactly one
 * final reply (`isDuringSearch: false`). So a terminated query stays in the
 * in-flight map (marked `terminated`) until that final reply arrives — it is
 * routed by id and dropped, never emitted. Dropping in *main* is the first
 * line of defence; the renderer's moveNumber filter is the second. Sweep
 * queries are different: their ids are reused per record (`sweep:<move>`), so
 * a stopped sweep drops its entries immediately — late final replies find no
 * entry and fall through the unknown-id path. The reasoning, and the residual
 * mis-route bound, are recorded in `sweep.ts`.
 *
 * ## In-flight reporting (the watchdog's input, a Stage 5 contract)
 *
 * The service's watchdog arms while the engine owes us a reply and disarms
 * when it owes nothing (`service.ts` §Watchdog). The session reports the
 * in-flight population through `onInFlightChange` after every mutation —
 * issue, completion, termination, malformed drop, sweep stop, dispose — so
 * the count the watchdog sees is always the count on the wire. Terminated
 * focus entries still count: the engine owes each exactly one final reply.
 * `terminateAllInFlight` is the watchdog's terminate-all: one production
 * terminate per in-flight id, cheap even against a hung engine, after which
 * the process layer's SIGKILL finishes what the protocol could not.
 *
 * ## The cursor debounce
 *
 * `setCursor` allocates the query id eagerly (so the response can name it),
 * then holds the position for `debounceMs` latest-wins: holding an arrow key
 * fires dozens of cursor steps, and each must not become an engine query.
 * When the timer fires, the last held position is sent under the id that was
 * allocated for it — the id the caller already holds. `setGame` is never
 * debounced: opening a record should analyse immediately.
 *
 * ## Why `handleLine` cannot throw
 *
 * It runs inside the process layer's stdout data handler; an exception there
 * would escape as an uncaughtException. Every failure mode — unparseable
 * bytes, a malformed result, a wrong-length ownership array — is caught,
 * logged with its typed `code`, and dropped. A bad tick never becomes a
 * render: the previous good result stays on screen.
 */

const logger = scoped('main:katago:session')

/** Default cursor-stream debounce (ms): design.md's ~50ms latest-wins. */
export const DEFAULT_CURSOR_DEBOUNCE_MS = 50
/**
 * Coalescing ceiling for `engine:analysis` (ms): the M1 streaming rule's
 * ~20/s. The engine reports every `reportDuringSearchEvery` seconds; the
 * research (`research/eigen-cpu-throughput.md`) puts that at 0.1–0.25s, which
 * this ceiling then flattens to a paintable 20/s.
 */
export const DEFAULT_COALESCE_INTERVAL_MS = 50
/**
 * How often the engine reports mid-search (seconds — the wire unit, verified
 * against `cpp/command/analysis.cpp`): 0.1s gives the UI a winrate that
 * animates toward its settled value while staying under the coalesce ceiling.
 */
export const REPORT_DURING_SEARCH_EVERY_S = 0.1

// ---------------------------------------------------------------------------
// Pure query construction (unit-tested and mutation-covered)
// ---------------------------------------------------------------------------

/**
 * The player to move at `moveNumber` in the record.
 *
 * Cursor N means N moves applied; the side to move is the player of the move
 * at index N (the next move to be played). At the end of the record it is the
 * opposite of the last move. With no moves at all, KataGo's analysis engine
 * picks White when handicap stones are on the board, Black otherwise
 * (`cpp/command/analysis.cpp`, `initialPlayer`, fetched 2026-09-05) — this
 * mirrors that so the `player` recorded on results matches what was analysed.
 */
export function playerToMoveAt(game: EngineGame, moveNumber: number): Player {
  if (moveNumber < game.moves.length) {
    const next = game.moves[moveNumber]
    if (next !== undefined) return next.player
  }
  const last = game.moves.at(-1)
  if (last !== undefined) return last.player === 'black' ? 'white' : 'black'
  return game.setup.black.length > 0 ? 'white' : 'black'
}

/**
 * Maps an SGF `RU` value onto a named KataGo ruleset. KataGo itself accepts
 * many spellings (`cpp/game/rules.cpp` `parseRulesHelper`, fetched 2026-09-05:
 * "japanese"/"korean", "chinese", "aga"/"bga"/"french", "nz"/"new zealand",
 * "tromp-taylor", …); this app sends only the five named in
 * `KATAGO_RULESETS` (`packages/core/src/katago/commands.ts`).
 *
 * Anything unrecognised — an absent RU, "GOE", custom rules — falls back to
 * `chinese`: area scoring, which is what `board/rules.ts` computes, so an
 * engine score and our score stay comparable. New Zealand rules (area scoring,
 * suicide legal) map to `chinese` too: our ruleset list has no NZ member, and
 * the legality difference only matters for suicide moves. Recorded, not
 * assumed, because a *silent* default is what this mapping must not be.
 */
export function toKataGoRuleset(rules: string): KataGoRuleset {
  const normalised = rules.trim().toLowerCase()
  if (normalised === 'japanese') return 'japanese'
  if (normalised === 'korean') return 'korean'
  if (normalised === 'aga' || normalised === 'bga' || normalised === 'french') {
    return 'aga'
  }
  if (normalised === 'tromp-taylor' || normalised === 'tromp taylor') {
    return 'tromp-taylor'
  }
  // "chinese" and every Chinese-region spelling KataGo knows, plus the
  // fallback for everything else — see the function comment.
  return 'chinese'
}

/**
 * Builds the focus query for one position of the held record.
 *
 * The moves array is the record *prefix* up to the cursor: moves beyond the
 * cursor are the future of the game, not the position under study, and
 * sending them would analyse the wrong board. Setup stones ride as
 * `initialStones` — position, not play — so a handicap game's parity is not
 * silently shifted (the M1 `setup` field exists precisely for this).
 */
export function buildFocusQuery(
  id: string,
  game: EngineGame,
  atMove: number,
  engine: { readonly maxVisits: number; readonly analyzeOwnership: boolean },
): AnalysisQuery {
  const moveNumber = Math.max(0, Math.min(Math.trunc(atMove), game.moves.length))
  return {
    id,
    boardSize: game.boardSize,
    komi: game.komi,
    rules: toKataGoRuleset(game.rules),
    moves: game.moves
      .slice(0, moveNumber)
      .map((move) => ({ player: move.player, coord: move.coord })),
    initialStones: [
      ...game.setup.black.map((coord) => ({ player: 'black' as const, coord })),
      ...game.setup.white.map((coord) => ({ player: 'white' as const, coord })),
    ],
    maxVisits: engine.maxVisits,
    includeOwnership: engine.analyzeOwnership,
    reportDuringSearchEvery: REPORT_DURING_SEARCH_EVERY_S,
  }
}

/**
 * Builds the sweep query for one position of the held record.
 *
 * Deliberately *not* a parameterised `buildFocusQuery`: the two tiers differ
 * in fixed ways, and spelling them out here is the mutation-covered record of
 * the sweep contract (`sweep.ts`): the fixed visit cap (not settings —
 * latency-critical on the core tier), **no ownership** (the graph never
 * paints it), and **no `reportDuringSearchEvery`** (only the complete tick
 * feeds the graph; streaming partials for sweep are noise and are dropped by
 * the session if an engine sends them anyway). Everything else — prefix
 * slicing, setup stones as `initialStones`, rules mapping — is the focus
 * machinery, reused rather than reimplemented.
 */
export function buildSweepQuery(
  id: string,
  game: EngineGame,
  atMove: number,
): AnalysisQuery {
  const moveNumber = Math.max(0, Math.min(Math.trunc(atMove), game.moves.length))
  return {
    id,
    boardSize: game.boardSize,
    komi: game.komi,
    rules: toKataGoRuleset(game.rules),
    moves: game.moves
      .slice(0, moveNumber)
      .map((move) => ({ player: move.player, coord: move.coord })),
    initialStones: [
      ...game.setup.black.map((coord) => ({ player: 'black' as const, coord })),
      ...game.setup.white.map((coord) => ({ player: 'white' as const, coord })),
    ],
    maxVisits: SWEEP_MAX_VISITS,
    includeOwnership: false,
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface InFlightFocus {
  readonly kind: 'focus'
  readonly id: string
  readonly gameId: string
  readonly moveNumber: number
  readonly player: Player
  readonly boardSize: BoardSize
  /**
   * True once a terminate has been sent for this id. The engine still owes
   * exactly one final reply for it; until that arrives the entry stays so the
   * reply can be recognised and dropped rather than misparsed as chatter.
   */
  terminated: boolean
  readonly coalescer: TickCoalescer<AnalysisResult>
}

interface InFlightSweep {
  readonly kind: 'sweep'
  readonly id: string
  readonly gameId: string
  readonly moveNumber: number
  readonly player: Player
  readonly boardSize: BoardSize
}

export interface AnalysisSessionOptions {
  /** Writes one framed request line to the engine's stdin. */
  readonly send: (line: string) => void
  /** Emits a coalesced focus result or a complete sweep result (the service forwards it as `engine:analysis`). */
  readonly onResult: (result: AnalysisResult) => void
  /** Visit cap and ownership toggle, read per query. */
  readonly settings: {
    readonly get: () => {
      readonly engine: {
        readonly maxVisits: number
        readonly analyzeOwnership: boolean
      }
    }
  }
  readonly logger?: Logger
  readonly debounceMs?: number
  readonly coalesceIntervalMs?: number
  /** Timer seam: returns a cancel function. Defaults to setTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void
  /**
   * Notified with the in-flight population (focus entries, terminated ones
   * included, plus sweep entries) after every mutation. The service arms its
   * watchdog on a non-zero count and disarms on zero.
   */
  readonly onInFlightChange?: (inFlight: number) => void
}

export interface AnalysisSession {
  /**
   * Holds the record and issues a focus query for `atMove` immediately.
   * Returns the focus query id.
   */
  setGame(game: EngineGame, atMove: number): string
  /** Drops the held record and terminates in-flight focus work. */
  clearGame(): void
  /**
   * Starts (or resumes) the whole-record sweep on the held record, issuing
   * from the ledger's first uncompleted move. Runs concurrently with focus;
   * cursor movement never touches it, and the ledger it reads is owned by the
   * caller so completion bookkeeping survives this session's disposal (see
   * `sweep.ts` §Ledger ownership).
   */
  startSweep(ledger: SweepLedger): void
  /**
   * Debounces a cursor move and returns the id the resulting focus query will
   * carry. The query is sent when the debounce fires unless superseded first.
   */
  setCursor(moveNumber: number): string
  /** Routes one framed stdout line. Never throws. */
  handleLine(line: string): void
  /**
   * The watchdog's terminate-all: one production `encodeTerminateRequest` per
   * in-flight id — focus entries (marked terminated, still awaiting their
   * mandated final reply) and sweep entries (dropped immediately, per the
   * sweep id-reuse rule). Cheap even against a hung engine; the kill that
   * follows is what actually frees a truly stuck child.
   */
  terminateAllInFlight(): void
  /** Focus entries (terminated ones included) plus sweep entries. */
  inFlightCount(): number
  /** Cancels timers and disposes coalescers. */
  dispose(): void
}

export function createAnalysisSession(
  options: AnalysisSessionOptions,
): AnalysisSession {
  const log = options.logger ?? logger
  const debounceMs = options.debounceMs ?? DEFAULT_CURSOR_DEBOUNCE_MS
  const coalesceIntervalMs = options.coalesceIntervalMs ?? DEFAULT_COALESCE_INTERVAL_MS
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms)
      return () => {
        clearTimeout(timer)
      }
    })

  /** The record under analysis; null once cleared. */
  let game: EngineGame | null = null
  /** Monotonic focus-query counter; the namespacing contract's `<n>`. */
  let focusCounter = 0
  /** The id whose results are currently worth emitting. */
  let currentFocusId: string | null = null
  let inFlight = new Map<string, InFlightFocus>()
  /** Held cursor position while the debounce timer runs, if any. */
  let heldCursor: { readonly moveNumber: number; readonly queryId: string } | null =
    null
  let cancelDebounce: (() => void) | null = null
  let disposed = false

  /**
   * The sweep driver. Lives separately from the focus state so the two tiers
   * terminate independently (the module header records the decision); entries
   * live in `inFlight`-style map of their own, so every in-flight entry has
   * exactly one owner.
   */
  let sweep: {
    readonly ledger: SweepLedger
    readonly game: EngineGame
    /** Next move to issue; starts at the ledger's resume point. */
    nextToIssue: number
    readonly inFlight: Map<string, InFlightSweep>
  } | null = null

  /**
   * The in-flight population the watchdog keys on. Focus entries count even
   * once terminated (the engine owes each exactly one final reply); sweep
   * entries count while they sit in the sweep driver's map.
   */
  function inFlightCount(): number {
    return inFlight.size + (sweep?.inFlight.size ?? 0)
  }

  /** Reports the population to the service after every mutation (see the interface). */
  function notifyInFlight(): void {
    if (disposed) return
    options.onInFlightChange?.(inFlightCount())
  }

  function makeCoalescer(): TickCoalescer<AnalysisResult> {
    return createTickCoalescer<AnalysisResult>({
      intervalMs: coalesceIntervalMs,
      isUrgent: (result) => result.complete,
      setTimer,
      onEmit: (result) => {
        // Only the current focus id may reach the renderer. Under the current
        // synchronous design this filter cannot actually fire — a reply for a
        // terminated id is dropped before it is ever offered (the terminated
        // check in `handleLine`), and terminating an entry disposes its
        // coalescer, which drops held ticks and cancels the flush timer. It
        // stays as the emission-time tripwire so a future async refactor of
        // either path cannot route a coalesced-but-stale tick to the
        // renderer: mutation M60 in `mutate-katago.mts` probed both this
        // filter and the earlier drop, and both mutants proved unreachable —
        // recorded here so nobody burns an afternoon re-deriving it.
        if (result.queryId === currentFocusId) options.onResult(result)
        else
          log.debug('dropping coalesced tick for stale query', {
            id: result.queryId,
          })
      },
    })
  }

  function cancelHeldCursor(): void {
    if (cancelDebounce !== null) {
      cancelDebounce()
      cancelDebounce = null
    }
    heldCursor = null
  }

  /** Sends a terminate for an in-flight focus query, if it is still owed one. */
  function terminateInFlight(entry: InFlightFocus): void {
    if (entry.terminated) return
    entry.terminated = true
    entry.coalescer.dispose()
    options.send(encodeTerminateRequest(entry.id))
  }

  function terminateCurrentFocus(): void {
    if (currentFocusId === null) return
    const entry = inFlight.get(currentFocusId)
    if (entry !== undefined) terminateInFlight(entry)
    currentFocusId = null
  }

  /**
   * Stops the sweep: optionally terminates its in-flight queries, then drops
   * the driver. Entries leave the map with it — a stopped sweep's late final
   * replies meet no entry and fall through the unknown-id path, which is
   * correct because sweep ids are reused per record (see `sweep.ts`).
   */
  function stopSweep(terminate: boolean): void {
    if (sweep === null) return
    if (terminate) {
      for (const entry of sweep.inFlight.values()) {
        options.send(encodeTerminateRequest(entry.id))
      }
    }
    sweep = null
    notifyInFlight()
  }

  /** Issues sweep queries until the concurrency window or the record is full. */
  function pumpSweep(): void {
    if (sweep === null || disposed) return
    while (
      sweep.inFlight.size < SWEEP_CONCURRENCY &&
      sweep.nextToIssue <= sweep.game.moves.length
    ) {
      const move = sweep.nextToIssue
      sweep.nextToIssue += 1
      // Completions can land out of order, so already-finished moves inside
      // the window are skipped rather than assumed sequential.
      if (sweep.ledger.completed.has(move) || sweep.ledger.failed.has(move)) continue
      const id = sweepQueryId(move)
      options.send(encodeAnalysisRequest(buildSweepQuery(id, sweep.game, move)))
      sweep.inFlight.set(id, {
        kind: 'sweep',
        id,
        gameId: sweep.game.gameId,
        moveNumber: move,
        player: playerToMoveAt(sweep.game, move),
        boardSize: sweep.game.boardSize,
      })
      log.debug('sweep query issued', { id, gameId: sweep.game.gameId, move })
    }
    notifyInFlight()
  }

  /** Builds, sends, and tracks a focus query under an already-allocated id. */
  function issueFocus(id: string, atMove: number): string {
    if (game === null) throw new Error('issueFocus with no game held')
    const moveNumber = Math.max(0, Math.min(Math.trunc(atMove), game.moves.length))
    const player = playerToMoveAt(game, moveNumber)
    const query = buildFocusQuery(id, game, moveNumber, options.settings.get().engine)

    terminateCurrentFocus()
    options.send(encodeAnalysisRequest(query))
    inFlight.set(id, {
      kind: 'focus',
      id,
      gameId: game.gameId,
      moveNumber,
      player,
      boardSize: game.boardSize,
      terminated: false,
      coalescer: makeCoalescer(),
    })
    currentFocusId = id
    notifyInFlight()
    log.debug('focus query issued', { id, gameId: game.gameId, moveNumber })
    return id
  }

  function nextFocusId(): string {
    focusCounter += 1
    return `${FOCUS_QUERY_PREFIX}${String(focusCounter)}`
  }

  return {
    setGame(next, atMove) {
      cancelHeldCursor()
      stopSweep(true)
      game = next
      return issueFocus(nextFocusId(), atMove)
    },

    clearGame() {
      cancelHeldCursor()
      stopSweep(true)
      terminateCurrentFocus()
      game = null
      log.debug('analysis game cleared')
    },

    startSweep(ledger) {
      if (game === null) {
        // The service guards this; reaching here is a contract violation by a
        // future caller, and an exception is the honest answer.
        throw new Error('startSweep with no game held')
      }
      stopSweep(true)
      sweep = {
        ledger,
        game,
        // `resumeFrom` is null when the ledger is already complete (the
        // engine crashed after the last tick landed). The sentinel past the
        // last move makes the pump's `nextToIssue <= moves.length` check
        // false instead of coercing null into a `sweep:null` query —
        // measured, not hypothetical: `null <= n` is true.
        nextToIssue: resumeFrom(ledger) ?? game.moves.length + 1,
        inFlight: new Map(),
      }
      pumpSweep()
    },

    setCursor(moveNumber) {
      if (game === null) {
        // The service guards this; reaching here is a contract violation by a
        // future caller, and an exception is the honest answer.
        throw new Error('setCursor with no game held')
      }
      const queryId = nextFocusId()
      heldCursor = { moveNumber, queryId }
      if (cancelDebounce !== null) cancelDebounce()
      cancelDebounce = setTimer(() => {
        cancelDebounce = null
        const held = heldCursor
        heldCursor = null
        if (held === null || game === null) return
        // Reuse the id allocated at schedule time — it is the id the caller
        // was given and the one the renderer correlates against.
        issueFocus(held.queryId, held.moveNumber)
      }, debounceMs)
      return queryId
    },

    handleLine(line) {
      if (disposed) return
      // Peek the wire id before the full parse: correlation context (gameId,
      // moveNumber, player, boardSize) lives in the in-flight entry, and we
      // must not invent it. Unknown ids — the probe's, replies for queries we
      // no longer track — fall through silently.
      let wireId: unknown
      try {
        const raw: unknown = JSON.parse(line)
        wireId =
          typeof raw === 'object' && raw !== null
            ? (raw as Record<string, unknown>)['id']
            : undefined
      } catch {
        log.debug('ignoring unparseable engine output', { length: line.length })
        return
      }
      if (typeof wireId !== 'string') return
      // Focus first (the hot path); sweep ids carry their own prefix so the
      // maps can never disagree about an id.
      const entry = inFlight.get(wireId) ?? sweep?.inFlight.get(wireId)
      if (entry === undefined) return

      let result: AnalysisResult
      try {
        result = parseAnalysisResponse(line, {
          gameId: entry.gameId,
          moveNumber: entry.moveNumber,
          player: entry.player,
          boardSize: entry.boardSize,
        })
      } catch (error) {
        // A malformed result — including the wrong-length ownership array
        // (B4) — is a typed failure here, never a render. The code rides the
        // AppError; the line itself is not logged (engine output can be long,
        // and this context reaches a log sink).
        if (isAppError(error)) {
          log.warn('analysis result rejected', {
            code: error.code,
            queryId: wireId,
            context: error.context,
          })
        } else {
          log.warn('analysis result rejected', { queryId: wireId })
        }
        if (entry.kind === 'focus') {
          if (entry.terminated) {
            inFlight.delete(wireId)
            notifyInFlight()
          }
        } else {
          // A malformed sweep response is rejected identically on retry, so
          // the move is recorded failed and never re-issued (`sweep.ts`).
          sweep?.inFlight.delete(wireId)
          notifyInFlight()
          if (sweep !== null) {
            markSweepFailed(sweep.ledger, entry.moveNumber)
            pumpSweep()
          }
        }
        return
      }

      if (entry.kind === 'sweep') {
        // Sweep is complete-only: partials describe a search the graph will
        // never show mid-flight, and emitting them would flood IPC for no
        // reader (`sweep.ts` §What the sweep is).
        if (!result.complete) {
          log.debug('dropping partial sweep tick', { id: wireId })
          return
        }
        const normalized = normalizeAnalysisResult(result, entry.player)
        options.onResult(normalized)
        // `sweep` cannot be null here — the entry was found in its map, and
        // the driver object is only replaced synchronously. The guard keeps
        // that an invariant of this function rather than an assumption.
        if (sweep === null) return
        sweep.inFlight.delete(wireId)
        markSweepComplete(sweep.ledger, entry.moveNumber)
        notifyInFlight()
        pumpSweep()
        return
      }

      if (entry.terminated) {
        // The mandated final reply for a terminated query: acknowledge and
        // forget. Never emitted — a terminated query is history.
        inFlight.delete(wireId)
        notifyInFlight()
        return
      }

      // The KataGo→contract adaptation happens in exactly one place, here,
      // after correlation and before coalescing/emission.
      const normalized = normalizeAnalysisResult(result, entry.player)
      entry.coalescer.offer(normalized)
      if (normalized.complete) {
        inFlight.delete(wireId)
        notifyInFlight()
      }
    },

    terminateAllInFlight() {
      for (const entry of inFlight.values()) {
        terminateInFlight(entry)
      }
      if (sweep !== null) {
        for (const entry of sweep.inFlight.values()) {
          options.send(encodeTerminateRequest(entry.id))
        }
        sweep.inFlight.clear()
      }
      notifyInFlight()
    },

    inFlightCount,

    dispose() {
      disposed = true
      cancelHeldCursor()
      // No terminates: the process this session talked to is going away (the
      // service disposes sessions only on shutdown/crash), and a send to a
      // dead stdin would throw inside the dispose path.
      stopSweep(false)
      for (const entry of inFlight.values()) entry.coalescer.dispose()
      inFlight = new Map()
      currentFocusId = null
      game = null
    },
  }
}
