import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AppError,
  settingsSchema,
  type SecretKey,
  type Settings,
} from '@gomentor/shared'
import { scoped } from './logger'
import { issuePaths } from './redact'
import { settingsFile } from './paths'
import type { SecretStore } from './safe-storage'

/**
 * The settings document: zod-validated, migration-safe, and forward-compatible.
 *
 * ## Unknown keys must survive load→save
 *
 * A user who runs a newer build and then rolls back must not silently lose the
 * newer build's settings. `settingsSchema` is `.loose()` for exactly this, but
 * the schema alone is not enough — this module must also avoid rebuilding the
 * document from known fields on save, which is the usual way the guarantee gets
 * broken by someone who reads the schema and assumes it is handled. It is
 * tested (`quality-guidelines.md`: "Forward-compat is a correctness property,
 * not a nicety").
 *
 * ## Why a corrupt file does not throw
 *
 * An unparseable or invalid settings file yields defaults plus a `warn`, not a
 * failed launch. Settings are recoverable state; refusing to start because one
 * of them is out of range would be a worse outcome than starting with the
 * default. The bad file is preserved as `.corrupt` so nothing is destroyed —
 * writing over it would remove the only evidence of what went wrong.
 */

const logger = scoped('main:settings')

/**
 * Where encrypted secrets live inside the document. Under one key rather than
 * scattered next to their related settings, so `settings:get` can strip exactly
 * one field before the document crosses to the renderer.
 *
 * Not in `settingsSchema`: the renderer's `Settings` type must not have a field
 * for it, or some future code will read it there. The `.loose()` schema
 * preserves it through validation without naming it, which is the same
 * mechanism that preserves a newer build's keys.
 */
const SECRETS_FIELD = 'secretBlobs'

export interface SettingsService {
  /** The validated document. Never includes secret ciphertext. */
  get(): Settings
  /** Deep-merges a patch, validates, persists, returns the new document. */
  update(patch: Record<string, unknown>): Settings
  /** Backing store for `safe-storage.ts`. */
  secretStore: SecretStore
}

/** Filesystem seam. Tests supply an in-memory implementation. */
export interface SettingsFs {
  read(path: string): string | undefined
  write(path: string, contents: string): void
  /** Preserves a corrupt file instead of overwriting it. */
  preserve(path: string, contents: string): void
}

