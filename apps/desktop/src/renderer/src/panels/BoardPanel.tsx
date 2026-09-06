import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Coord } from '@gomentor/shared'
import { positionAt, branchStateAt, useGameStore } from '../state/gameStore'
import { useAnalysisStore } from '../state/analysisStore'
import { ErrorNotice } from '../components/ErrorNotice'
import { Board, type CandidateMarker, type PvGhost } from '../components/Board'
import { MoveTree } from '../components/MoveTree'
import { WinrateGraph } from '../components/WinrateGraph'
import { EngineStatus } from '../components/EngineStatus'

/**
 * The board panel: navigation, the rendered board it describes, and the live
 * analysis readout.
 *
 * The position is derived from `(game, cursor)` on every render, so the canvas has
 * a single source to draw and no cache of its own to fall out of step. The stone
 * counts below are that derivation made visible, which is also what lets an e2e
 * spec assert navigation without reading pixels.
 *
 * ## Everything the overlays show is derived here, never stored
 *
 * `state-management.md`'s rule, applied to analysis: `analysisStore` holds the
 * newest focus result verbatim; the candidate letters, their alphas (∝ winrate,
 * floored so even a 0% suggestion stays visible), the hovered candidate's PV
 * ghosts (colour parity from the side to move — PV[0] is that side's move), and
 * the ownership array are computed at render from it. A derived copy stored
 * beside `focus` would be a second thing that can disagree with the result it
 * came from.
 *
 * ## Clicking the board does not place a stone in M1
 *
 * A3/A4 are about reviewing an imported game, not playing a new one. Clicking an
 * intersection in M1 only sets the hover ghost; the move tree (M2) will turn clicks
 * into moves.
 */

/** Lowest marker alpha — a candidate the engine gives no chance still shows. */
const CANDIDATE_ALPHA_FLOOR = 0.35
/** How far along a variation the ghost stones run before they crowd the board. */
const PV_MAX_STONES = 12
/** At most the five best candidates wear letters. */
const MAX_LETTERED_CANDIDATES = 5

const NO_MARKERS: readonly CandidateMarker[] = []
const NO_GHOSTS: readonly PvGhost[] = []

