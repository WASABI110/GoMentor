import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsSchema, type ErrorEnvelope, type Settings } from '@gomentor/shared'
import { useSettingsStore } from '../../src/renderer/src/state/settingsStore'
import { i18nInstance } from '../../src/renderer/src/i18n'

/**
 * `settingsStore` — the renderer's mirror of the document main owns.
 *
 * ## Why the bridge is stubbed rather than mocked at the module level
 *
 * The store reaches `window.gomentor`, which `contextBridge` injects. There is no
 * module to `vi.mock`, so the seam is the global, and stubbing it here keeps the
 * store's production code free of a test-only injection point it would otherwise
 * need for no other reason.
 *
 * ## Why every case asserts on locale as well as on state
 *
 * The store's least obvious job is pointing i18n at `ui.locale`. A test that only
 * checks `settings` in the store would pass with `syncLocale` deleted, and the app
 * would then persist a locale it never displays — the failure is silent, and the
 * settings panel would show the new language selected while every string stayed in
 * the old one.
 */

function makeSettings(overrides: Record<string, unknown> = {}): Settings {
  // Parsed rather than hand-built: the schema fills every default, so a field
  // added later cannot leave this fixture a shape the store never sees in
  // production.
  return settingsSchema.parse(overrides)
}

interface BridgeCalls {
  get: number
  set: unknown[]
}

/**
 * Installs a fake bridge and returns a record of what the store called.
 *
 * Handlers may be sync or async — the store awaits the result either way, and
 * typing them as `PromiseLike | value` keeps the cases that need no delay free of
 * a pointless `async` (which `require-await` correctly flags). The one case that
 * does need a pending promise supplies it explicitly.
 */
function stubBridge(handlers: {
  get?: () => unknown
  set?: (request: unknown) => unknown
}): BridgeCalls {
  const calls: BridgeCalls = { get: 0, set: [] }
  vi.stubGlobal('window', {
    gomentor: {
      settings: {
        get: () => {
          calls.get += 1
          return handlers.get === undefined
            ? { ok: true, data: makeSettings() }
            : handlers.get()
        },
        set: (request: unknown) => {
          calls.set.push(request)
          return handlers.set === undefined
            ? { ok: true, data: makeSettings() }
            : handlers.set(request)
        },
      },
    },
  })
  return calls
}

const FAILURE: ErrorEnvelope = { code: 'SETTINGS_WRITE_FAILED', message: 'disk full' }

/**
 * The store's own initial state, captured at import time.
 *
 * Read before any test can mutate it, and used to reset between tests instead of
 * a hand-written `{ settings: null, … }`. That literal was a defect: it asserted
 * the shape the test author expected rather than the shape the store defines, so
 * changing the store's initial `settings` to a defaults-shaped placeholder left
 * every test green — measured, the mutation survived — while the app would show a
 * `dark`/`zh-CN` flash to a user whose theme is `light`.
 */
const INITIAL = useSettingsStore.getState()