export const nodeSettingsFs: SettingsFs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      // ENOENT is the first-launch path and is not notable. Anything else —
      // EACCES, EISDIR — is worth a line, because it will present to the user
      // as "my settings keep resetting".
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.failure('settings read failed', error, { path })
      }
      return undefined
    }
  },
  write(path, contents) {
    mkdirSync(dirname(path), { recursive: true })
    // Write-then-rename. A direct write that is interrupted — power loss, or a
    // crash between truncate and write — leaves a truncated JSON file, and the
    // recovery path for that is "settings reset to defaults". `rename` within a
    // directory is atomic on both NTFS and POSIX.
    const temporary = `${path}.tmp`
    writeFileSync(temporary, contents, 'utf8')
    renameSync(temporary, path)
  },
  preserve(path, contents) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.corrupt`, contents, 'utf8')
  },
}

/**
 * Recursive merge. Only plain objects recurse; arrays replace wholesale.
 *
 * Arrays deliberately do not merge element-wise: `library.roots` is a set the
 * user edits, and an index-wise merge would make removing the first of two
 * roots impossible to express as a patch.
 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    // An explicit `undefined` in a patch means "not specified", not "delete".
    // zod strips undefined optionals anyway, and treating it as a delete would
    // make `{ llm: { model: undefined } }` silently clear a setting.
    if (value === undefined) continue
    const existing = out[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value)
      continue
    }
    out[key] = value
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createSettingsService(
  fs: SettingsFs = nodeSettingsFs,
  path: string = settingsFile(),
): SettingsService {
  /**
   * The full document including the secrets field — the raw thing on disk.
   * `get()` returns a stripped copy; this is what gets written back, which is
   * what makes unknown keys and secret ciphertext survive a save.
   */
  let document: Record<string, unknown> = load()

  function load(): Record<string, unknown> {
    const raw = fs.read(path)
    if (raw === undefined) {
      logger.info('no settings file, using defaults')
      return settingsSchema.parse({})
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      logger.failure('settings file is not valid JSON, using defaults', error, { path })
      fs.preserve(path, raw)
      return settingsSchema.parse({})
    }

    const result = settingsSchema.safeParse(parsed)
    if (!result.success) {
      // Only issue paths are logged, never values: a settings file holds a
      // `baseUrl` and could hold a mistakenly-pasted key, and zod issues quote
      // the offending input.
      logger.warn('settings file failed validation, using defaults', {
        path,
        issues: result.error.issues.map((issue) => issue.path.join('.')),
      })
      fs.preserve(path, raw)
      return settingsSchema.parse({})
    }

    // `parsed`, not `result.data`: zod's output is the validated view, and
    // merging it over the raw document is what preserves keys the schema does
    // not name. `.loose()` keeps unknown *root* keys, but nested unknown keys
    // under a strict sub-schema would be dropped, and a rolled-back build's new
    // setting is most likely nested.
    //
    // No cast on `result.data` here or above: `settingsSchema` is `.loose()`, so
    // its inferred output already carries an index signature and *is* a
    // `Record<string, unknown>`.
    const merged = isPlainObject(parsed) ? deepMerge(parsed, result.data) : result.data
    logger.info('settings loaded')
    return merged
  }

  function persist(): void {
    try {
      fs.write(path, JSON.stringify(document, null, 2))
    } catch (error) {
      logger.failure('settings write failed', error, { path })
      throw new AppError('SETTINGS_WRITE_FAILED', 'Could not write the settings file', {
        cause: error,
        context: { path },
      })
    }
  }

  /** The document minus secret ciphertext, validated. */
  function view(): Settings {
    const { [SECRETS_FIELD]: _secrets, ...rest } = document
    return settingsSchema.parse(rest)
  }

  function secretBlobs(): Record<string, unknown> {
    const existing = document[SECRETS_FIELD]
    return isPlainObject(existing) ? existing : {}
  }

  return {
    get: view,

    update(patch) {
      // The patch must not be able to reach the secrets field: it arrives from
      // the renderer, and `settings:set`'s schema is `settingsPatchSchema`,
      // which is `.loose()` — so an unknown key passes validation. Without this
      // strip, a renderer could overwrite or read-modify-write the ciphertext.
      const { [SECRETS_FIELD]: _rejected, ...safePatch } = patch
      if (_rejected !== undefined) {
        logger.warn('settings patch attempted to write the secrets field; ignored')
      }

      const candidate = deepMerge(document, safePatch)
      const result = settingsSchema.safeParse(candidate)
      if (!result.success) {
        throw new AppError('SETTINGS_INVALID', 'The settings patch is not valid', {
          context: { issues: issuePaths(result.error) },
        })
      }
      document = deepMerge(candidate, result.data)
      persist()
      return view()
    },

    secretStore: {
      read(key: SecretKey) {
        const value = secretBlobs()[key]
        return typeof value === 'string' ? value : undefined
      },
      write(key: SecretKey, ciphertext: string | undefined) {
        // Rebuilt by omission rather than `delete blobs[key]`: `delete` on a
        // computed member is banned by lint, for the case this is not — an
        // arbitrary key on a typed object.
        //
        // Purely a spelling change, and deliberately noted as such: assigning
        // `undefined` would be equivalent too, because `secretStore.read` tests
        // `typeof value === 'string'` rather than `in`, and `JSON.stringify`
        // omits undefined-valued keys on the way to disk. So presence and
        // `hasKey` are unaffected either way. Verified by mutation — swapping
        // this for the assigning form changes no test, which is the expected
        // result here, not a coverage gap.
        const { [key]: _cleared, ...remaining } = secretBlobs()
        const blobs =
          ciphertext === undefined ? remaining : { ...remaining, [key]: ciphertext }
        document = { ...document, [SECRETS_FIELD]: blobs }
        persist()
      },
    },
  }
}
