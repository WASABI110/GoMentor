import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LlmProviderKind, Settings } from '@gomentor/shared'
import { useSettingsStore } from '../state/settingsStore'
import { ErrorNotice } from '../components/ErrorNotice'
import { Button, Input, Select } from '../components/ui'

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
            {(['zh-CN', 'en', 'ja', 'ko', 'th', 'vi'] as const).map((locale) => (
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
