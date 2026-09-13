import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EventPayload, LlmProviderKind, Settings } from '@gomentor/shared'
import { useSettingsStore } from '../state/settingsStore'
import { useIpcEvent } from '../hooks/useIpcEvent'
import { ErrorNotice } from '../components/ErrorNotice'
import { Button, Input, Select } from '../components/ui'

/**
 * The GPU tier-2 backend rows: one per downloadable backend, showing whether
 * it is on disk, a download button when it is not, and live progress while it
 * fetches. Status is fetched on mount and the `gpu:progress` event folds into
 * the same state — the download button disappears the moment the binary
 * exists (`downloaded` reads the layout, not a flag we set).
 */
function GpuBackends(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const [status, setStatus] = useState<{
    backends: { backend: 'cuda' | 'opencl'; downloaded: boolean; preferred: boolean }[]
  } | null>(null)
  const [progress, setProgress] = useState<EventPayload<'gpu:progress'> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.gomentor.gpu
      .status({})
      .then((result) => {
        if (result.ok) setStatus(result.data)
        else setError(result.error.code)
      })
      .catch(() => {
        setError('IPC_HANDLER_FAILED')
      })
  }, [])
  useIpcEvent(window.gomentor.onGpuProgress, setProgress)

  const running =
    progress !== null &&
    (progress.state === 'downloading' || progress.state === 'extracting')

  async function startDownload(backend: 'cuda' | 'opencl'): Promise<void> {
    setError(null)
    const result = await window.gomentor.gpu.download({ backend })
    if (!result.ok) setError(result.error.code)
  }

  return (
    <div className="settings-gpu" data-testid="settings-gpu">
      {error !== null && (
        <p className="settings-hint" data-testid="settings-gpu-error">
          {t('errors:errorCodes.' + error, { defaultValue: error })}
        </p>
      )}
      {(status?.backends ?? []).map((backend) => {
        const live =
          progress !== null &&
          progress.backend === backend.backend &&
          (progress.state === 'downloading' || progress.state === 'extracting')
        const percent =
          progress !== null &&
          progress.backend === backend.backend &&
          progress.received !== undefined &&
          progress.total
            ? Math.round((progress.received / progress.total) * 100)
            : null
        return (
          <div
            key={backend.backend}
            className="settings-field settings-field--inline"
            data-testid={`settings-gpu-${backend.backend}`}
          >
            <span>GPU ({backend.backend.toUpperCase()})</span>
            {backend.downloaded ? (
              <span>{t('settings:engine.downloaded')}</span>
            ) : live ? (
              <span data-testid={`settings-gpu-${backend.backend}-progress`}>
                {t('settings:engine.download')}…{' '}
                {percent !== null ? `${String(percent)}%` : ''}
              </span>
            ) : (
              <Button
                data-testid={`settings-gpu-${backend.backend}-download`}
                disabled={running}
                onClick={() => {
                  void startDownload(backend.backend)
                }}
              >
                {t('settings:engine.download')}
              </Button>
            )}
          </div>
        )
      })}
      <p className="settings-hint">{t('settings:engine.gpuHint')}</p>
    </div>
  )
}

/**
 * The auto-update status line. Module scope, not nested in the panel: a
 * component type defined inside another component's body is a NEW type every
 * render, so React would unmount and remount it each time the panel
 * re-rendered — dropping its state and resubscribing the event for nothing.
 */
function UpdateStatusRow(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const [status, setStatus] = useState<EventPayload<'update:status'> | null>(null)
  useIpcEvent(window.gomentor.onUpdateStatus, setStatus)

  // `idle` is also the honest default before any event arrives: an eligible
  // build fires its startup check immediately, and a disabled one receives
  // its `disabled` payload at construction — there is no third quiet state.
  const state = status?.state ?? 'idle'
  return (
    <p className="settings-hint" data-testid="settings-update-status">
      {t(`settings:update.state.${state}`, {
        version: status?.version ?? '',
        progress:
          status?.progress !== undefined ? String(Math.round(status.progress)) : '0',
        error: status?.error ?? '',
      })}
    </p>
  )
}

/**
 * Provider configuration and API-key entry.
 *
 * ## Why the form is local until save
 *
 * `settingsStore.update` writes the whole patch to main and waits for the saved
 * document to come back. If every keystroke called it, the user would incur an
 * IPC round trip per character. The LLM fields therefore hold local state and
 * only commit when the user presses save.
 *
 * Locale is different: it is a `<select>`, so there is no keystroke storm, and
 * changing it immediately makes the rest of the UI match the new language. It
 * is therefore read straight from `settings.ui.locale` rather than from the
 * local draft, so the select stays in sync with the document main owns.
 *
 * ## Why the API key has its own channel
 *
 * The key never crosses to the renderer as plaintext. `settings:setSecret`
 * sends it main-ward only; `settings:hasSecret` returns a boolean mirror. The
 * input therefore clears itself after a successful save — the renderer has no
 * reason to keep the value around.
 *
 * ## Why `hasKey` is read from settings rather than maintained locally
 *
 * `hasKey` is part of the persisted document. After `setSecret` succeeds, the
 * next `settings:get` (or the response from `settings:set`) reflects the new
 * state. Re-reading it from the store keeps the UI in sync without a separate
 * local flag that could drift.
 */

