import { useTranslation } from 'react-i18next'
import { positionAt, useGameStore } from '../state/gameStore'
import { ErrorNotice } from '../components/ErrorNotice'

/**
 * The board panel: navigation, and the derived position it describes.
 *
 * ## No canvas yet, deliberately
 *
 * `Board.tsx` — two canvases, DPR-aware, cancellable animations — is its own piece
 * of work with its own acceptance criteria (A3, against reference positions at
 * three board sizes). What this panel establishes is the layer under it: that the
 * position is *derived* from `(game, cursor)` on every render, so the canvas will
 * have a single source to draw and no cache of its own to fall out of step. The
 * stone counts below are that derivation made visible, which is also what lets an
 * e2e spec assert navigation without reading pixels.
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

          <nav className="board-nav" aria-label={t('board:nav.hint')}>
            <button
              type="button"
              data-testid="nav-first"
              aria-label={t('board:nav.first')}
              onClick={seekToStart}
            >
              ⏮
            </button>
            <button
              type="button"
              data-testid="nav-prev"
              aria-label={t('board:nav.previous')}
              onClick={stepBackward}
            >
              ◀
            </button>
            <button
              type="button"
              data-testid="nav-next"
              aria-label={t('board:nav.next')}
              onClick={stepForward}
            >
              ▶
            </button>
            <button
              type="button"
              data-testid="nav-last"
              aria-label={t('board:nav.last')}
              onClick={seekToEnd}
            >
              ⏭
            </button>
          </nav>
        </>
      )}

      <p className="engine-status" data-testid="engine-status">
        {t('analysis:engine.label')}: {t('analysis:engine.status.unavailable')}
      </p>
    </main>
  )
}
