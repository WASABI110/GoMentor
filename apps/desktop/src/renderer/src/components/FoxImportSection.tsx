import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The Fox (野狐) import section (M5 Stage 5): nickname → game list → import.
 *
 * ## The failure-isolation contract, in component form
 *
 * Every Fox operation can fail (upstream down, payload drifted, user not
 * found) and none of it may take the library down: the section keeps its own
 * local error state and renders it inside its own box. The library list above
 * never re-renders because of a Fox failure, and a successful import needs no
 * Fox state at all — `library:changed` (fired by the import path in main) is
 * what refreshes the list.
 */

interface FoxGame {
  chessid: string
  black: string
  white: string
  date: string
  result: string
}

export function FoxImportSection(): React.JSX.Element {
  // The fox strings live under the COMMON namespace's library section
  // (`common.json` → `library.fox.*`) — there is no separate `library`
  // namespace, and `useTranslation(['library'])` here rendered literal keys
  // across every locale (measured: i18n untranslated-key spec failed on all
  // three OS).
  const { t } = useTranslation(['common', 'errors'])
  const [nickname, setNickname] = useState('')
  const [games, setGames] = useState<FoxGame[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<
    Record<string, 'imported' | 'duplicate' | 'error'>
  >({})

  async function handleLookup(): Promise<void> {
    if (nickname.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    setGames(null)
    try {
      const user = await window.gomentor.fox.lookupUser({ nickname: nickname.trim() })
      if (!user.ok) {
        setError(user.error.code)
        return
      }
      const list = await window.gomentor.fox.listGames({ uid: user.data.uid })
      if (!list.ok) {
        setError(list.error.code)
        return
      }
      setGames(list.data.games)
    } catch {
      setError('SOURCE_UNREACHABLE')
    } finally {
      setBusy(false)
    }
  }

  async function handleImport(game: FoxGame): Promise<void> {
    if (imported[game.chessid] === 'imported') return
    setImported((previous) => ({ ...previous, [game.chessid]: 'error' }))
    try {
      const result = await window.gomentor.fox.importGame({ chessid: game.chessid })
      setImported((previous) => ({
        ...previous,
        [game.chessid]: result.ok
          ? result.data.duplicate
            ? 'duplicate'
            : 'imported'
          : 'error',
      }))
      if (!result.ok) setError(result.error.code)
    } catch {
      setError('SOURCE_UNREACHABLE')
    }
  }

  return (
    <div className="fox-import" data-testid="fox-import">
      <h3>{t('common:library.fox.title')}</h3>
      <div className="settings-field settings-field--inline">
        <input
          data-testid="fox-nickname"
          placeholder={t('common:library.fox.nicknamePlaceholder')}
          value={nickname}
          onChange={(event) => {
            setNickname(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleLookup()
          }}
        />
        <button
          type="button"
          data-testid="fox-lookup"
          disabled={busy || nickname.trim() === ''}
          onClick={() => {
            void handleLookup()
          }}
        >
          {busy ? t('common:library.fox.searching') : t('common:library.fox.search')}
        </button>
      </div>

      {error !== null && (
        <p className="settings-hint" data-testid="fox-error">
          {t('errors:errorCodes.' + error, { defaultValue: error })}
        </p>
      )}

      {games !== null && (
        <ul className="fox-games" data-testid="fox-games">
          {games.map((game) => (
            <li key={game.chessid}>
              <span className="fox-game-label">
                {game.black} vs {game.white} · {game.date} · {game.result}
              </span>
              <button
                type="button"
                data-testid={`fox-import-${game.chessid}`}
                disabled={imported[game.chessid] === 'imported'}
                onClick={() => {
                  void handleImport(game)
                }}
              >
                {imported[game.chessid] === 'imported'
                  ? t('common:library.fox.imported')
                  : imported[game.chessid] === 'duplicate'
                    ? t('common:library.fox.duplicate')
                    : imported[game.chessid] === 'error'
                      ? t('common:library.fox.retry')
                      : t('common:library.fox.import')}
              </button>
            </li>
          ))}
          {games.length === 0 && (
            <li className="settings-hint">{t('common:library.fox.noGames')}</li>
          )}
        </ul>
      )}
      <p className="settings-hint">{t('common:library.fox.isolationHint')}</p>
    </div>
  )
}