/** Points, with an explicit + for a black lead — the contract is black-positive. */
function formatScoreLead(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`
}

export function BoardPanel(): React.JSX.Element {
  const { t } = useTranslation(['board', 'common', 'analysis'])
  const game = useGameStore((state) => state.game)
  const cursor = useGameStore((state) => state.cursor)
  const loading = useGameStore((state) => state.loading)
  const error = useGameStore((state) => state.error)
  const seekToStart = useGameStore((state) => state.toStart)
  const stepBackward = useGameStore((state) => state.stepBackward)
  const stepForward = useGameStore((state) => state.stepForward)
  const seekToEnd = useGameStore((state) => state.toEnd)
  const seek = useGameStore((state) => state.seek)
  const chooseBranch = useGameStore((state) => state.chooseBranch)

  const focus = useAnalysisStore((state) => state.focus)
  const sweep = useAnalysisStore((state) => state.sweep)
  const showOwnership = useAnalysisStore((state) => state.showOwnership)
  const toggleOwnership = useAnalysisStore((state) => state.toggleOwnership)
  const hoveredCandidate = useAnalysisStore((state) => state.hoveredCandidate)
  const setHoveredCandidate = useAnalysisStore((state) => state.setHoveredCandidate)

  const [hover, setHover] = useState<Coord | null>(null)

  // Subscribed to `game` and `cursor` above, so this recomputes exactly when one
  // of them changes and never holds a stale copy. `replay` of a 300-move record
  // measures well under 5ms (`packages/core/src/board/position.ts`), which is why
  // deriving per render is affordable and memoising it would be premature.
  const replayed = positionAt({ game, cursor })

  // Letters A–E for the five best candidates, alpha ∝ winrate with a floor. A
  // pass suggestion (coord null) has no point to mark and is skipped.
  const candidateMarkers = useMemo(() => {
    if (focus === null) return NO_MARKERS
    const markers: CandidateMarker[] = []
    const count = Math.min(focus.candidates.length, MAX_LETTERED_CANDIDATES)
    for (let index = 0; index < count; index += 1) {
      const candidate = focus.candidates[index]
      if (candidate === undefined) continue
      const coord = candidate.coord
      if (coord === null) continue // a pass suggestion has no point to mark
      markers.push({
        coord,
        label: String.fromCharCode(65 + index),
        alpha: CANDIDATE_ALPHA_FLOOR + (1 - CANDIDATE_ALPHA_FLOOR) * candidate.winrate,
      })
    }
    return markers
  }, [focus])

  // The hovered candidate's principal variation as numbered ghost stones. The
  // side to move plays PV[0], the opponent PV[1], and so on — the parity is the
  // engine's, derived from `focus.player`, not from the position on the board.
  const pvGhosts = useMemo(() => {
    if (focus === null || hoveredCandidate === null) return NO_GHOSTS
    const candidate = focus.candidates[hoveredCandidate]
    if (candidate === undefined) return NO_GHOSTS
    const ghosts: PvGhost[] = []
    const count = Math.min(candidate.pv.length, PV_MAX_STONES)
    for (let index = 0; index < count; index += 1) {
      const coord = candidate.pv[index]
      if (coord === null || coord === undefined) continue // a pass, or past the end
      ghosts.push({
        coord,
        index: index + 1,
        player:
          index % 2 === 0 ? focus.player : focus.player === 'black' ? 'white' : 'black',
      })
    }
    return ghosts
  }, [focus, hoveredCandidate])

  // Hovering an intersection is both the move ghost and the candidate pick: the
  // same event answers "is there a suggestion here" so the PV overlay tracks the
  // cursor without a second listener on the canvas.
  const handleHover = useCallback(
    (coord: Coord | null) => {
      setHover(coord)
      if (coord === null || focus === null) {
        setHoveredCandidate(null)
        return
      }
      const index = focus.candidates.findIndex(
        (candidate) =>
          candidate.coord !== null &&
          candidate.coord.x === coord.x &&
          candidate.coord.y === coord.y,
      )
      setHoveredCandidate(index === -1 ? null : index)
    },
    [focus, setHoveredCandidate],
  )

  // Derived, not stored: the picker's options and the followed child index are
  // a pure function of (game.branches, variationPath, cursor).
  const branch = useMemo(
    () => (game === null ? null : branchStateAt(game, cursor)),
    [game, cursor],
  )

  if (error !== null) {
    return (
      <main className="panel panel--board" data-testid="board-panel">
        <h2>{t('board:title')}</h2>
        <ErrorNotice error={error} />
      </main>
    )
  }

  return (
    <main className="panel panel--board" data-testid="board-panel">
      <h2>{t('board:title')}</h2>

      {game === null || replayed === null ? (
        <p className="placeholder" data-testid="board-empty">
          {loading ? t('common:loading') : t('board:empty')}
        </p>
      ) : (
        <>
          <p className="board-move" data-testid="board-move">
            {t('board:moveNumber', { n: cursor })}
          </p>
          <p className="board-captures" data-testid="board-captures">
            {/*
              `position.captures` — the running prisoner totals — not
              `replayed.captured`, which is the `Coord[]` the *last* move took and
              exists for the capture animation. Reading the latter here would show
              "0 captured" on every move after a capture, which looks like a rules
              bug and is not one.
            */}
            {t('board:capturesBy', {
              count: replayed.position.captures.black,
              color: t('board:black'),
            })}
            {' · '}
            {t('board:capturesBy', {
              count: replayed.position.captures.white,
              color: t('board:white'),
            })}
          </p>
          {replayed.lastMove === null && cursor > 0 && (
            <p className="board-pass" data-testid="board-pass">
              {t('board:pass')}
            </p>
          )}

          <div className="analysis-bar" data-testid="analysis-bar">
            {focus === null ? (
              <span className="analysis-bar__empty" data-testid="analysis-empty">
                {t('analysis:empty')}
              </span>
            ) : (
              <>
                <span data-testid="analysis-winrate">
                  {t('analysis:winrate')} {(focus.winrate * 100).toFixed(1)}%
                </span>
                <span data-testid="analysis-score-lead">
                  {t('analysis:scoreLead')} {formatScoreLead(focus.scoreLead)}
                </span>
                <span data-testid="analysis-to-move">
                  {t('board:toPlay', {
                    color: t(focus.player === 'black' ? 'board:black' : 'board:white'),
                  })}
                </span>
                <span data-testid="analysis-visits">
                  {t('analysis:visits')} {focus.visits}
                </span>
              </>
            )}
            <button
              type="button"
              className="analysis-bar__ownership-toggle"
              data-testid="ownership-toggle"
              aria-pressed={showOwnership}
              disabled={focus?.ownership === undefined}
              onClick={toggleOwnership}
            >
              {t('analysis:ownership')}
            </button>
          </div>

          <Board
            size={game.meta.boardSize}
            position={replayed.position}
            lastMove={replayed.lastMove}
            captured={replayed.captured}
            hover={hover}
            candidates={candidateMarkers}
            pv={pvGhosts}
            ownership={showOwnership ? (focus?.ownership ?? null) : null}
            onHover={handleHover}
            showCoordinates
            animationsEnabled
          />

          <MoveTree
            cursor={cursor}
            total={game.moves.length}
            onFirst={seekToStart}
            onPrevious={stepBackward}
            onNext={stepForward}
            onLast={seekToEnd}
            branch={branch}
            onChooseBranch={(childIndex) => {
              void chooseBranch(cursor, childIndex)
            }}
          />

          <WinrateGraph
            sweep={sweep}
            total={game.moves.length}
            cursor={cursor}
            onSeek={seek}
          />
        </>
      )}

      <EngineStatus />
    </main>
  )
}
