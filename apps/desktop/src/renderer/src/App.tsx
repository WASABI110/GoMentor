import { useTranslation } from 'react-i18next'
import { useMainProcessEvents } from './hooks/useMainProcessEvents'
import { useSettingsStore } from './state/settingsStore'
import { LibraryPanel } from './panels/LibraryPanel'
import { BoardPanel } from './panels/BoardPanel'
import { TeacherPanel } from './panels/TeacherPanel'

/**
 * The three-panel shell.
 *
 * ## The event subscriptions live here, not in the panels
 *
 * `useMainProcessEvents` is called once, at the only component guaranteed to be
 * mounted for the app's whole life. A subscription inside a panel would end when
 * that panel unmounted, and the store would then miss an import or drop tokens
 * mid-answer — see the hook's own comment for why each event is app-scoped rather
 * than panel-scoped.
 *
 * ## Widths come from settings, and the drag handle does not exist yet
 *
 * `ui.panelWidths` is persisted and read here, so the layout a user set survives
 * restart. What is missing is the interaction that changes it: a resize handle
 * writing back through `settingsStore.update`. Applying the stored widths first
 * means that when the handle lands there is one place it writes to and one place
 * the value is read, rather than a local width that has to be reconciled with a
 * persisted one.
 *
 * Before `load()` resolves, `settings` is `null` and the CSS defaults in
 * `global.css` apply — deliberately, per `settingsStore`'s note on why there is no
 * defaults-shaped placeholder: a placeholder would render one frame at 260px and
 * then jump to the user's real 400px, which reads as a layout glitch.
 */
export function App(): React.JSX.Element {
  const { t } = useTranslation('common')
  useMainProcessEvents()

  const settings = useSettingsStore((state) => state.settings)
  const widths = settings?.ui.panelWidths

  return (
    <div
      className="app-shell"
      data-testid="app-shell"
      style={
        widths === undefined
          ? undefined
          : {
              gridTemplateColumns: `${String(widths.library)}px 1fr ${String(widths.teacher)}px`,
            }
      }
    >
      {/*
        The accessible name of the whole app, for screen readers and for the e2e
        specs' `getByRole` queries. Not a visible heading: the window title bar
        already carries the app name, and repeating it would spend a row of a
        three-panel layout on something the user can already see.
      */}
      <h1 className="sr-only">{t('appName')}</h1>

      <LibraryPanel />
      <BoardPanel />
      <TeacherPanel />
    </div>
  )
}
