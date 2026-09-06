import { beforeEach, describe, expect, it } from 'vitest'
import type { AnalysisResult } from '@gomentor/shared'
import { useAnalysisStore } from '../../src/renderer/src/state/analysisStore'

/**
 * `analysisStore` — routing and acceptance of `engine:analysis` results.
 *
 * ## Why this file exists (a Stage 3 verify note, discharged in Stage 4)
 *
 * Stage 3's gate noted the store's routing rules had no direct unit coverage —
 * they were exercised only incidentally through gameStore's drive tests. Stage
 * 4 adds the sweep tier on the same channel, which doubles the routing surface
 * (focus vs sweep prefix, then two different game-id filters) and makes the
 * gap load-bearing: a sweep tick landing in `focus` would paint the whole
 * board with a wrong-position result, and a focus tick accepted into `sweep`
 * would draw one cursor position's winrate as the whole game's curve.
 *
 * ## What is load-bearing here
 *
 * - prefix routing: `focus:` updates `focus`, `sweep:` updates `sweep`, and
 *   neither tier can write the other's slot;
 * - the sweep map is complete-only — a partial sweep tick means the contract
 *   changed, and painting it would show a mid-search value as settled;
 * - `sweepGameId` is the sweep's acceptance filter: a tick from a since-closed
 *   or since-re-branched record (same file, different branch suffix) finds no
 *   home, because `beginSweep` clears the map AND retargets the id together;
 * - the focus expectation `(gameId, moveNumber)` rejects a right game at the
 *   wrong cursor and a right cursor from the wrong game;
 * - `setExpectation` clears the accepted focus synchronously — the readout
 *   must drop the moment the cursor moves, not when the next tick arrives.
 */

function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    queryId: 'focus:1',
    gameId: 'g1',
    moveNumber: 0,
    player: 'black',
    winrate: 0.55,
    scoreLead: 1.5,
    visits: 100,
    candidates: [],
    complete: true,
    ...overrides,
  }
}

beforeEach(() => {
  useAnalysisStore.setState({
    status: { status: 'unavailable' },
    focus: null,
    focusGameId: null,
    focusMoveNumber: null,
    sweep: {},
    sweepGameId: null,
    showOwnership: false,
    hoveredCandidate: null,
  })
})

describe('focus routing and the expectation filter', () => {
  it('accepts a focus result matching the game and cursor', () => {
    const store = useAnalysisStore.getState()
    store.setExpectation('g1', 12)
    store.applyResult(result({ queryId: 'focus:1', gameId: 'g1', moveNumber: 12 }))

    const state = useAnalysisStore.getState()
    expect(state.focus?.queryId).toBe('focus:1')
    expect(state.sweep).toEqual({})
  })

  it('rejects a focus result for the right game at the wrong cursor', () => {
    const store = useAnalysisStore.getState()
    store.setExpectation('g1', 12)
    // A late tick for the position the cursor just left must not paint.
    store.applyResult(result({ queryId: 'focus:1', gameId: 'g1', moveNumber: 11 }))

    expect(useAnalysisStore.getState().focus).toBeNull()
  })

  it('rejects a focus result for the right cursor on a different game', () => {
    const store = useAnalysisStore.getState()
    store.setExpectation('g1', 12)
    store.applyResult(result({ queryId: 'focus:1', gameId: 'g2', moveNumber: 12 }))

    expect(useAnalysisStore.getState().focus).toBeNull()
  })

  it('accepts nothing when no expectation is set', () => {
    useAnalysisStore.getState().applyResult(result())

    expect(useAnalysisStore.getState().focus).toBeNull()
  })

  it('setExpectation clears the accepted focus immediately', () => {
    const store = useAnalysisStore.getState()
    store.setExpectation('g1', 12)
    store.applyResult(result({ queryId: 'focus:1', gameId: 'g1', moveNumber: 12 }))
    expect(useAnalysisStore.getState().focus).not.toBeNull()

    // The cursor moved: the held result describes a position the board no
    // longer shows, so it must drop now, not when the next tick lands.
    store.setExpectation('g1', 13)
    const state = useAnalysisStore.getState()
    expect(state.focus).toBeNull()
    expect(state.focusGameId).toBe('g1')
    expect(state.focusMoveNumber).toBe(13)
  })
})

describe('sweep routing and the game-id filter', () => {
  it('accepts a complete sweep tick for the sweep’s game at its move number', () => {
    const store = useAnalysisStore.getState()
    store.beginSweep('g1')
    store.applyResult(
      result({ queryId: 'sweep:7', gameId: 'g1', moveNumber: 7, winrate: 0.61 }),
    )

    const state = useAnalysisStore.getState()
    expect(state.sweep[7]).toEqual({ winrate: 0.61, scoreLead: 1.5 })
    // The sweep never touches the focus slot.
    expect(state.focus).toBeNull()
  })

  it('drops a partial sweep tick — the graph paints settled points only', () => {
    const store = useAnalysisStore.getState()
    store.beginSweep('g1')
    store.applyResult(
      result({ queryId: 'sweep:7', gameId: 'g1', moveNumber: 7, complete: false }),
    )

    expect(useAnalysisStore.getState().sweep).toEqual({})
  })

  it('drops a sweep tick from a different record, even at the same move number', () => {
    const store = useAnalysisStore.getState()
    store.beginSweep('g1')
    store.applyResult(result({ queryId: 'sweep:7', gameId: 'g2', moveNumber: 7 }))

    expect(useAnalysisStore.getState().sweep).toEqual({})
  })

  it('drops everything once the sweep is cleared (close)', () => {
    const store = useAnalysisStore.getState()
    store.beginSweep('g1')
    store.applyResult(result({ queryId: 'sweep:7', gameId: 'g1', moveNumber: 7 }))
    expect(useAnalysisStore.getState().sweep[7]).toBeDefined()

    store.beginSweep(null)
    const state = useAnalysisStore.getState()
    expect(state.sweep).toEqual({})
    expect(state.sweepGameId).toBeNull()
    // And late ticks for the old record now miss.
    store.applyResult(result({ queryId: 'sweep:8', gameId: 'g1', moveNumber: 8 }))
    expect(useAnalysisStore.getState().sweep).toEqual({})
  })

  it('a branch switch retargets the sweep: same file, suffixed id', () => {
    // gameStore drives beginSweep with the engine-correlation id, which
    // carries the ~v suffix on a variation. The bare-hash tick from the old
    // branch must miss even though the underlying file never changed.
    const store = useAnalysisStore.getState()
    store.beginSweep('hash~v1')
    store.applyResult(result({ queryId: 'sweep:3', gameId: 'hash', moveNumber: 3 }))
    expect(useAnalysisStore.getState().sweep).toEqual({})

    store.applyResult(result({ queryId: 'sweep:3', gameId: 'hash~v1', moveNumber: 3 }))
    expect(useAnalysisStore.getState().sweep[3]).toBeDefined()
  })

  it('later ticks for the same move replace the point (settled value)', () => {
    const store = useAnalysisStore.getState()
    store.beginSweep('g1')
    store.applyResult(
      result({ queryId: 'sweep:7', gameId: 'g1', moveNumber: 7, winrate: 0.5 }),
    )
    store.applyResult(
      result({ queryId: 'sweep:7', gameId: 'g1', moveNumber: 7, winrate: 0.7 }),
    )

    expect(useAnalysisStore.getState().sweep[7]?.winrate).toBe(0.7)
  })
})
