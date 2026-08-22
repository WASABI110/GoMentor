import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../state/chatStore'
import { TeacherChat } from '../components/TeacherChat'
import { SettingsPanel } from './SettingsPanel'

/**
 * The teacher panel: a tabbed shell around the chat and the settings form.
 *
 * The conversation itself lives in `components/TeacherChat.tsx`; this component
 * owns only the tab switch and which view is mounted.
 *
 * ## The draft moved down with the chat
 *
 * What the user is typing belongs to the chat view, not to the panel: switching
 * to settings unmounting the composer must not be able to clear a half-typed
 * question. Keeping `draft` in `TeacherChat` means the state dies with the view
 * only if the view is actually destroyed - and React keeps state alive across
 * the sibling swap, so a user who flips to settings and back finds their text
 * intact.
 */
export function TeacherPanel(): React.JSX.Element {
  const { t } = useTranslation(['teacher', 'settings', 'common'])
  const [view, setView] = useState<'chat' | 'settings'>('chat')

  // Read from the store rather than threaded through props: the panel does not
  // render the streaming answer, but it does carry the run's identity on its
  // root element (see `data-run-id` below), which changes as runs start and end.
  const activeRunId = useChatStore((state) => state.activeRunId)

  return (
    <aside
      className="panel panel--teacher"
      data-testid="teacher-panel"
      // The run the visible partial answer belongs to. In the DOM rather than only
      // in the store because it is genuinely part of what this panel is showing -
      // "these tokens are from run X" - and because the alternative considered was
      // exposing the store on `window` for the e2e spec, which is a test-only
      // backdoor into renderer state and would be dead weight in a packaged build
      // where `import.meta.env.DEV` is false. An attribute is inert, is the same in
      // every build, and carries no secret: a runId is a UUID main issued, not
      // user content.
      data-run-id={activeRunId ?? ''}
    >
      <h2>{view === 'settings' ? t('settings:title') : t('teacher:title')}</h2>

      <div className="teacher-tabs">
        <button
          type="button"
          className={`teacher-tab ${view === 'chat' ? 'teacher-tab--active' : ''}`}
          data-testid="teacher-tab-chat"
          onClick={() => {
            setView('chat')
          }}
        >
          {t('teacher:title')}
        </button>
        <button
          type="button"
          className={`teacher-tab ${view === 'settings' ? 'teacher-tab--active' : ''}`}
          data-testid="teacher-tab-settings"
          onClick={() => {
            setView('settings')
          }}
        >
          {t('settings:title')}
        </button>
      </div>

      {view === 'settings' ? <SettingsPanel /> : <TeacherChat />}
    </aside>
  )
}
