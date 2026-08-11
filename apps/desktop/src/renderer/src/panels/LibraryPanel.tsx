import { useTranslation } from 'react-i18next'
import { useLibraryStore } from '../state/libraryStore'
import { useGameStore } from '../state/gameStore'
import { ErrorNotice } from '../components/ErrorNotice'

/**
 * The library list, and the button that imports into it.
 *
 * ## Opening a row goes through `sgf:serialize`, not through the summary
 *
 * A `GameSummary` has no moves — it is the row, not the record. Opening one asks
 * main to serialise the stored collection back to SGF text and feeds that to
 * `gameStore.open`, which parses it through the same `sgf:parse` path a file
 * import takes. That round trip looks redundant and is not: it means there is
 * exactly one way a `Game` comes into existence in the renderer, so a projection
 * bug cannot show up on one path and not the other.
 */
export function LibraryPanel(): React.JSX.Element {
  const { t } = useTranslation(['common', 'board', 'errors'])
  const games = useLibraryStore((state) => state.games)
  const loading = useLibraryStore((state) => state.loading)
  const importing = useLibraryStore((state) => state.importing)
  const error = useLibraryStore((state) => state.error)
  const openGame = useGameStore((state) => state.open)

  async function handleImport(): Promise<void> {
    const dialog = await window.gomentor.sgf.openDialog({})
    if (!dialog.ok) {
      useLibraryStore.setState({ error: dialog.error })
      return
    }
    await useLibraryStore.getState().importFiles(dialog.data.filePaths)
  }

  async function handleOpen(gameId: string): Promise<void> {
    const serialised = await window.gomentor.sgf.serialize({ gameId })
    if (!serialised.ok) {
      useLibraryStore.setState({ error: serialised.error })
      return
    }
    await openGame(serialised.data.content)
  }

  return (
    <aside className="panel panel--library" data-testid="library-panel">
      <h2>{t('common:library.title')}</h2>

      <button
        type="button"
        className="button"
        data-testid="library-import"
        disabled={importing}
        onClick={() => {
          void handleImport()
        }}
      >
        {importing ? t('common:loading') : t('common:library.import')}
      </button>

      {error !== null && <ErrorNotice error={error} />}

      {loading && games.length === 0 ? (
        <p className="placeholder">{t('common:loading')}</p>
      ) : games.length === 0 ? (
        <p className="placeholder">{t('common:library.empty')}</p>
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
                    void handleOpen(game.id)
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
    </aside>
  )
}
