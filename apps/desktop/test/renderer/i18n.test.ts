import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { errorCodeSchema, localeSchema } from '@gomentor/shared'
import {
  BUNDLED_LOCALES,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  NAMESPACES,
  applyLocale,
  createI18n,
  hasCatalogue,
  i18nInstance,
  parseLocale,
  type BundledLocale,
  type Namespace,
} from '../../src/renderer/src/i18n'

/**
 * i18n catalogue completeness — the machine-testable half of A12 and R10.
 *
 * ## Why this asserts against the live instance, not the JSON files
 *
 * A test that globs `locales/**` proves the files agree with each other. It does
 * not prove the shipped app can reach them: a namespace missing from the `ns`
 * array, or a catalogue left out of the resources map, is invisible to a
 * file-level check and shows the user raw key names. So every assertion here goes
 * through `getResourceBundle`, which is the same path `t` takes.
 *
 * ## Why `errors` is checked against the schema, not against `en`
 *
 * R10 specifies the CI gate as "fails on keys missing relative to `en`". That is
 * necessary but not sufficient, and the gap is not hypothetical: a new error code
 * added to `errorCodeSchema` is missing from *both* locales at once, so the two
 * catalogues still match and a relative check passes. The renderer would then
 * translate that code to nothing and fall back to showing a raw
 * `SOURCE_SCHEMA_CHANGED` to a user. `errorCodeSchema` is the authority for what
 * codes exist, so that is what the `errors` namespace is measured against.
 *
 * ## Why the namespace and locale lists are not taken from the module alone
 *
 * Every `for (const ns of NAMESPACES)` loop below generates its cases *from the
 * array under test*, so deleting an entry deletes the cases that would have caught
 * the deletion. Measured, not assumed: removing `'analysis'` from `NAMESPACES`
 * took this suite from 36 tests to 32, all green. A namespace whose catalogue
 * files exist but which is absent from `ns` is exactly the defect that shows a
 * user a raw `analysis:engine.label`, and the generated loops were blind to it.
 *
 * `SPEC_NAMESPACES` and the directory listing are therefore independent
 * authorities: the spec says which namespaces the product has
 * (`directory-structure.md`), the filesystem says which catalogues shipped, and
 * the module must agree with both.
 */

/**
 * The namespaces named in `.trellis/spec/frontend/directory-structure.md`.
 *
 * Restated from the spec on purpose — a list imported from the module it is meant
 * to police cannot police it. A namespace added to the product has to be written
 * here as well, which is the point: the duplication is the assertion.
 */
const SPEC_NAMESPACES = [
  'common',
  'board',
  'analysis',
  'teacher',
  'settings',
  'errors',
] as const

const LOCALES_DIR = join(import.meta.dirname, '../../src/renderer/src/i18n/locales')

function shippedLocaleDirs(): string[] {
  return readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function shippedNamespaces(locale: string): string[] {
  return readdirSync(join(LOCALES_DIR, locale))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort()
}

describe('the module registers what the spec and the filesystem say exists', () => {
  it('declares exactly the namespaces the spec names', () => {
    expect([...NAMESPACES].sort()).toEqual([...SPEC_NAMESPACES].sort())
  })

  it('declares exactly the locales that have a catalogue directory', () => {
    expect([...BUNDLED_LOCALES].sort()).toEqual(shippedLocaleDirs())
  })

  // Iterating the spec list, not `BUNDLED_LOCALES`, for the same reason.
  for (const locale of ['zh-CN', 'en']) {
    it(`${locale} ships a JSON file for every spec namespace and no others`, () => {
      // The inverse defect: a catalogue file under a name nothing loads, or a
      // spec namespace with no file behind it.
      expect(shippedNamespaces(locale)).toEqual([...SPEC_NAMESPACES].sort())
    })
  }
})

/** Dotted leaf paths, so a nested key that moved reads as a diff, not a shape. */
function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  )
}

/**
 * The leaf value at a dotted path produced by `leafKeys`, or `undefined`.
 *
 * Returns `unknown` rather than `string` so a catalogue whose leaf is the wrong
 * type is compared honestly instead of being asserted into shape.
 */
