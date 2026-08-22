import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ErrorEnvelope, GameSummary } from '@gomentor/shared'
import { ErrorNotice } from './ErrorNotice'

/**
 * The library list and its drag-drop import surface.
 *
 * ## Why drag state is internal
 *
 * The only source of drag feedback is the browser's own `dragenter`/`dragleave`
 * events on this element. Electron augments the `File` objects in a `drop` event
 * with a `path` property, so the import can be triggered directly in the
 * renderer without a main-process round trip. Keeping `dragOver` inside the
 * component means the panel does not need to subscribe to anything to paint the
 * highlight.
 *
 * ## Why the list itself is not a button
 *
 * Each row is a `<button>` inside a `<li>` so arrow-key navigation and screen
 * readers get list semantics for free, while the whole row remains clickable and
 * focusable. A `<li onClick>` would need a `tabIndex` and key handler to match
 * that behaviour.
 */

type FileWithPath = File & { path?: string }

export interface GameListProps {
  games: GameSummary[]
  loading: boolean
  importing: boolean
  error: ErrorEnvelope | null
  lastImport: {
    imported: number
    duplicates: number
    failures: { filePath: string; error: ErrorEnvelope }[]
  } | null
  onOpen: (gameId: string) => void
  onImport: () => void
  onDropFiles: (filePaths: string[]) => void
}

export function GameList({
  games,
  loading,
  importing,
  error,
  lastImport,
  onOpen,
  onImport,
  onDropFiles,
}: GameListProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'board', 'errors'])

  // A depth counter rather than a boolean, because `dragleave` fires when the
  // pointer enters a child element. Counting enter/leave pairs keeps the
  // highlight stable while the user moves over the list.
  const [dragDepth, setDragDepth] = useState(0)
  const dragOver = dragDepth > 0

  function handleDragEnter(event: React.DragEvent): void {
    event.preventDefault()
    setDragDepth((depth) => depth + 1)
  }

  function handleDragLeave(event: React.DragEvent): void {
    event.preventDefault()
    setDragDepth((depth) => Math.max(0, depth - 1))
  }

  function handleDragOver(event: React.DragEvent): void {
    // The browser only allows drops on elements that cancel `dragover`. This
    // prevents the default "open file in window" behaviour.
    event.preventDefault()
  }

  function handleDrop(event: React.DragEvent): void {
    event.preventDefault()
    setDragDepth(0)

    const files = Array.from(event.dataTransfer.files) as FileWithPath[]
    const paths = files
      .map((file) => file.path)
      .filter((path): path is string => typeof path === 'string' && path.length > 0)

    if (paths.length > 0) {
      onDropFiles(paths)
    }
  }

  return (
    <div
      className={`game-list ${dragOver ? 'game-list--drag-over' : ''}`}
      data-testid="game-list"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <button
        type="button"
        className="button game-list__import"
        data-testid="library-import"
        disabled={importing}
        onClick={onImport}
      >
        {importing ? t('common:loading') : t('common:library.import')}
      </button>

      {error !== null && <ErrorNotice error={error} />}

      {lastImport !== null && lastImport.failures.length > 0 && (
        <div className="game-list__import-summary" data-testid="library-import-summary">
          <p>
            {t('common:library.importedCount', { count: lastImport.imported })}
            {', '}
            {t('common:library.duplicateCount', { count: lastImport.duplicates })}
            {', '}
            {t('common:library.failedCount', { count: lastImport.failures.length })}
          </p>
        </div>
      )}

      {loading && games.length === 0 ? (
        <p className="placeholder">{t('common:loading')}</p>
      ) : games.length === 0 ? (
        <p className="placeholder game-list__empty" data-testid="library-empty">
          {dragOver ? t('common:library.dropHere') : t('common:library.empty')}
        </p>
      ) : (
        <>
          <p className="library-count" data-testid="library-count">
            {t('common:library.count', { count: games.length })}
          </p>
          <ul className="library-list" data-testid="library-list">
            {games.map((game) => (
              <li key={game.id}>
                <button
                  type="button"
                  className="library-row"
                  onClick={() => {
                    onOpen(game.id)
                  }}
                >
                  <span className="library-row__players">
                    {game.blackName ?? t('common:library.unknownPlayer')}
                    {' — '}
                    {game.whiteName ?? t('common:library.unknownPlayer')}
                  </span>
                  <span className="library-row__meta">
                    {game.date ?? t('common:library.unknownDate')} ·{' '}
                    {String(game.boardSize)}×{String(game.boardSize)} ·{' '}
                    {t('board:moveNumber', { n: game.moveCount })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
