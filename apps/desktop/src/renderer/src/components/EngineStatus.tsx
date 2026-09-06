import { useTranslation } from 'react-i18next'
import { useAnalysisStore } from '../state/analysisStore'

/**
 * Engine status badge.
 *
 * ## Why this reads a store instead of holding its own subscription
 *
 * M1 justified local state with "engine status is read-only and only consumed
 * here". Stage 3 made that premise false: the board overlays read the engine's
 * results, so engine state gained a second consumer and a single store is what
 * keeps the badge and the overlays on the same snapshot. The one writer is the
 * `engine:status` subscription in `useMainProcessEvents`; this component is a
 * pure projection, and subscribing here too would be a second write path that
 * could interleave with the store's.
 *
 * The initial snapshot arrives through the same store: `useMainProcessEvents`
 * seeds it with one `engine:info` call on mount, which reads the service's
 * synchronous state — no event round trip, no flash of the wrong status.
 *
 * ## `errorCode` is translated, never printed raw
 *
 * Same rule as `ErrorNotice`: the code is the message key, and a code this
 * build does not know falls back to `errors:unknown` rather than printing an
 * engine-controlled string (`directory-structure.md` §Forbidden patterns).
 */
export function EngineStatus(): React.JSX.Element {
  const { t } = useTranslation(['analysis', 'errors'])
  const engine = useAnalysisStore((state) => state.status)

  const label = t(`analysis:engine.status.${engine.status}`)

  return (
    <div className="engine-status" data-testid="engine-status">
      <span className="engine-status__label">{t('analysis:engine.label')}: </span>
      <span className={`engine-status__value engine-status__value--${engine.status}`}>
        {label}
      </span>
      {engine.status === 'downloading' && engine.downloadProgress !== undefined && (
        <progress
          className="engine-status__progress"
          value={engine.downloadProgress}
          max={1}
          aria-label={t('analysis:engine.downloadProgress', {
            percent: Math.round(engine.downloadProgress * 100),
          })}
        />
      )}
      {engine.status === 'failed' && engine.errorCode !== undefined && (
        <span className="engine-status__error">
          {t(`errors:code.${engine.errorCode}`, { defaultValue: t('errors:unknown') })}
        </span>
      )}
    </div>
  )
}
