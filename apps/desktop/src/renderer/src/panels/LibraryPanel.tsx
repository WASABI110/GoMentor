import { useTranslation } from 'react-i18next'
import { useLibraryStore } from '../state/libraryStore'
import { useGameStore } from '../state/gameStore'
import { GameList } from '../components/GameList'

/**
 * The library panel.
 *
 * ## Opening a row goes through `sgf:serialize`, not through the summary
 *
 * A `GameSummary` has no moves — it is the row, not the record. Opening one asks
 * main to serialise the stored collection back to SGF text and feeds that to
 * `gameStore.open`, which parses it through the same `sgf:parse` path a file
 * import takes. That round trip looks redundant and is not: it means there is
 * exactly one way a `Game` comes into existence in the renderer, so a projection
 * bug cannot show up on one path and not the other.
 *
 * ## Drag/drop is handled inside `GameList`
 *
 * Electron augments the `File` objects in a renderer `drop` event with a `path`
 * property, so the import can run through `libraryStore.importFiles` directly.
 * The panel only needs to pass the callback; the highlight state lives in the
 * list component.
 */
export function LibraryPanel(): React.JSX.Element {
  const { t } = useTranslation(['common'])
  const games = useLibraryStore((state) => state.games)
  const loading = useLibraryStore((state) => state.loading)
  const importing = useLibraryStore((state) => state.importing)
  const error = useLibraryStore((state) => state.error)
  const lastImport = useLibraryStore((state) => state.lastImport)
  const importFiles = useLibraryStore((state) => state.importFiles)
  const openGame = useGameStore((state) => state.open)

  async function handleImport(): Promise<void> {
    const dialog = await window.gomentor.sgf.openDialog({})
    if (!dialog.ok) {
      useLibraryStore.setState({ error: dialog.error })
      return
    }
    await importFiles(dialog.data.filePaths)
  }

  async function handleOpen(gameId: string): Promise<void> {
    const serialised = await window.gomentor.sgf.serialize({ gameId })
    if (!serialised.ok) {
      useLibraryStore.setState({ error: serialised.error })
      return
    }
    await openGame(serialised.data.content)
  }

  function handleDropFiles(filePaths: string[]): void {
    void importFiles(filePaths)
  }

  return (
    <aside className="panel panel--library" data-testid="library-panel">
      <h2>{t('common:library.title')}</h2>
      <GameList
        games={games}
        loading={loading}
        importing={importing}
        error={error}
        lastImport={lastImport}
        onImport={() => {
          void handleImport()
        }}
        onOpen={(gameId) => {
          void handleOpen(gameId)
        }}
        onDropFiles={handleDropFiles}
      />
    </aside>
  )
}
