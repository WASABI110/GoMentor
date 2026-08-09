import { describe, expect, it } from 'vitest'
import { createSettingsService, type SettingsFs } from '../../src/main/settings'

/**
 * Settings round-trip and forward-compatibility.
 *
 * `quality-guidelines.md`: "Forward-compat is a correctness property, not a
 * nicety." The scenario is a user who runs a newer build, then rolls back. The
 * older build does not know the newer build's keys — and if it rebuilds the
 * document from the fields it knows, those settings are gone with no error and
 * no way to tell it happened.
 *
 * ## The nested case is the one that matters
 *
 * `settingsSchema` is `.loose()`, so unknown keys at the *root* survive
 * validation on their own. But every sub-schema is a plain `z.object()`, which
 * in zod 4 **strips** unknown keys — so `result.data.llm` comes back without
 * them. A newer build's new setting is most likely nested (`llm.newThing`, not
 * `newThing`), which makes the root-level case the easy half and the nested case
 * the one a reasonable implementation gets wrong. That is why `load()` merges
 * over `parsed` rather than `result.data`, and it is what these tests pin.
 */

const PATH = '/virtual/settings.json'

/** In-memory `SettingsFs`. Exposes what was written so persistence is checkable. */
function memoryFs(initial?: string): SettingsFs & {
  files: Map<string, string>
  written(): string | undefined
} {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(PATH, initial)
  return {
    files,
    read: (path) => files.get(path),
    write: (path, contents) => {
      files.set(path, contents)
    },
    preserve: (path, contents) => {
      files.set(`${path}.corrupt`, contents)
    },
    written: () => files.get(PATH),
  }
}

