import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Linear move navigation for M1.
 *
 * M1 only needs a flat move list, not a branching tree, so this is a compact
 * control bar with keyboard support. The branching SGF tree will replace or
 * extend it in M2.
 *
 * ## Keyboard controls
 *
 * - Left / Right arrow: step one move.
 * - Home / End: jump to start or end of the record.
 *
 * The listener is attached to the document while the component is mounted, so
 * the controls work wherever the focus is inside the board panel.
 *
 * ## Why the buttons use text labels rather than symbols alone
 *
 * The symbols are rendered with `aria-label` for screen readers, but the visible
 * text is also useful for users who do not recognise the media-control glyphs.
 * A button with only a symbol fails the "label is visible" heuristic in some
 * audit tools even when an `aria-label` is present.
 */

export interface MoveTreeProps {
  cursor: number
  total: number
  onFirst: () => void
  onPrevious: () => void
  onNext: () => void
  onLast: () => void
}

export function MoveTree({
  cursor,
  total,
  onFirst,
  onPrevious,
  onNext,
  onLast,
}: MoveTreeProps): React.JSX.Element {
  const { t } = useTranslation(['board'])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          onPrevious()
          break
        case 'ArrowRight':
          event.preventDefault()
          onNext()
          break
        case 'Home':
          event.preventDefault()
          onFirst()
          break
        case 'End':
          event.preventDefault()
          onLast()
          break
        default:
          break
      }
    }

    const element = ref.current
    if (element === null) return

    // Attach to the component's host element rather than the document so focus
    // does not have to be inside the window for arrow keys to navigate moves.
    element.addEventListener('keydown', onKeyDown)
    return () => {
      element.removeEventListener('keydown', onKeyDown)
    }
  }, [onFirst, onPrevious, onNext, onLast])

  return (
    <nav
      ref={ref}
      className="move-tree"
      aria-label={t('board:nav.hint')}
      data-testid="move-tree"
      tabIndex={0}
    >
      <span className="move-tree__counter" data-testid="move-tree-counter">
        {t('board:moveOf', { cursor, total })}
      </span>

      <div className="move-tree__controls">
        <button
          type="button"
          className="move-tree__button"
          data-testid="move-tree-first"
          aria-label={t('board:nav.first')}
          disabled={cursor <= 0}
          onClick={onFirst}
        >
          {t('board:nav.firstSymbol')}
        </button>
        <button
          type="button"
          className="move-tree__button"
          data-testid="move-tree-prev"
          aria-label={t('board:nav.previous')}
          disabled={cursor <= 0}
          onClick={onPrevious}
        >
          {t('board:nav.previousSymbol')}
        </button>
        <button
          type="button"
          className="move-tree__button"
          data-testid="move-tree-next"
          aria-label={t('board:nav.next')}
          disabled={cursor >= total}
          onClick={onNext}
        >
          {t('board:nav.nextSymbol')}
        </button>
        <button
          type="button"
          className="move-tree__button"
          data-testid="move-tree-last"
          aria-label={t('board:nav.last')}
          disabled={cursor >= total}
          onClick={onLast}
        >
          {t('board:nav.lastSymbol')}
        </button>
      </div>
    </nav>
  )
}
