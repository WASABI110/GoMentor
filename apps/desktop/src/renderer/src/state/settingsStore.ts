import { create } from 'zustand'
import type { ErrorEnvelope, Settings, SettingsPatch } from '@gomentor/shared'
import { applyLocale } from '../i18n'

/**
 * Mirror of the settings document main owns.
 *
 * ## Response-authoritative, no event
 *
 * `state-management.md` §Mirroring main-process state: settings change only
 * because the renderer asked, and `settings:set` responds with the whole
 * post-write document, so the response replaces the store. There is deliberately
 * no `settings:changed` event to subscribe to — adding one would write the same
 * value twice, the second write arriving late enough to clobber a subsequent
 * user edit.
 *
 * ## The store is a cache, not the truth
 *
 * If this and `settings.json` disagree, the file wins. Nothing here writes a
 * field locally and hopes main agrees; every mutation goes out as a patch and
 * comes back as a document.
 *
 * ## `settings` is null before the first load
 *
 * Not a defaults-shaped placeholder. A placeholder means a panel renders `dark`
 * and `zh-CN` for one frame and then corrects itself, which is indistinguishable
 * from a real value while it lasts — a user whose theme is `light` sees a dark
 * flash. `null` forces a caller to decide what to show while loading.
 */

interface SettingsState {
  /** `null` until `load()` resolves. */
  settings: Settings | null
  /** True while the initial `settings:get` is in flight. */
  loading: boolean
  /** Last failure from `load` or `update`, translated by `code` in the UI. */
  error: ErrorEnvelope | null

  load: () => Promise<void>
  update: (patch: SettingsPatch) => Promise<void>
}

/**
 * Points i18n at the document's locale.
 *
 * Called on every accepted document rather than only when `locale` appears in a
 * patch: `changeLanguage` to the current language is a no-op in i18next, and
 * keying off the patch would miss a locale that changed for any reason the
 * renderer did not initiate — including the first load, where there is no patch
 * at all.
 *
 * Awaited, so a component reading `settings` from a resolved `update()` is
 * never a render ahead of the strings.
 */
async function syncLocale(settings: Settings): Promise<void> {
  await applyLocale(settings.ui.locale)
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    const result = await window.gomentor.settings.get({})
    if (!result.ok) {
      // No throw: a bridge call resolves to the union, and a failed settings read
      // is a state the UI has to render, not an exception to escape into an error
      // boundary. `directory-structure.md` §Forbidden patterns.
      set({ loading: false, error: result.error })
      return
    }
    await syncLocale(result.data)
    set({ settings: result.data, loading: false })
  },

  update: async (patch) => {
    set({ error: null })
    const result = await window.gomentor.settings.set({ patch })
    if (!result.ok) {
      // The previous document stays in place. A rejected patch changed nothing in
      // main, so clearing the mirror would show the user an empty panel for a
      // write that never happened.
      set({ error: result.error })
      return
    }
    await syncLocale(result.data)
    set({ settings: result.data })
  },
}))
