import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProfileEvidence, ProfileWeakness } from '@gomentor/shared'
import { useProfileStore } from '../state/profileStore'
import { useGameStore } from '../state/gameStore'
import { useLibraryStore } from '../state/libraryStore'
import { useIpcEvent } from '../hooks/useIpcEvent'
import { Button } from './ui'

/**
 * The student profile section (M4 Stage 4, C5): three weakness cards with
 * evidence that jumps to the move, and the batch-analysis control that feeds
 * them.
 *
 * ## Data flow
 *
 * The snapshot is fetched on mount and refetched by `profileStore` whenever a
 * batch run reaches a terminal state — the only moment rows change without the
 * renderer asking. `library:changed` also refetches: a deletion removes
 * evidence, and a re-import invalidates it, and a panel that kept showing a
 * jump target the library no longer holds would click through to nothing.
 *
 * ## Evidence click-through reuses the library open path
 *
 * Opening an evidence row goes through `sgf:serialize` → `gameStore.open`,
 * exactly like clicking a library row — one way a `Game` comes into existence.
 * The `seek` afterwards is the standard cursor path (`gameStore.seek`), so the
 * engine's focus query, the graph, and the move list all land on the evidence
 * move through the machinery they already trust. There is no separate
 * "open at move" channel to keep in sync.
 *
 * ## Empty states are states
 *
 * No names configured, no games analysed, no weaknesses: each reads as its own
 * message rather than one blank panel, because the actions they point at
 * differ — configure names, run the batch, or nothing to do.
 */

const PERCENT_SCALE = 100

function lossPercent(loss: number): string {
  // One decimal is what the rows carry at meaningful magnitudes; a move that
  // cost 0.1% of winrate is not evidence anyone clicks.
  return (loss * PERCENT_SCALE).toFixed(1)
}

export function ProfileSection(): React.JSX.Element {
  const { t } = useTranslation(['profile', 'common', 'errors'])
  const snapshot = useProfileStore((state) => state.snapshot)
  const loading = useProfileStore((state) => state.loading)
  const error = useProfileStore((state) => state.error)
  const batch = useProfileStore((state) => state.batch)
  const starting = useProfileStore((state) => state.starting)
  const refresh = useProfileStore((state) => state.refresh)
  const startBatch = useProfileStore((state) => state.startBatch)
  const cancelBatch = useProfileStore((state) => state.cancelBatch)
  const applyProgress = useProfileStore((state) => state.applyProgress)
  const openGame = useGameStore((state) => state.open)
  const seek = useGameStore((state) => state.seek)
  const games = useLibraryStore((state) => state.games)

  useIpcEvent(window.gomentor.onBatchProgress, applyProgress)

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The library changed underneath the panel (delete, re-import): evidence may
  // name a game that is gone. The games list identity is the trigger — the same
  // signal GameList re-renders on.
  useEffect(() => {
    void refresh()
  }, [games, refresh])

  async function openEvidence(evidence: ProfileEvidence): Promise<void> {
    const serialised = await window.gomentor.sgf.serialize({ gameId: evidence.gameId })
    if (!serialised.ok) {
      useProfileStore.setState({ error: serialised.error })
      return
    }
    await openGame(serialised.data.content)
    seek(evidence.moveNumber)
  }

  const running = batch !== null

  return (
    <section className="profile-section" data-testid="profile-section">
      <h2>{t('profile:title')}</h2>

      {error !== null && (
        <p className="error-notice" data-testid="profile-error">
          {t('errors:errorCodes.' + error.code, { defaultValue: error.code })}
        </p>
      )}

      {loading && snapshot === null ? (
        <p className="placeholder">{t('common:loading')}</p>
      ) : snapshot === null ? null : (
        <>
          {snapshot.weaknesses.length === 0 ? (
            <p className="placeholder" data-testid="profile-empty">
              {snapshot.analysedMyGames === 0
                ? t('profile:nothingAnalysed', { myGames: snapshot.myGames })
                : t('profile:noWeaknesses')}
            </p>
          ) : (
            <ul className="profile-weaknesses">
              {snapshot.weaknesses.map((weakness) => (
                <WeaknessCard
                  key={weakness.category}
                  weakness={weakness}
                  onOpenEvidence={(evidence) => {
                    void openEvidence(evidence)
                  }}
                />
              ))}
            </ul>
          )}

          <div className="profile-batch" data-testid="profile-batch">
            {running ? (
              <>
                <span data-testid="profile-batch-progress">
                  {t('profile:batchProgress', {
                    done: batch.done + batch.failed,
                    total: batch.total,
                  })}
                </span>
                <Button
                  data-testid="profile-batch-cancel"
                  onClick={() => {
                    void cancelBatch()
                  }}
                >
                  {t('profile:batchCancel')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  data-testid="profile-batch-start"
                  disabled={starting}
                  onClick={() => {
                    void startBatch('mine')
                  }}
                >
                  {t('profile:batchStart')}
                </Button>
                {snapshot.analysedMyGames < snapshot.myGames && (
                  <span className="profile-batch-hint">
                    {t('profile:batchHint', {
                      analysed: snapshot.analysedMyGames,
                      myGames: snapshot.myGames,
                    })}
                  </span>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function WeaknessCard(props: {
  readonly weakness: ProfileWeakness
  readonly onOpenEvidence: (evidence: ProfileEvidence) => void
}): React.JSX.Element {
  const { t } = useTranslation(['profile'])
  const { weakness } = props
  return (
    <li
      className="profile-weakness"
      data-testid={`profile-weakness-${weakness.category}`}
    >
      <header>
        <h3>{t(`profile:category.${weakness.category}`)}</h3>
        <span className="profile-score">{lossPercent(weakness.score)}</span>
        <span className={`profile-trend profile-trend--${weakness.trend}`}>
          {t(`profile:trend.${weakness.trend}`)}
        </span>
      </header>
      <ul className="profile-evidence">
        {weakness.evidence.map((evidence) => (
          <li key={`${evidence.gameId}:${String(evidence.moveNumber)}`}>
            <button
              type="button"
              className="profile-evidence-link"
              data-testid={`profile-evidence-${evidence.gameId}-${String(evidence.moveNumber)}`}
              onClick={() => {
                props.onOpenEvidence(evidence)
              }}
            >
              {t('profile:evidenceMove', {
                moveNumber: evidence.moveNumber,
                loss: lossPercent(evidence.loss),
              })}
            </button>
          </li>
        ))}
      </ul>
    </li>
  )
}