/** The document as it exists on disk, including fields `get()` strips. */
function onDisk(fs: { written(): string | undefined }): Record<string, unknown> {
  const raw = fs.written()
  if (raw === undefined) throw new Error('nothing was written')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('defaults', () => {
  it('yields a valid document when there is no file', () => {
    const settings = createSettingsService(memoryFs(), PATH).get()
    // `.prefault({})` not `.default({})` — asserted through its observable
    // consequence. With `.default`, nested sections come back as a literal `{}`
    // and `llm.model` would be undefined.
    expect(settings.llm.model).toBe('gpt-4o')
    expect(settings.ui.panelWidths.library).toBe(260)
    expect(settings.version).toBe(1)
  })

  it('does not write a file merely by being constructed', () => {
    // First launch should not create a settings file before the user has changed
    // anything: a file full of defaults is indistinguishable from choices the
    // user made, which matters the next time a default changes.
    const fs = memoryFs()
    createSettingsService(fs, PATH)
    expect(fs.files.size).toBe(0)
  })

  it('defaults telemetry consent to off', () => {
    // `design.md` §Operational: opt-in, default off. A default that flipped
    // would be a consent violation, so it is pinned rather than assumed.
    expect(createSettingsService(memoryFs(), PATH).get().telemetryConsent).toBe(false)
  })
})

describe('round-trip', () => {
  it('persists an update and reloads it', () => {
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.update({ llm: { model: 'gpt-4o-mini' } })

    // Read through a *fresh* service: asserting on the return value of `update`
    // would pass even if nothing were written, since it returns the in-memory
    // view.
    expect(createSettingsService(fs, PATH).get().llm.model).toBe('gpt-4o-mini')
  })

  it('merges a patch rather than replacing the section', () => {
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.update({ llm: { model: 'local-model' } })
    const after = service.get()
    expect(after.llm.model).toBe('local-model')
    // A shallow assign would have wiped these back to schema defaults, which
    // looks identical to "the user never set them".
    expect(after.llm.temperature).toBe(0.7)
    expect(after.llm.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('replaces arrays wholesale instead of merging by index', () => {
    // `library.roots` is a set the user edits. An index-wise merge would make
    // removing the first of two roots impossible to express as a patch.
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.update({ library: { roots: ['/a', '/b'] } })
    expect(service.update({ library: { roots: ['/b'] } }).library.roots).toEqual(['/b'])
  })

  it('treats an explicit undefined as "not specified", not as a delete', () => {
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.update({ llm: { model: 'chosen-model' } })
    expect(service.update({ llm: { model: undefined } }).llm.model).toBe('chosen-model')
  })

  it('rejects an invalid patch without corrupting what is stored', () => {
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.update({ llm: { model: 'good-model' } })

    // Out of the schema's range. The throw is the lesser assertion; the point is
    // that a rejected patch leaves no partial write behind.
    expect(() => service.update({ llm: { temperature: 99 } })).toThrow()
    expect(service.get().llm.model).toBe('good-model')
    expect(service.get().llm.temperature).toBe(0.7)
    expect(createSettingsService(fs, PATH).get().llm.temperature).toBe(0.7)
  })
})

describe('unknown keys survive load→save', () => {
  it('preserves a root-level key from a newer build', () => {
    const fs = memoryFs(
      JSON.stringify({ version: 1, futureFeature: { enabled: true } }),
    )
    const service = createSettingsService(fs, PATH)
    service.update({ ui: { theme: 'light' } })
    expect(onDisk(fs)['futureFeature']).toEqual({ enabled: true })
  })

  it('preserves a nested key that the sub-schema would strip', () => {
    // The case that actually breaks. `llmSettingsSchema` is a plain `z.object`,
    // so zod drops `experimentalReasoning` from its output — the document only
    // keeps it because `load()` merges the validated view over the raw parse
    // rather than adopting it.
    const fs = memoryFs(
      JSON.stringify({
        version: 1,
        llm: { model: 'gpt-4o', experimentalReasoning: 'high' },
      }),
    )
    const service = createSettingsService(fs, PATH)
    service.update({ ui: { theme: 'light' } })

    const llm = onDisk(fs)['llm'] as Record<string, unknown>
    expect(llm['experimentalReasoning']).toBe('high')
    // And the known field is still correct, so this is preservation rather than
    // the whole raw section being passed through unvalidated.
    expect(llm['model']).toBe('gpt-4o')
  })

  it('preserves a nested key across an update to its own section', () => {
    // Stricter than the previous test: the patch touches `llm` itself, so the
    // unknown key has to survive the merge path rather than just being in an
    // untouched branch.
    const fs = memoryFs(
      JSON.stringify({ version: 1, llm: { experimentalReasoning: 'high' } }),
    )
    const service = createSettingsService(fs, PATH)
    service.update({ llm: { model: 'gpt-5' } })

    const llm = onDisk(fs)['llm'] as Record<string, unknown>
    expect(llm['experimentalReasoning']).toBe('high')
    expect(llm['model']).toBe('gpt-5')
  })

  it('survives repeated load→save cycles', () => {
    // Once is not enough: a bug that drops the key on the *second* save would
    // pass every test above, and a rollback is followed by ordinary use.
    const fs = memoryFs(JSON.stringify({ version: 1, llm: { futureKnob: 7 } }))
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const service = createSettingsService(fs, PATH)
      service.update({ ui: { showCoordinates: cycle % 2 === 0 } })
    }
    expect((onDisk(fs)['llm'] as Record<string, unknown>)['futureKnob']).toBe(7)
  })

  it('keeps unknown keys out of the document the renderer receives', () => {
    // The other half of forward-compat, and the reason `get()` is not simply the
    // raw document: the renderer's `Settings` type has no field for an unknown
    // key, so handing one over would be a value the type says cannot exist.
    // Preserved on disk, absent from the view.
    const fs = memoryFs(JSON.stringify({ version: 1, llm: { futureKnob: 7 } }))
    const view = createSettingsService(fs, PATH).get()
    expect(
      (view.llm as unknown as Record<string, unknown>)['futureKnob'],
    ).toBeUndefined()
  })
})

describe('corrupt and invalid files', () => {
  it('falls back to defaults on unparseable JSON and preserves the file', () => {
    const fs = memoryFs('{ this is not json')
    // Settings are recoverable state. Refusing to launch because one of them is
    // malformed would be a worse outcome than launching with defaults.
    expect(createSettingsService(fs, PATH).get().llm.model).toBe('gpt-4o')
    // The bad file is evidence of what went wrong; overwriting it destroys the
    // only copy.
    expect(fs.files.get(`${PATH}.corrupt`)).toBe('{ this is not json')
  })

  it('falls back to defaults when a value fails validation', () => {
    const fs = memoryFs(JSON.stringify({ version: 1, llm: { temperature: 42 } }))
    expect(createSettingsService(fs, PATH).get().llm.temperature).toBe(0.7)
    expect(fs.files.has(`${PATH}.corrupt`)).toBe(true)
  })

  it('does not overwrite the corrupt file until something is saved', () => {
    const fs = memoryFs('not json')
    createSettingsService(fs, PATH)
    expect(fs.written()).toBe('not json')
  })
})

describe('the secrets field is not reachable from a patch', () => {
  it('ignores a patch that tries to write ciphertext', () => {
    // `settings:set`'s schema is `settingsSchema.partial()`, which is `.loose()`
    // — an unknown key passes validation. So the strip in `update` is the only
    // thing stopping a renderer from overwriting the encrypted blob.
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.secretStore.write('llmApiKey', 'real-ciphertext')

    service.update({ secretBlobs: { llmApiKey: 'attacker-supplied' } })

    expect(service.secretStore.read('llmApiKey')).toBe('real-ciphertext')
    expect(JSON.stringify(onDisk(fs))).not.toContain('attacker-supplied')
  })

  it('keeps ciphertext out of the document the renderer receives', () => {
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.secretStore.write('llmApiKey', 'ciphertext-value')
    expect(JSON.stringify(service.get())).not.toContain('ciphertext-value')
  })

  it('persists ciphertext across a reload and survives an unrelated update', () => {
    const fs = memoryFs()
    const first = createSettingsService(fs, PATH)
    first.secretStore.write('llmApiKey', 'ciphertext-value')

    const second = createSettingsService(fs, PATH)
    expect(second.secretStore.read('llmApiKey')).toBe('ciphertext-value')

    // The secrets field is not in `settingsSchema`, so it survives a save for
    // the same `.loose()` reason unknown keys do. If that ever broke, the user's
    // stored key would vanish on the next settings change.
    second.update({ ui: { theme: 'light' } })
    expect(createSettingsService(fs, PATH).secretStore.read('llmApiKey')).toBe(
      'ciphertext-value',
    )
  })

  it('deletes a secret when written as undefined', () => {
    const fs = memoryFs()
    const service = createSettingsService(fs, PATH)
    service.secretStore.write('llmApiKey', 'ciphertext-value')
    service.secretStore.write('llmApiKey', undefined)
    expect(service.secretStore.read('llmApiKey')).toBeUndefined()
    expect(JSON.stringify(onDisk(fs))).not.toContain('ciphertext-value')
  })

  it('reports a missing secret as absent rather than throwing', () => {
    // Expected absence is a state, not an exception.
    expect(
      createSettingsService(memoryFs(), PATH).secretStore.read('foxSessionToken'),
    ).toBeUndefined()
  })
})

describe('an invalid patch is rejected with paths but never values', () => {
  it('throws SETTINGS_INVALID naming the offending field', () => {
    const service = createSettingsService(memoryFs(), PATH)
    try {
      service.update({ ui: { locale: 'klingon' } })
      throw new Error('update should have thrown')
    } catch (error) {
      // Not `toThrow(/SETTINGS_INVALID/)`: that matches the message, and the
      // whole point of a domain `code` is that the renderer branches on it
      // rather than on prose.
      const failure = error as { code?: string; context?: { issues?: string[] } }
      expect(failure.code).toBe('SETTINGS_INVALID')
      expect(failure.context?.issues).toEqual(['ui.locale'])
    }
  })

  it('does not put the rejected value in the error', () => {
    // The realistic leak: a user pastes an API key into the wrong field, the
    // patch is rejected, and a zod issue quotes what they typed. `issuePaths`
    // exists to make that impossible; this is the test that keeps it that way.
    const service = createSettingsService(memoryFs(), PATH)
    try {
      service.update({ ui: { theme: 'sk-live-4eC39HqLyjWDarjtT1zdp7dc' } })
      throw new Error('update should have thrown')
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('sk-live')
      const failure = error as { context?: { issues?: string[] } }
      expect(failure.context?.issues).toEqual(['ui.theme'])
    }
  })

  it('reports a top-level field by its name, not as (root)', () => {
    // A deliberate contrast with the `(root)` case: `version` is a top-level
    // *field*, so its path is `['version']` and it must be named. `(root)` is
    // reserved for an issue with an empty path — the value not being an object at
    // all — which `settingsSchema` cannot produce here because `deepMerge` always
    // hands it one. That case is covered where it is reachable, at the IPC
    // boundary (`handlers.test.ts`), against the same shared helper.
    const service = createSettingsService(memoryFs(), PATH)
    try {
      service.update({ version: 'not-a-number' })
      throw new Error('update should have thrown')
    } catch (error) {
      const failure = error as { context?: { issues?: string[] } }
      expect(failure.context?.issues).toEqual(['version'])
    }
  })
})
