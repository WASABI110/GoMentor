import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EngineInfo } from '@gomentor/shared'
import { useIpcEvent } from '../hooks/useIpcEvent'

/**
 * Engine status badge.
 *
 * M1 only ever shows `unavailable`, but the component models the full lifecycle
 * so M2's `downloading`, `starting`, `ready` and `failed` states render without
 * a code change. The initial state is read from a prop-like default rather than
 * a store because no store owns engine state in M1.
 *
 * ## Why this subscribes directly rather than through a store
 *
 * Engine status is read-only in the renderer and only consumed here. A zustand
 * store would be indirection with no other consumer, and would invite other
 * components to write to it even though the only writer is main. Keeping the
 * state local makes the data flow obvious: main emits → this component renders.
 */

export interface EngineStatusProps {
  initial?: EngineInfo
}

export function EngineStatus({
  initial = { status: 'unavailable' },
}: EngineStatusProps): React.JSX.Element {
  const { t } = useTranslation(['analysis'])
  const [engine, setEngine] = useState<EngineInfo>(initial)

  useIpcEvent(window.gomentor.onEngineStatus, (info) => {
    setEngine(info)
  })

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
        <span className="engine-status__error">{engine.errorCode}</span>
      )}
    </div>
  )
}
