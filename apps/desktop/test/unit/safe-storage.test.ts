import { describe, expect, it, beforeEach } from 'vitest'
import { isAppError, type SecretKey } from '@gomentor/shared'
import {
  clearSessionSecrets,
  createSecretsService,
  type Encryptor,
  type SecretStore,
} from '../../src/main/safe-storage'

/**
 * A10, unit half: the `safeStorage`-unavailable path must **refuse to persist**
 * rather than falling back to plaintext.
 *
 * ## Why this is tested rather than reviewed
 *
 * `design.md` §Delivery verification names this as one of the "wrong but looks
 * right" cases. A plaintext fallback would leave the app fully working — keys
 * accepted, keys readable, nothing in the UI different — so nothing would ever
 * prompt anyone to look. The only way the guarantee holds is if something fails
 * when it breaks.
 *
 * The assertions below are therefore about **what reaches the store**, not about
 * what the service returned. A test that only checked for a thrown error would
 * still pass if the value were written to disk on the way out.
 */

/** A store that records writes so the test can assert on what was persisted. */
function recordingStore(): SecretStore & { written: Map<string, string | undefined> } {
  const written = new Map<string, string | undefined>()
  return {
    written,
    read(key) {
      return written.get(key)
    },
    write(key, ciphertext) {
      written.set(key, ciphertext)
    },
  }
}

/**
 * Encryptor with switchable availability. Not a mock of Electron's module
 * registry: `safeStorage` is a singleton that cannot be constructed, and a test
 * that stubbed the import would be asserting on its own stub rather than on the
 * refusal. Injecting the seam is what makes the real path reachable under plain
 * Node.
 */
function fakeEncryptor(available: boolean): Encryptor {
  return {
    isEncryptionAvailable: () => available,
    // A recognisable, reversible transform — enough to prove the value was
    // encrypted rather than stored verbatim, without pretending to be crypto.
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (ciphertext) => {
      const text = ciphertext.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this encryptor')
      return text.slice(4)
    },
  }
}

const KEY: SecretKey = 'llmApiKey'
// Key-shaped on purpose: `quality-guidelines.md` requires redaction to be tested
// with a key-shaped value, and the same value is used here so a leak into the
// store would look exactly like the real thing.
const SECRET = 'sk-live-4eC39HqLyjWDarjtT1zdp7dc'

beforeEach(() => {
  // Session-only state is module-level, so it survives between cases and would
  // otherwise make each test depend on the order of the ones before it.
  clearSessionSecrets()
})

describe('secrets with encryption available', () => {
  it('persists ciphertext, never the plaintext', () => {
    const store = recordingStore()
    const secrets = createSecretsService(store, fakeEncryptor(true))

    secrets.set(KEY, SECRET)

    const persisted = store.written.get(KEY)
    expect(persisted).toBeDefined()
    // The assertion that matters: the plaintext must not appear anywhere in what
    // was written, in any encoding. Checking `!== SECRET` would pass for a value
    // that merely wrapped it.
    expect(persisted).not.toContain(SECRET)
    expect(Buffer.from(persisted ?? '', 'base64').toString('utf8')).not.toBe(SECRET)
    expect(secrets.get(KEY)).toBe(SECRET)
    expect(secrets.has(KEY)).toBe(true)
    expect(secrets.isPersistent()).toBe(true)
  })

  it('reports absence as undefined rather than throwing', () => {
    const secrets = createSecretsService(recordingStore(), fakeEncryptor(true))
    // Expected absence is a state, not an exception (`error-handling.md`).
    expect(secrets.get(KEY)).toBeUndefined()
    expect(secrets.has(KEY)).toBe(false)
  })

  it('deletes by removing the stored blob', () => {
    const store = recordingStore()
    const secrets = createSecretsService(store, fakeEncryptor(true))

    secrets.set(KEY, SECRET)
    secrets.delete(KEY)

    expect(store.written.get(KEY)).toBeUndefined()
    expect(secrets.has(KEY)).toBe(false)
  })
})

