import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { App } from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { i18nInstance } from './i18n'
import { useLibraryStore } from './state/libraryStore'
import { useSettingsStore } from './state/settingsStore'
import './styles/global.css'

/**
 * React root.
 *
 * ## i18n is initialised before the first render, not during it
 *
 * `i18nInstance` is ready at import time — every catalogue is a static import, so
 * `init` completes synchronously (`i18n/index.ts`). Rendering therefore never
 * shows a frame of raw key names, which is what A12 forbids and what a
 * `Suspense`-wrapped async loader would produce.
 *
 * The locale itself arrives later: it lives in `ui.locale`, which main owns, so
 * `load()` reads it over IPC and `settingsStore` calls `changeLanguage`. The gap
 * between first paint and that resolution shows `zh-CN`, the authoring locale and
 * the schema default — correct for most users and never a raw key for anyone. The
 * native menu has no such gap because main translates it from the same JSON
 * before the window exists (`main/menu.ts`).
 *
 * `load()` is fired here rather than in an `App` effect so it starts during module
 * evaluation instead of after the first commit, and so `App` stays a pure function
 * of store state. `refresh()` is fired for the same reason and additionally
 * because it must not be a panel's responsibility: the list has to be current even
 * on a first paint where the library panel renders its empty state.
 *
 * ## Neither call is awaited, and neither can reject
 *
 * A bridge call resolves to the `IpcResult` union — a failure is `{ ok: false }`,
 * recorded in the store's `error` and rendered by `ErrorNotice`. So there is no
 * unhandled rejection to guard here, and the error boundary below is for a
 * *render* fault, not for these.
 */

const container = document.getElementById('root')
if (!container) throw new Error('root element missing from index.html')

void useSettingsStore.getState().load()
void useLibraryStore.getState().refresh()

createRoot(container).render(
  <StrictMode>
    <I18nextProvider i18n={i18nInstance}>
      {/*
        Inside the i18n provider, not outside: the boundary's own fallback is
        translated, and a boundary that could not reach `t` would have to hard-code
        an English sentence — the exact defect A12 exists to catch, in the one
        place nobody looks at because it only renders when something else broke.
      */}
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </I18nextProvider>
  </StrictMode>,
)
