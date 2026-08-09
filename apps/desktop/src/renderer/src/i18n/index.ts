import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { localeSchema, type Locale } from '@gomentor/shared'

import zhCommon from './locales/zh-CN/common.json'
import zhBoard from './locales/zh-CN/board.json'
import zhAnalysis from './locales/zh-CN/analysis.json'
import zhTeacher from './locales/zh-CN/teacher.json'
import zhSettings from './locales/zh-CN/settings.json'
import zhErrors from './locales/zh-CN/errors.json'

import enCommon from './locales/en/common.json'
import enBoard from './locales/en/board.json'
import enAnalysis from './locales/en/analysis.json'
import enTeacher from './locales/en/teacher.json'
import enSettings from './locales/en/settings.json'
import enErrors from './locales/en/errors.json'

/**
 * Renderer i18n.
 *
 * ## Bundled, not fetched
 *
 * Every catalogue is a static `import`, so Vite inlines them and `init` needs no
 * backend and no `await`. This is deliberate: an async loader would render one
 * frame of raw key names — the exact defect A12 forbids — and the same reasoning
 * that keeps the native menu translated in main (`main/menu.ts`) applies here.
 * Two locales of flat JSON are small enough that lazy loading would trade a real
 * visual defect for an unmeasurable saving.
 *
 * ## `zh-CN` is the authoring locale, `en` the fallback
 *
 * R10. Keys are written in `zh-CN` first; `en` is a translation of it, not the
 * other way round. `fallbackLng: 'en'` therefore means "a key not yet translated
 * shows English", never "shows the key". `test/unit/i18n.test.ts` asserts the two
 * catalogues have identical key sets in both directions, so that fallback is a
 * safety net for a state the tests reject rather than a state the app relies on.
 *
 * ## Locale is not detected
 *
 * No language detector. The locale is `ui.locale` in the settings document, which
 * main owns and persists — see `state-management.md` on why settings are
 * response-authoritative. `applyLocale` is how the settings store pushes a change
 * here; nothing in this module reads the browser or the OS.
 */

/** Namespaces per `directory-structure.md`. `common` is the default. */
export const NAMESPACES = [
  'common',
  'board',
  'analysis',
  'teacher',
  'settings',
  'errors',
] as const
export type Namespace = (typeof NAMESPACES)[number]

/**
 * The locales that actually have catalogues.
 *
 * Narrower than `localeSchema`, which lists all six target locales: ja/ko/th/vi
 * are deferred to M5 (R10). A `Partial<Record<Locale, …>>` would compile but push
 * the gap to runtime, so the shipped set is its own type and
 * `hasCatalogue` is the only way in.
 */
export const BUNDLED_LOCALES = ['zh-CN', 'en'] as const
export type BundledLocale = (typeof BUNDLED_LOCALES)[number]

export const DEFAULT_LOCALE: BundledLocale = 'zh-CN'
export const FALLBACK_LOCALE: BundledLocale = 'en'

const RESOURCES: Record<BundledLocale, Record<Namespace, object>> = {
  'zh-CN': {
    common: zhCommon,
    board: zhBoard,
    analysis: zhAnalysis,
    teacher: zhTeacher,
    settings: zhSettings,
    errors: zhErrors,
  },
  en: {
    common: enCommon,
    board: enBoard,
    analysis: enAnalysis,
    teacher: enTeacher,
    settings: enSettings,
    errors: enErrors,
  },
}

/** Whether a locale from the settings document has a catalogue in this build. */
export function hasCatalogue(locale: Locale): locale is BundledLocale {
  return (BUNDLED_LOCALES as readonly string[]).includes(locale)
}

/**
 * Creates and initialises an instance.
 *
 * A factory rather than a module-level side effect: tests need a fresh instance
 * per case, and importing this module must not mutate global state.
 *
 * `initReactI18next` is passed only for the shared singleton, since it registers
 * the instance for `useTranslation` — a test instance doing that would leak into
 * whatever rendered next.
 */
export function createI18n(
  options: { locale?: BundledLocale; react?: boolean } = {},
): i18n {
  const instance = i18next.createInstance()
  const configured = options.react === true ? instance.use(initReactI18next) : instance

  // `init` resolves a promise, but with inlined resources it has already
  // finished synchronously by the time it returns — `t` works on the next line.
  // The promise is not awaited here so that module import stays synchronous;
  // a rejection would mean a malformed bundled catalogue, which is a build-time
  // defect the key-completeness test catches first.
  void configured.init({
    lng: options.locale ?? DEFAULT_LOCALE,
    fallbackLng: FALLBACK_LOCALE,
    ns: NAMESPACES,
    defaultNS: 'common',
    resources: RESOURCES,
    // The renderer is not a server; there is nothing to escape into. React
    // escapes interpolated values itself, and leaving this on double-escapes
    // CJK punctuation in game comments.
    interpolation: { escapeValue: false },
    // A missing key must be visible in development, not silently blank.
    returnEmptyString: false,
  })

  return instance
}

/** The instance `useTranslation` resolves against. */
export const i18nInstance = createI18n({ react: true })

/**
 * Points the shared instance at a locale from the settings document.
 *
 * Locales without a catalogue fall back rather than throw: `ui.locale` is
 * persisted and a user who set `ja` in a future build then rolled back must get
 * a usable app, not a crash on boot. Returns what was actually applied so a
 * caller can tell the difference.
 */
export async function applyLocale(locale: Locale): Promise<BundledLocale> {
  const applied = hasCatalogue(locale) ? locale : FALLBACK_LOCALE
  await i18nInstance.changeLanguage(applied)
  return applied
}

/**
 * Narrows an unvalidated value to a `Locale`.
 *
 * Used where a locale arrives from outside the type system; the schema is the
 * single definition of what a locale is, so this does not re-list them.
 */
export function parseLocale(value: unknown): Locale | undefined {
  const result = localeSchema.safeParse(value)
  return result.success ? result.data : undefined
}
