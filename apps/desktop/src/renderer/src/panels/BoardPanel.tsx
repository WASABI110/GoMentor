import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { Coord } from '@gomentor/shared'
import { positionAt, useGameStore } from '../state/gameStore'
import { ErrorNotice } from '../components/ErrorNotice'
import { Board } from '../components/Board'
import { MoveTree } from '../components/MoveTree'
import { EngineStatus } from '../components/EngineStatus'

/**
 * The board panel: navigation, and the rendered board it describes.
 *
 * The position is derived from `(game, cursor)` on every render, so the canvas has
 * a single source to draw and no cache of its own to fall out of step. The stone
 * counts below are that derivation made visible, which is also what lets an e2e
 * spec assert navigation without reading pixels.
 *
 * ## Clicking the board does not place a stone in M1
 *
 * A3/A4 are about reviewing an imported game, not playing a new one. Clicking an
 * intersection in M1 only sets the hover ghost; the move tree (M2) will turn clicks
 * into moves.
 */
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

  const [hover, setHover] = useState<Coord | null>(null)

  // Subscribed to `game` and `cursor` above, so this recomputes exactly when one
  // of them changes and never holds a stale copy. `replay` of a 300-move record
  // measures well under 5ms (`packages/core/src/board/position.ts`), which is why
  // deriving per render is affordable and memoising it would be premature.
  const replayed = positionAt({ game, cursor })

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

          <Board
            size={game.meta.boardSize}
            position={replayed.position}
            lastMove={replayed.lastMove}
            captured={replayed.captured}
            hover={hover}
            onHover={setHover}
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
          />
        </>
      )}

      <EngineStatus />
    </main>
  )
}