beforeEach(() => {
  useSettingsStore.setState({
    settings: INITIAL.settings,
    loading: INITIAL.loading,
    error: INITIAL.error,
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await i18nInstance.changeLanguage('zh-CN')
})

describe('initial state', () => {
  it('starts with no document rather than with defaults', () => {
    // The load-bearing assertion for the "no placeholder" decision. Asserted
    // against the store directly, not through `INITIAL`, so it cannot pass by
    // comparing a value to itself.
    expect(useSettingsStore.getInitialState().settings).toBeNull()
    expect(useSettingsStore.getInitialState().loading).toBe(false)
    expect(useSettingsStore.getInitialState().error).toBeNull()
  })
})

describe('load', () => {
  it('mirrors the document main returns', async () => {
    stubBridge({
      get: () => ({ ok: true, data: makeSettings({ debugLogging: true }) }),
    })
    await useSettingsStore.getState().load()

    const state = useSettingsStore.getState()
    expect(state.settings?.debugLogging).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('points i18n at the stored locale', async () => {
    stubBridge({
      get: () => ({ ok: true, data: makeSettings({ ui: { locale: 'en' } }) }),
    })
    await useSettingsStore.getState().load()

    expect(i18nInstance.language).toBe('en')
    expect(i18nInstance.t('menu.file')).toBe('File')
  })

  it('falls back to English for a locale this build does not bundle', async () => {
    // `ja` is a valid persisted value (M5 ships the catalogue). Until then a user
    // who set it in a newer build and rolled back must see English, not raw keys.
    stubBridge({
      get: () => ({ ok: true, data: makeSettings({ ui: { locale: 'ja' } }) }),
    })
    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().settings?.ui.locale).toBe('ja')
    expect(i18nInstance.language).toBe('en')
  })

  it('keeps a failed read as state rather than throwing', async () => {
    stubBridge({ get: () => ({ ok: false, error: FAILURE }) })
    // The assertion is that this resolves: a bridge failure is a renderable state,
    // not an exception for an error boundary.
    await expect(useSettingsStore.getState().load()).resolves.toBeUndefined()

    const state = useSettingsStore.getState()
    expect(state.error).toEqual(FAILURE)
    expect(state.settings).toBeNull()
    expect(state.loading).toBe(false)
  })

  it('leaves settings null while in flight rather than showing defaults', async () => {
    // A promise held open so the assertions below run while `load()` is still in
    // flight.
    //
    // `resolve` is captured out of the executor, which runs synchronously inside
    // the `new Promise` call — so `release` is assigned before the next statement.
    // Typed as possibly-undefined and checked rather than asserted with `!`
    // (`quality-guidelines.md:20` permits `!` only for an invariant enforced
    // immediately above, and this one is established by the line below) and
    // rather than initialised to an empty arrow, which would silently swallow the
    // release if that synchronous guarantee ever changed. The check turns the same
    // change into a failed expectation instead.
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    expect(release).toBeDefined()

    stubBridge({
      get: async () => {
        await pending
        return { ok: true, data: makeSettings() }
      },
    })

    const inFlight = useSettingsStore.getState().load()
    // A defaults-shaped placeholder here would render one frame of `dark`/`zh-CN`
    // to a user whose real theme is `light`, indistinguishable from a real value.
    expect(useSettingsStore.getState().loading).toBe(true)
    expect(useSettingsStore.getState().settings).toBeNull()

    release?.()
    await inFlight
    expect(useSettingsStore.getState().settings).not.toBeNull()
  })
})

describe('update', () => {
  it('sends the patch and replaces the mirror with the response', async () => {
    const calls = stubBridge({
      set: () => ({ ok: true, data: makeSettings({ ui: { theme: 'light' } }) }),
    })
    await useSettingsStore.getState().update({ ui: { theme: 'light' } })

    expect(calls.set).toEqual([{ patch: { ui: { theme: 'light' } } }])
    expect(useSettingsStore.getState().settings?.ui.theme).toBe('light')
  })

  it('replaces rather than merges, so main can correct a value', async () => {
    // Main is authoritative: it may clamp, normalise, or recompute a field the
    // patch never mentioned (`hasKey` is recomputed from the secrets service on
    // every read). A store that merged the patch locally would keep the value the
    // renderer asked for and disagree with the file.
    stubBridge({
      get: () => ({
        ok: true,
        data: makeSettings({ engine: { maxVisits: 500 } }),
      }),
      set: () => ({ ok: true, data: makeSettings({ engine: { maxVisits: 1 } }) }),
    })
    await useSettingsStore.getState().load()
    await useSettingsStore.getState().update({ engine: { maxVisits: 999999 } })

    expect(useSettingsStore.getState().settings?.engine.maxVisits).toBe(1)
  })

  it('switches the language when the patch changes locale', async () => {
    stubBridge({
      set: () => ({ ok: true, data: makeSettings({ ui: { locale: 'en' } }) }),
    })
    await useSettingsStore.getState().update({ ui: { locale: 'en' } })

    expect(i18nInstance.t('menu.file')).toBe('File')
  })

  it('keeps the previous document when a patch is rejected', async () => {
    stubBridge({
      get: () => ({ ok: true, data: makeSettings({ ui: { theme: 'light' } }) }),
      set: () => ({
        ok: false,
        error: { code: 'SETTINGS_INVALID', message: 'bad' },
      }),
    })
    await useSettingsStore.getState().load()
    await useSettingsStore.getState().update({ ui: { theme: 'light' } })

    const state = useSettingsStore.getState()
    // Nothing changed in main, so clearing the mirror would blank the panel for a
    // write that never happened.
    expect(state.settings?.ui.theme).toBe('light')
    expect(state.error?.code).toBe('SETTINGS_INVALID')
  })

  it('clears a stale error once a later write succeeds', async () => {
    stubBridge({
      set: () => ({ ok: true, data: makeSettings() }),
    })
    useSettingsStore.setState({ error: FAILURE })
    await useSettingsStore.getState().update({ debugLogging: true })

    expect(useSettingsStore.getState().error).toBeNull()
  })
})
