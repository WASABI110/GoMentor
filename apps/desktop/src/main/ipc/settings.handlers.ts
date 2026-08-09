import { handle } from './register'
import { scoped, setDebugEnabled } from '../logger'
import type { SettingsService } from '../settings'
import type { SecretsService } from '../safe-storage'

/**
 * Settings and secret channels.
 *
 * ## The asymmetry that matters
 *
 * `settings:get` and `settings:set` move the whole document. `settings:setSecret`
 * moves a value **main-ward only**, and there is deliberately no
 * `settings:getSecret`. The only secret-derived fact that ever crosses to the
 * renderer is the `hasKey` boolean, because the UI needs to show whether a key
 * is configured and nothing more (`design.md` §Settings and secrets).
 *
 * If a future channel is proposed that returns a key to the renderer — to
 * pre-fill an input, say — the answer is a masked placeholder plus a
 * write-only field. A key in the renderer is a key in a process that runs
 * remote-influenced content.
 */

const logger = scoped('main:settings')

export function registerSettingsHandlers(
  settings: SettingsService,
  secrets: SecretsService,
): void {
  handle('settings:get', () => {
    const document = settings.get()
    // `hasKey` is a read-only mirror of secret presence, and the source of truth
    // is the secrets service, not the document. Recomputed on every read rather
    // than written into the file: a stored boolean would drift the moment a
    // keychain became unavailable or a blob failed to decrypt, and the UI would
    // then offer to use a key that cannot be read.
    return {
      ...document,
      llm: { ...document.llm, hasKey: secrets.has('llmApiKey') },
    }
  })

  handle('settings:set', (request) => {
    const updated = settings.update(request.patch)

    // Debug logging is toggleable at runtime precisely so a user can produce a
    // useful log without a rebuild (`logging-guidelines.md`). Applying it here,
    // at the write, is what makes that immediate rather than next-launch.
    setDebugEnabled(updated.debugLogging)

    // Keys, not values: a patch can contain a `baseUrl`, and settings are the
    // one place a user might paste a key into the wrong field.
    logger.info('settings updated', { keys: Object.keys(request.patch) })

    return { ...updated, llm: { ...updated.llm, hasKey: secrets.has('llmApiKey') } }
  })

  handle('settings:setSecret', (request) => {
    // An empty value means "clear it". Treated as a delete rather than stored as
    // an empty secret, so `hasKey` goes false and the UI stops claiming a key is
    // configured.
    if (request.value === '') {
      secrets.delete(request.key)
      return {}
    }

    // `secrets.set` throws SETTINGS_ENCRYPTION_UNAVAILABLE *after* accepting the
    // value into memory — the throw is how the renderer learns to warn that the
    // key will not survive a restart, not a signal that it was rejected. Left
    // uncaught on purpose: `register.ts` turns it into an envelope with that
    // code, and the renderer translates it into the warning.
    //
    // Note what is absent: no `catch` that swallows it, and no plaintext
    // fallback. Either would turn a visible degradation into an invisible one.
    secrets.set(request.key, request.value)
    return {}
  })

  handle('settings:hasSecret', (request) => ({ present: secrets.has(request.key) }))
}
