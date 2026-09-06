import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MoveTreeBranchState } from '../state/gameStore'

/** Re-exported prop shape — the single definition lives beside the path that decides it. */
export type { MoveTreeBranchState } from '../state/gameStore'

/**
 * Linear move navigation for M1, plus Stage 4's read-only branch picker.
 *
 * M1 only needs a flat move list, not a branching tree, so the navigation is a
 * compact control bar with keyboard support. The branching SGF tree stays in
 * the AST in main; what the renderer gets is `Game.branches` — the option list
 * at each mainline branch point — and choosing one re-parses through
 * `gameStore.chooseBranch` (see the store for the identity/correlation
 * decisions). Creating or editing variations is deliberately out of scope
 * (`prd.md` scope decision 3).
 *
 * ## Why the picker lives here, at the cursor
 *
 * A branch point is only meaningful at the position it branches from: entry
 * `c` of `branches` describes the alternatives to the move played at cursor
 * `c + 1`. Rendering the picker wherever the cursor sits — rather than a
 * permanent tree widget — keeps one branch question on screen at a time, which
 * is the whole of M2's read-only scope.
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

/**
 * The branch choice on offer at the cursor's position, computed by the panel
 * from `gameStore.branchStateAt` — `game.branches[cursor]` plus the child
 * index the current variation path follows there.
 */

export interface MoveTreeProps {
  cursor: number
  total: number
  onFirst: () => void
  onPrevious: () => void
  onNext: () => void
  onLast: () => void
  /** Branch picker state for the cursor position, or null when not at a branch point. */
  branch?: MoveTreeBranchState | null
  onChooseBranch?: (childIndex: number) => void
}

export function MoveTree({
  cursor,
  total,
  onFirst,
  onPrevious,
  onNext,
  onLast,
  branch = null,
  onChooseBranch,
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

      {branch !== null && branch.options.length >= 2 && (
        <div
          className="move-tree__branches"
          data-testid="branch-picker"
          role="group"
          aria-label={t('board:tree.title')}
        >
          {branch.options.map((option) => {
            const active = option.index === branch.activeIndex
            const label =
              option.index === 0
                ? // Child 0 is the default (first-child) continuation — the
                  // main line by SGF convention, even at an end-of-record
                  // branch point where that continuation simply runs into the
                  // first variation.
                  t('board:tree.mainLine')
                : (option.label ?? t('board:tree.variation', { n: option.index }))
            return (
              <button
                key={option.index}
                type="button"
                className={
                  active
                    ? 'move-tree__branch move-tree__branch--active'
                    : 'move-tree__branch'
                }
                data-testid={`branch-option-${String(option.index)}`}
                aria-pressed={active}
                onClick={() => {
                  onChooseBranch?.(option.index)
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}
    </nav>
  )
}