export function SettingsPanel(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common', 'errors'])
  const settings = useSettingsStore((state) => state.settings)
  const loading = useSettingsStore((state) => state.loading)
  const error = useSettingsStore((state) => state.error)
  const update = useSettingsStore((state) => state.update)

  const [draft, setDraft] = useState<Partial<Settings> | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  /**
   * The names textarea holds a *string* (one name per line) while the document
   * holds the list. Local like the LLM fields: committing on every keystroke
   * would write a half-typed name into the document the profile reads.
   */
  const [namesDraft, setNamesDraft] = useState('')

  // Clear the "saved" confirmation automatically, and clean up the timeout if the
  // panel unmounts — otherwise a late setState would run on an unmounted component.
  useEffect(() => {
    if (!keySaved) return undefined
    const timeout = setTimeout(() => {
      setKeySaved(false)
    }, 2000)
    return () => {
      clearTimeout(timeout)
    }
  }, [keySaved])

  // Initialise the draft once the document loads.
  useEffect(() => {
    if (settings !== null && draft === null) {
      setDraft(settings)
      setNamesDraft(settings.profile.playerNames.join('\n'))
    }
  }, [settings, draft])

  if (loading && settings === null) {
    return <p className="placeholder">{t('common:loading')}</p>
  }

  if (draft === null || settings === null) {
    return <p className="placeholder">{t('common:loading')}</p>
  }

  const currentSettings = settings
  const llm = draft.llm ?? currentSettings.llm

  async function handleSave(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault()

    const patch: Parameters<typeof update>[0] = {
      llm: {
        kind: llm.kind,
        baseUrl: llm.baseUrl,
        model: llm.model,
        temperature: llm.temperature,
        maxTokens: llm.maxTokens,
      },
      // One name per line; blank lines are the user's paragraphing, not names.
      // Trimmed so a trailing newline does not become an empty entry the mine
      // filter would ignore anyway — better not to store it.
      profile: {
        playerNames: namesDraft
          .split('\n')
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      },
    }

    await update(patch)
  }

  async function handleSaveKey(): Promise<void> {
    if (keyInput === '') return
    const result = await window.gomentor.settings.setSecret({
      key: 'llmApiKey',
      value: keyInput,
    })
    if (result.ok) {
      setKeyInput('')
      setKeySaved(true)
    }
  }

  function updateLlm(updates: Partial<typeof llm>): void {
    setDraft((previous) => {
      if (previous === null) return previous
      return {
        ...previous,
        llm: { ...(previous.llm ?? currentSettings.llm), ...updates },
      }
    })
  }

  return (
    <form
      className="settings-panel"
      data-testid="settings-panel"
      onSubmit={(event) => {
        event.preventDefault()
        void handleSave(event)
      }}
    >
      <h2>{t('settings:title')}</h2>

      {error !== null && <ErrorNotice error={error} />}

      <fieldset className="settings-section">
        <legend>{t('settings:section.ui')}</legend>
        <label className="settings-field">
          <span>{t('settings:ui.locale')}</span>
          <Select
            data-testid="settings-locale"
            value={settings.ui.locale}
            onChange={(event) => {
              void update({
                ui: { locale: event.target.value as Settings['ui']['locale'] },
              })
            }}
          >
            {/* Two locales by scope decision (2026-09-13): ja/ko/th/vi were
              cancelled, not deferred — the schema still accepts a stored
              six-locale value from an older build (it falls back to the
              English catalogue), but this panel offers what exists. */}
            {(['zh-CN', 'en'] as const).map((locale) => (
              <option key={locale} value={locale}>
                {t(`common:localeName.${locale}`)}
              </option>
            ))}
          </Select>
        </label>
      </fieldset>

      <fieldset className="settings-section">
        <legend>{t('settings:section.llm')}</legend>

        <label className="settings-field">
          <span>{t('settings:llm.kind')}</span>
          <Select
            data-testid="settings-provider-kind"
            value={llm.kind}
            onChange={(event) => {
              updateLlm({ kind: event.target.value as LlmProviderKind })
            }}
          >
            <option value="cloud">{t('settings:llm.kindOption.cloud')}</option>
            <option value="local">{t('settings:llm.kindOption.local')}</option>
          </Select>
        </label>

        <label className="settings-field">
          <span>{t('settings:llm.baseUrl')}</span>
          <Input
            type="url"
            data-testid="settings-provider-base-url"
            value={llm.baseUrl}
            onChange={(event) => {
              updateLlm({ baseUrl: event.target.value })
            }}
          />
        </label>

        <label className="settings-field">
          <span>{t('settings:llm.model')}</span>
          <Input
            type="text"
            data-testid="settings-provider-model"
            value={llm.model}
            onChange={(event) => {
              updateLlm({ model: event.target.value })
            }}
          />
        </label>

        <label className="settings-field">
          <span>{t('settings:llm.temperature')}</span>
          <Input
            type="number"
            min={0}
            max={2}
            step={0.1}
            data-testid="settings-provider-temperature"
            value={llm.temperature}
            onChange={(event) => {
              const value = Number.parseFloat(event.target.value)
              if (!Number.isNaN(value)) updateLlm({ temperature: value })
            }}
          />
        </label>

        <label className="settings-field">
          <span>{t('settings:llm.maxTokens')}</span>
          <Input
            type="number"
            min={1}
            step={1}
            data-testid="settings-provider-max-tokens"
            value={llm.maxTokens}
            onChange={(event) => {
              const value = Number.parseInt(event.target.value, 10)
              if (!Number.isNaN(value)) updateLlm({ maxTokens: value })
            }}
          />
        </label>
      </fieldset>

      <fieldset className="settings-section">
        <legend>{t('settings:llm.apiKey')}</legend>

        <div className="settings-field settings-field--row">
          <Input
            type="password"
            data-testid="settings-api-key"
            value={keyInput}
            placeholder={t('settings:llm.apiKeyPlaceholder')}
            onChange={(event) => {
              setKeyInput(event.target.value)
            }}
          />
          <Button
            type="button"
            className="button"
            data-testid="settings-save-key"
            disabled={keyInput === ''}
            onClick={() => {
              void handleSaveKey()
            }}
          >
            {keySaved ? t('settings:saved') : t('common:save')}
          </Button>
        </div>

        {settings.llm.hasKey && (
          <p className="settings-key-status" data-testid="settings-key-present">
            {t('settings:llm.apiKeySet')}
          </p>
        )}
      </fieldset>

      <fieldset className="settings-section">
        <legend>{t('settings:section.profile')}</legend>
        {/* One name per line: names can contain commas, and a list the user
          edits in place reads better than a repeated add/remove form for
          something most users write once. */}
        <label className="settings-field">
          <span>{t('settings:profile.playerNames')}</span>
          <textarea
            className="settings-textarea"
            data-testid="settings-player-names"
            rows={3}
            value={namesDraft}
            placeholder={t('settings:profile.playerNamesPlaceholder')}
            onChange={(event) => {
              setNamesDraft(event.target.value)
            }}
          />
        </label>
        <p className="settings-hint">{t('settings:profile.playerNamesHint')}</p>
      </fieldset>

      <fieldset className="settings-section">
        <legend>{t('settings:section.about')}</legend>

        {/* Read straight from the document like locale: a checkbox has no
          keystroke storm, and the state must match what main owns. Like
          telemetry consent, the change takes effect on next launch — the hint
          says so, because a toggle that "does nothing" without that sentence
          reads as broken. */}
        <label className="settings-field settings-field--inline">
          <input
            type="checkbox"
            data-testid="settings-telemetry-consent"
            checked={settings.telemetryConsent}
            onChange={(event) => {
              void update({ telemetryConsent: event.target.checked })
            }}
          />
          <span>{t('settings:about.telemetryConsent')}</span>
        </label>
        <p className="settings-hint">{t('settings:about.telemetryConsentHint')}</p>

        <UpdateStatusRow />
      </fieldset>

      <fieldset className="settings-section">
        <legend>{t('settings:section.engine')}</legend>
        <label className="settings-field">
          <span>{t('settings:engine.backend')}</span>
          <Select
            data-testid="settings-engine-backend"
            value={settings.engine.backend ?? ''}
            onChange={(event) => {
              const value = event.target.value
              void update({
                engine: {
                  backend:
                    value === '' ? null : (value as Settings['engine']['backend']),
                },
              })
            }}
          >
            <option value="">{t('settings:engine.backendAuto')}</option>
            <option value="eigen">CPU (Eigen)</option>
            <option value="cuda">CUDA</option>
            <option value="opencl">OpenCL</option>
          </Select>
        </label>

        <GpuBackends />

        <p className="settings-hint">{t('settings:engine.gpuHint')}</p>
      </fieldset>

      <Button
        type="submit"
        className="button settings-save"
        data-testid="settings-save"
        disabled={loading}
      >
        {t('common:save')}
      </Button>
    </form>
  )
}