function leafAt(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function bundle(locale: BundledLocale, ns: Namespace): object {
  const resources: unknown = i18nInstance.getResourceBundle(locale, ns)
  if (typeof resources !== 'object' || resources === null) {
    throw new Error(`no ${ns} bundle registered for ${locale}`)
  }
  return resources
}

describe('every namespace is registered for every bundled locale', () => {
  for (const locale of BUNDLED_LOCALES) {
    for (const ns of NAMESPACES) {
      it(`${locale}/${ns} is reachable through the live instance`, () => {
        expect(Object.keys(bundle(locale, ns)).length).toBeGreaterThan(0)
      })
    }
  }
})

describe('the two catalogues have identical key sets', () => {
  for (const ns of NAMESPACES) {
    // Both directions, not just "missing relative to en". A key present only in
    // `en` is also a defect: it is either dead weight or a `zh-CN` gap that the
    // authoring locale — the one most users see — would show in English.
    it(`${ns} matches in both directions`, () => {
      const zh = leafKeys(bundle('zh-CN', ns)).sort()
      const en = leafKeys(bundle('en', ns)).sort()
      expect(zh).toEqual(en)
    })
  }
})

/**
 * Values legitimately identical in both catalogues, by key path.
 *
 * Kept small and enumerated rather than pattern-matched: a rule like "allow
 * anything under 8 characters" would readmit exactly the untranslated short
 * labels this guards against. Every entry here is a string that *should not* be
 * translated — a proper noun, an acronym, or an endonym written in its own
 * language.
 */
const IDENTICAL_BY_DESIGN = new Set<string>([
  // The product name. Not localised in either catalogue.
  'appName',
  // Endonyms — each language name written in its own language, so a reader can
  // find their language without already being able to read the current one.
  // Asserted positively by 'writes each language name in its own language'.
  'localeName.zh-CN',
  'localeName.en',
  'localeName.ja',
  'localeName.ko',
  'localeName.th',
  'localeName.vi',
  // KataGo backend names as the engine reports them. Translating "CUDA" would
  // make a user's log unmatchable against the engine's own output.
  'engine.backend.tensorrt',
  'engine.backend.cuda',
  'engine.backend.opencl',
  'engine.backend.eigen',
])

describe('zh-CN is actually translated, not copied from en', () => {
  /**
   * The hole a key-set comparison cannot see, and it is not hypothetical.
   *
   * Measured: overwriting five of the six `zh-CN` catalogues with their `en`
   * counterparts — every error message, the whole settings panel, all teacher
   * text in English — left this suite at 40/40 and the full suite at 914/914.
   * Only `common.json` was caught, and only incidentally, by two `locale
   * selection` cases that happen to spot-check particular keys.
   *
   * That is precisely the state A12 forbids ("no untranslated key visible"), so a
   * gate reporting green on it is measuring the wrong thing. R10's "keys missing
   * relative to `en`" is necessary and not sufficient; the PRD is amended to say
   * so rather than this file quietly checking more than the requirement asks.
   *
   * Per-namespace rather than one aggregate assertion: a single total would let a
   * fully-untranslated `errors` namespace hide behind a well-translated `board`.
   */
  for (const ns of NAMESPACES) {
    it(`${ns} differs from en wherever it should`, () => {
      const zhBundle = bundle('zh-CN', ns)
      const enBundle = bundle('en', ns)

      const identical = leafKeys(zhBundle)
        .filter((key) => !IDENTICAL_BY_DESIGN.has(key))
        .filter((key) => leafAt(zhBundle, key) === leafAt(enBundle, key))

      // Key paths only, never values. `error-handling.md` §zod logging applies to
      // assertion messages too: a failure here names which keys are untranslated,
      // and printing the strings would put catalogue content in CI output for no
      // diagnostic gain.
      expect(identical, `untranslated keys in ${ns}: ${identical.join(', ')}`).toEqual(
        [],
      )
    })
  }

  it('would notice if the allowlist swallowed the check', () => {
    // The allowlist is the one way this suite can be silently disabled: growing it
    // to cover a namespace turns that namespace's assertion vacuous. Pinned to the
    // exact current count so adding an entry is a deliberate edit here, with the
    // justification comment above it, rather than a quiet widening.
    //
    // 11 = the product name + 6 endonyms + 4 KataGo backend names. Every one was
    // read before being listed; none is a translatable sentence.
    expect(IDENTICAL_BY_DESIGN.size).toBe(11)
  })
})

describe('the errors namespace covers every code that can be thrown', () => {
  for (const locale of BUNDLED_LOCALES) {
    it(`${locale} translates all ${String(errorCodeSchema.options.length)} error codes`, () => {
      const translated = leafKeys(bundle(locale, 'errors'))
        .filter((key) => key.startsWith('code.'))
        .map((key) => key.slice('code.'.length))
      expect(translated.sort()).toEqual([...errorCodeSchema.options].sort())
    })
  }

  it('has no translation for a code that does not exist', () => {
    // The other direction: a code renamed in the schema leaves a stale entry
    // behind, and a one-way check would keep passing while the new name shows
    // untranslated.
    const codes = new Set<string>(errorCodeSchema.options)
    const stale = leafKeys(bundle('zh-CN', 'errors'))
      .filter((key) => key.startsWith('code.'))
      .map((key) => key.slice('code.'.length))
      .filter((code) => !codes.has(code))
    expect(stale).toEqual([])
  })
})

describe('interpolation placeholders agree across locales', () => {
  // A translator dropping `{{count}}` produces a sentence that silently loses its
  // number rather than an error. Compared as sets: word order differs between
  // Chinese and English, so position cannot be required, but presence can.
  function placeholders(text: string): string[] {
    return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '').sort()
  }

  function flatEntries(value: unknown, prefix = ''): [string, string][] {
    if (typeof value === 'string') return [[prefix, value]]
    if (typeof value !== 'object' || value === null) return []
    return Object.entries(value).flatMap(([key, child]) =>
      flatEntries(child, prefix === '' ? key : `${prefix}.${key}`),
    )
  }

  for (const ns of NAMESPACES) {
    it(`${ns} uses the same placeholders in both locales`, () => {
      const en = new Map(flatEntries(bundle('en', ns)))
      const mismatched = flatEntries(bundle('zh-CN', ns))
        .filter(([key, zhText]) => {
          const enText = en.get(key)
          return (
            enText !== undefined &&
            placeholders(zhText).join(',') !== placeholders(enText).join(',')
          )
        })
        .map(([key]) => key)
      expect(mismatched).toEqual([])
    })
  }
})

