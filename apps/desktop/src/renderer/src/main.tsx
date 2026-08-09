import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { App } from './App'
import { i18nInstance } from './i18n'
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
 * of store state.
 */

const container = document.getElementById('root')
if (!container) throw new Error('root element missing from index.html')

// Not awaited: the render must not wait on IPC. A failure is recorded in the
// store's `error` and rendered, per `directory-structure.md` — a bridge call
// resolves to a result union, so there is nothing here that can reject.
void useSettingsStore.getState().load()

createRoot(container).render(
  <StrictMode>
    <I18nextProvider i18n={i18nInstance}>
      <App />
    </I18nextProvider>
  </StrictMode>,
)
