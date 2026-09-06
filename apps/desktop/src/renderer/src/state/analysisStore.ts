import { create } from 'zustand'
import {
  FOCUS_QUERY_PREFIX,
  SWEEP_QUERY_PREFIX,
  type AnalysisResult,
  type EngineInfo,
} from '@gomentor/shared'

/**
 * Live analysis state mirrored from main.
 *
 * ## Inputs in stores, derivation in core
 *
 * `state-management.md`'s rule. The store holds the engine snapshot and the
 * newest focus result verbatim — everything the overlays render (candidate
 * markers, PV ghost stones, ownership fill, the winrate/score readout) is
 * *derived* from `focus` at render time, and a derived copy stored beside it
 * would be a second thing that can disagree.
 *
 * ## Routing and the two stale-result filters
 *
 * Main already drops ticks for terminated/superseded query ids; this store is
 * the second line of defence, and it filters on what it can see:
 *
 * - `queryId` prefix — `focus:` results update `focus`; `sweep:` results
 *   update `sweep`. The two tiers never cross.
 * - `focusGameId`/`focusMoveNumber` — a focus result is accepted only if it
 *   describes the game and cursor the board currently shows. Main namespaces
 *   ids per session, but this store cannot know main's session state; a
 *   result for move 30 must never paint while the cursor sits at 12. The
 *   gameStore sets the expectation on every open/seek/step.
 * - `sweepGameId` — a sweep result is accepted only for the record whose
 *   sweep is live. Set by gameStore when it drives the engine, so a late
 *   complete tick from a since-closed (or since-re-branched) record finds no
 *   home: the winrate graph never mixes two records' curves.
 *
 * ## The sweep map holds complete ticks only
 *
 * Main emits a sweep result exactly once per position — when the query
 * completes (`sweep.ts` §What the sweep is) — so no coalescing or
 * latest-wins is needed here; each entry is that position's settled
 * `{winrate, scoreLead}`. Both ride in the map because the graph's tooltip
 * can show the score lead beside the winrate without a second lookup.
 *
 * ## What this store deliberately does not hold
 *
 * The game record and the cursor — those are gameStore's inputs, and
 * duplicating them here is the "two sources of truth" mistake the spec calls
 * out. The expectation fields below are *analysis-scoped* correlation keys,
 * not a copy of game state.
 */

/** One settled sweep point, black-perspective like every other result. */
export interface SweepPoint {
  readonly winrate: number
  readonly scoreLead: number
}

interface AnalysisState {
  /** Engine lifecycle snapshot, written by `engine:status`. */
  status: EngineInfo
  /** The newest focus result matching the current game + cursor, if any. */
  focus: AnalysisResult | null
  /**
   * The gameId/moveNumber a focus result must carry to be accepted. Set by
   * gameStore when it drives the engine; null expectation accepts nothing.
   */
  focusGameId: string | null
  focusMoveNumber: number | null
  /**
   * Sweep points by move number, accepted only when `gameId` matches
   * `sweepGameId`. Plain record (not a Map) so zustand updates stay
   * structural-sharing friendly; at ≤361 entries the copy is noise.
   */
  sweep: Record<number, SweepPoint>
  /** The engine-game id whose sweep results may land; null clears the graph. */
  sweepGameId: string | null
  /** Ownership overlay toggle (UI state). */
  showOwnership: boolean
  /** Hovered candidate index into `focus.candidates`, or null. */
  hoveredCandidate: number | null

  /** Seed/refresh the snapshot (the `engine:info` response). */
  applyStatus: (info: EngineInfo) => void
  /** Feed from `engine:analysis`; routes by prefix and filters by game id. */
  applyResult: (result: AnalysisResult) => void
  /** Set the acceptance filter, e.g. when the cursor moves. */
  setExpectation: (gameId: string | null, moveNumber: number | null) => void
  /**
   * Name the record whose sweep may land, clearing the previous map. Called
   * with the same engine-game id a branch switch would change: the suffix is
   * part of the id (`gameStore`), so a re-branched record's late ticks miss
   * the filter even though the underlying file hash is unchanged.
   */
  beginSweep: (gameId: string | null) => void
  toggleOwnership: () => void
  setHoveredCandidate: (index: number | null) => void
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
  status: { status: 'unavailable' },
  focus: null,
  focusGameId: null,
  focusMoveNumber: null,
  sweep: {},
  sweepGameId: null,
  showOwnership: false,
  hoveredCandidate: null,

  applyStatus: (info) => {
    set({ status: info })
  },

  applyResult: (result) => {
    if (result.queryId.startsWith(FOCUS_QUERY_PREFIX)) {
      set((state) => {
        if (
          state.focusGameId === null ||
          result.gameId !== state.focusGameId ||
          result.moveNumber !== state.focusMoveNumber
        ) {
          return {}
        }
        return { focus: result }
      })
      return
    }
    if (result.queryId.startsWith(SWEEP_QUERY_PREFIX)) {
      // Sweep ticks are complete-only from main; a partial here would mean
      // the contract changed — drop it rather than paint a mid-search value
      // as settled.
      if (!result.complete) return
      set((state) => {
        if (state.sweepGameId === null || result.gameId !== state.sweepGameId) {
          return {}
        }
        return {
          sweep: {
            ...state.sweep,
            [result.moveNumber]: {
              winrate: result.winrate,
              scoreLead: result.scoreLead,
            },
          },
        }
      })
    }
  },

  setExpectation: (gameId, moveNumber) => {
    // A cursor move invalidates the accepted focus immediately: the board now
    // shows a position the held result does not describe, and keeping it on
    // screen until the next tick would paint stale candidates/ownership.
    set({ focusGameId: gameId, focusMoveNumber: moveNumber, focus: null })
  },

  beginSweep: (gameId) => {
    set(
      gameId === null
        ? { sweep: {}, sweepGameId: null }
        : { sweep: {}, sweepGameId: gameId },
    )
  },

  toggleOwnership: () => {
    set((state) => ({ showOwnership: !state.showOwnership }))
  },

  setHoveredCandidate: (index) => {
    set({ hoveredCandidate: index })
  },
}))