describe('locale selection', () => {
  it('defaults to the authoring locale', () => {
    expect(DEFAULT_LOCALE).toBe('zh-CN')
    expect(createI18n().language).toBe('zh-CN')
  })

  it('translates from the requested locale', () => {
    expect(createI18n({ locale: 'en' }).t('menu.file')).toBe('File')
    expect(createI18n({ locale: 'zh-CN' }).t('menu.file')).toBe('文件')
  })

  it('reaches a non-default namespace', () => {
    // `defaultNS` is `common`, so this fails if `ns` omitted the namespace even
    // though the resources map included it.
    expect(createI18n({ locale: 'en' }).t('errors:code.LLM_NO_KEY')).toBe(
      'No API key has been set.',
    )
  })

  it('recognises exactly the locales that ship a catalogue', () => {
    const bundled = localeSchema.options.filter((locale) => hasCatalogue(locale))
    expect(bundled).toEqual([...BUNDLED_LOCALES])
  })

  it('falls back for a locale the schema allows but this build does not bundle', async () => {
    // `ja` is a valid persisted value (M5 ships it). A user who set it in a newer
    // build and rolled back must get English, not a crash and not raw keys.
    expect(hasCatalogue('ja')).toBe(false)
    await expect(applyLocale('ja')).resolves.toBe(FALLBACK_LOCALE)
    await applyLocale(DEFAULT_LOCALE)
  })

  it('applies a bundled locale to the shared instance', async () => {
    await expect(applyLocale('en')).resolves.toBe('en')
    expect(i18nInstance.t('menu.file')).toBe('File')
    await applyLocale('zh-CN')
    expect(i18nInstance.t('menu.file')).toBe('文件')
  })

  it('rejects a value that is not a locale', () => {
    expect(parseLocale('zh-CN')).toBe('zh-CN')
    expect(parseLocale('klingon')).toBeUndefined()
    expect(parseLocale(undefined)).toBeUndefined()
  })
})

describe('the locale picker can name every locale it can offer', () => {
  it('names all six target locales, including the deferred ones', () => {
    // Deliberately the full schema, not `BUNDLED_LOCALES`: the picker lists what
    // the product supports, and M5 adds catalogues without touching this list.
    for (const locale of localeSchema.options) {
      expect(leafKeys(bundle('en', 'common'))).toContain(`localeName.${locale}`)
    }
  })

  it('writes each language name in its own language, not the reader’s', () => {
    // A picker that renders "Japanese" to someone who only reads Japanese is
    // useless, so these are intentionally identical across catalogues.
    const zh = bundle('zh-CN', 'common')
    const en = bundle('en', 'common')
    expect(zh).toHaveProperty('localeName')
    expect(
      JSON.stringify(Object.getOwnPropertyDescriptor(zh, 'localeName')?.value),
    ).toBe(JSON.stringify(Object.getOwnPropertyDescriptor(en, 'localeName')?.value))
  })
})
