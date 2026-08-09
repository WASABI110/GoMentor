import { useTranslation } from 'react-i18next'

// Stage 1 skeleton, now translated. Stage 6 replaces the layout itself with the
// real resizable three-panel shell (GameList | Board + MoveTree | TeacherChat)
// and persisted widths; the strings it uses are already in place here so that
// A12 — switching zh-CN ↔ en leaves no untranslated key visible — is testable
// against the built app rather than only against the catalogues.

export function App(): React.JSX.Element {
  const { t } = useTranslation(['common', 'board', 'teacher', 'analysis'])

  return (
    <div className="app-shell">
      <aside className="panel panel--library">
        <h2>{t('common:library.title')}</h2>
        <p className="placeholder">{t('common:library.empty')}</p>
      </aside>

      <main className="panel panel--board">
        <h2>{t('board:title')}</h2>
        <p className="placeholder">{t('board:empty')}</p>
        <p className="engine-status">
          {t('analysis:engine.label')}: {t('analysis:engine.status.unavailable')}
        </p>
      </main>

      <aside className="panel panel--teacher">
        <h2>{t('teacher:title')}</h2>
        <p className="placeholder">{t('teacher:empty')}</p>
      </aside>
    </div>
  )
}