describe('secrets with encryption unavailable (A10)', () => {
  it('refuses to persist and writes nothing at all', () => {
    const store = recordingStore()
    const secrets = createSecretsService(store, fakeEncryptor(false))

    expect(() => {
      secrets.set(KEY, SECRET)
    }).toThrow()

    // The load-bearing assertion: nothing reached the store. Not the plaintext,
    // not a wrapped form, not an empty placeholder. `written` is empty rather
    // than holding `undefined` — a `write` call at all would mean the code took
    // the persist path and only the value differed.
    expect(store.written.size).toBe(0)
  })

  it('throws SETTINGS_ENCRYPTION_UNAVAILABLE, so the renderer can warn', () => {
    const secrets = createSecretsService(recordingStore(), fakeEncryptor(false))

    let caught: unknown
    try {
      secrets.set(KEY, SECRET)
    } catch (error) {
      caught = error
    }

    expect(isAppError(caught)).toBe(true)
    // The specific code, not merely "an error": the renderer translates `code`
    // through the `errors` i18n namespace, so a generic code would show the
    // wrong warning — or none.
    expect(isAppError(caught) ? caught.code : undefined).toBe(
      'SETTINGS_ENCRYPTION_UNAVAILABLE',
    )
  })

  it('holds the value for the session so the app stays usable', () => {
    const secrets = createSecretsService(recordingStore(), fakeEncryptor(false))

    // The throw is a warning, not a rejection — the value *was* accepted.
    // Refusing outright would leave affected users unable to use the feature at
    // all; this degrades honestly instead, at the cost of a re-entry per launch.
    expect(() => {
      secrets.set(KEY, SECRET)
    }).toThrow()

    expect(secrets.get(KEY)).toBe(SECRET)
    expect(secrets.has(KEY)).toBe(true)
    // And says so, which is what drives the UI warning.
    expect(secrets.isPersistent()).toBe(false)
  })

  it('does not leak the session value into a later persisted write', () => {
    // A user whose keychain recovers mid-session: the session value must be
    // superseded, not merged, or `get` would keep returning the old key.
    const store = recordingStore()
    const unavailable = fakeEncryptor(false)
    const secrets = createSecretsService(store, unavailable)

    expect(() => {
      secrets.set(KEY, 'sk-old-session-value')
    }).toThrow()

    const working = createSecretsService(store, fakeEncryptor(true))
    working.set(KEY, SECRET)

    expect(working.get(KEY)).toBe(SECRET)
    // Read through a fresh service too, proving the persisted blob — not the
    // in-memory map — is what now answers.
    expect(createSecretsService(store, fakeEncryptor(true)).get(KEY)).toBe(SECRET)
  })
})

describe('secrets when the keychain breaks after a write', () => {
  it('treats an unreadable stored secret as absent rather than throwing', () => {
    const store = recordingStore()
    createSecretsService(store, fakeEncryptor(true)).set(KEY, SECRET)

    // Same store, encryption now gone — a laptop whose Secret Service stopped.
    const degraded = createSecretsService(store, fakeEncryptor(false))

    // Absent, not an error: the caller's next step is the same as for a missing
    // key, and throwing would turn a degraded launch into a failed one.
    expect(degraded.get(KEY)).toBeUndefined()
    // `has` still reports true — the blob exists, it just cannot be read. The
    // distinction matters: the UI should say "re-enter your key", not "no key
    // configured", which would imply nothing was ever saved.
    expect(degraded.has(KEY)).toBe(true)
  })

  it('treats a corrupt blob as absent', () => {
    const store = recordingStore()
    store.write(
      KEY,
      Buffer.from('garbage that is not our ciphertext', 'utf8').toString('base64'),
    )

    const secrets = createSecretsService(store, fakeEncryptor(true))

    // Written under a different OS user, or corrupted. Reported and treated as
    // absent rather than crashing the settings read.
    expect(secrets.get(KEY)).toBeUndefined()
  })
})
