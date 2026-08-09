import { safeStorage } from 'electron'
import { AppError, type SecretKey } from '@gomentor/shared'
import { scoped } from './logger'

/**
 * Secret storage, wrapping Electron's `safeStorage` (OS keychain / DPAPI).
 *
 * ## The load-bearing rule
 *
 * `safeStorage.isEncryptionAvailable()` returns false on real configurations —
 * a Linux desktop with no Secret Service running is the common one. When it
 * does, this module **refuses to persist** and holds the value in memory for
 * the session only (`design.md` §Settings and secrets).
 *
 * It must never fall back to writing plaintext. That would be a security
 * downgrade the user never agreed to, and worse, an invisible one: the app
 * would keep working, so nothing would ever prompt anyone to look. The failure
 * is surfaced instead — `SETTINGS_ENCRYPTION_UNAVAILABLE` reaches the renderer,
 * which shows a warning that the key will not survive a restart.
 *
 * This is one of the "wrong but looks right" cases the verification model calls
 * out by name (`design.md` §Delivery verification), which is why A10 requires
 * the unavailable path to be tested rather than reviewed.
 *
 * ## Why the in-memory fallback exists at all
 *
 * Refusing outright would leave the app unusable for those users. Holding the
 * key for the session keeps it working, degrades honestly, and costs them a
 * re-entry per launch — a tradeoff they can see, which is the whole difference.
 */

const logger = scoped('main:secrets')

/**
 * Session-only values, used when encryption is unavailable. Not a cache: when
 * encryption *is* available, nothing is held here, so there is no path where a
 * stale in-memory value shadows what is on disk.
 */
const sessionOnly = new Map<SecretKey, string>()

/**
 * Persisted ciphertext, base64-encoded. Injected by `settings.ts` rather than
 * read from disk here: this module owns encryption, the settings module owns the
 * document. Splitting them keeps `safeStorage` out of the settings tests and the
 * settings file format out of these.
 */
export interface SecretStore {
  read(key: SecretKey): string | undefined
  write(key: SecretKey, ciphertext: string | undefined): void
}

/**
 * Injectable for tests. `safeStorage` is an Electron singleton that cannot be
 * constructed, and a test that mocks the module registry rather than an
 * interface ends up asserting on the mock — A10 requires the unavailable path
 * to be genuinely exercised, so it has to be reachable without Electron.
 */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

export interface SecretsService {
  /**
   * Stores a secret. Throws `SETTINGS_ENCRYPTION_UNAVAILABLE` after accepting
   * the value into memory — the throw is how the renderer learns to warn, not a
   * signal that the value was rejected. Callers must treat it as "stored, but
   * only for this session".
   */
  set(key: SecretKey, value: string): void
  /** Returns undefined when absent. Absence is a state, not an error. */
  get(key: SecretKey): string | undefined
  /** The only secret-related fact that crosses to the renderer. */
  has(key: SecretKey): boolean
  delete(key: SecretKey): void
  /** Whether persistence is possible; drives the UI warning. */
  isPersistent(): boolean
}

export function createSecretsService(
  store: SecretStore,
  encryptor: Encryptor,
): SecretsService {
  return {
    set(key, value) {
      if (!encryptor.isEncryptionAvailable()) {
        sessionOnly.set(key, value)
        // No `value` in these fields, and none in the message. The redaction
        // serializer would catch `llmApiKey`, but relying on it here would be
        // treating the backstop as permission (`logging-guidelines.md`).
        logger.warn('encryption unavailable, secret held in memory only', { key })
        throw new AppError(
          'SETTINGS_ENCRYPTION_UNAVAILABLE',
          'OS encryption is unavailable; the secret is held for this session only and will not survive a restart',
          { context: { key } },
        )
      }
      const ciphertext = encryptor.encryptString(value)
      store.write(key, ciphertext.toString('base64'))
      // Any session-only value for this key is now superseded. Left in place it
      // would win over the persisted one in `get`, so a user who fixed their
      // keychain mid-session would keep getting the old key.
      sessionOnly.delete(key)
      logger.info('secret stored', { key })
    },

    get(key) {
      const session = sessionOnly.get(key)
      if (session !== undefined) return session

      const stored = store.read(key)
      if (stored === undefined) return undefined
      if (!encryptor.isEncryptionAvailable()) {
        // Ciphertext exists but cannot be read — the keychain became
        // unavailable since it was written. Not an error: the caller's next
        // step is the same as for a missing key, and throwing here would turn
        // a degraded launch into a failed one.
        logger.warn('stored secret unreadable, encryption unavailable', { key })
        return undefined
      }
      try {
        return encryptor.decryptString(Buffer.from(stored, 'base64'))
      } catch (error) {
        // Corrupt or written under a different OS user. Same reasoning as
        // above: report and treat as absent.
        logger.failure('secret decryption failed', error, { key })
        return undefined
      }
    },

    has(key) {
      return sessionOnly.has(key) || store.read(key) !== undefined
    },

    delete(key) {
      sessionOnly.delete(key)
      store.write(key, undefined)
      logger.info('secret deleted', { key })
    },

    isPersistent() {
      return encryptor.isEncryptionAvailable()
    },
  }
}

/**
 * The real Electron encryptor. Separated from `createSecretsService` so tests
 * never touch the Electron singleton — see `Encryptor`'s note.
 */
export const electronEncryptor: Encryptor = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plaintext) => safeStorage.encryptString(plaintext),
  decryptString: (ciphertext) => safeStorage.decryptString(ciphertext),
}

/** Test seam: clears session-only state between cases. */
export function clearSessionSecrets(): void {
  sessionOnly.clear()
}
