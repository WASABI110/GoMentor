import { z } from 'zod'
import { engineBackendSchema } from './analysis'

/**
 * Persisted settings.
 *
 * Unknown keys must survive a load→save cycle: a user who runs a newer build
 * then rolls back must not lose their newer settings. `.loose()` on the root
 * schema is what guarantees that at the root, and it is tested. Note the limit:
 * `.loose()` keeps unknown keys only at the level it is applied, so an unknown
 * key *nested* under a sub-schema is still stripped by `parse`. Preserving those
 * is `settings.ts`'s job — it merges the validated output back over the raw
 * document rather than persisting the parsed view.
 *
 * Reading a value out of this schema is not the same as accepting one into it.
 * Every field here carries a `.default()`, which means `parse` never returns a
 * partial document — see `settingsPatchSchema` for why that made `.partial()`
 * the wrong schema for an incoming patch.
 *
 * Secrets are never in here as plaintext. The API key lives in an opaque
 * `safeStorage`-encrypted blob; only the `hasKey` boolean crosses to the
 * renderer.
 */

export const localeSchema = z.enum(['zh-CN', 'en', 'ja', 'ko', 'th', 'vi'])
export type Locale = z.infer<typeof localeSchema>

/**
 * Cloud API and a local server differ only in baseUrl, key presence, and
 * timeout/retry policy — both speak OpenAI-compatible. One adapter, two
 * factories.
 */
export const llmProviderKindSchema = z.enum(['cloud', 'local'])
export type LlmProviderKind = z.infer<typeof llmProviderKindSchema>

export const llmSettingsSchema = z.object({
  kind: llmProviderKindSchema.default('cloud'),
  baseUrl: z.url().default('https://api.openai.com/v1'),
  model: z.string().default('gpt-4o'),
  /**
   * Read-only mirror of whether a key is stored. The key itself never leaves
   * the main process. Never write this from the renderer.
   */
  hasKey: z.boolean().default(false),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).default(4096),
  /**
   * Whether tool-calling actually works, as measured by probeCapabilities.
   * Support varies by *model*, not just by server, so it cannot be inferred
   * from configuration. `null` means not yet probed.
   */
  toolsSupported: z.boolean().nullable().default(null),
})
export type LlmSettings = z.infer<typeof llmSettingsSchema>

export const engineSettingsSchema = z.object({
  /** null = auto-detect by benchmarking each candidate. */
  backend: engineBackendSchema.nullable().default(null),
  /** Absent means use the bundled engine. */
  binaryPath: z.string().optional(),
  networkPath: z.string().optional(),
  maxVisits: z.number().int().min(1).default(500),
  threads: z.number().int().min(1).default(4),
  analyzeOwnership: z.boolean().default(true),
})
export type EngineSettings = z.infer<typeof engineSettingsSchema>

export const librarySettingsSchema = z.object({
  /** Watched for new SGF files. */
  roots: z.array(z.string()).default([]),
  watchEnabled: z.boolean().default(true),
})
export type LibrarySettings = z.infer<typeof librarySettingsSchema>

export const uiSettingsSchema = z.object({
  locale: localeSchema.default('zh-CN'),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  showCoordinates: z.boolean().default(true),
  animationsEnabled: z.boolean().default(true),
  /** Panel widths in px, persisted so layout survives restart. */
  panelWidths: z
    .object({ library: z.number().default(260), teacher: z.number().default(360) })
    .prefault({}),
})
export type UiSettings = z.infer<typeof uiSettingsSchema>

export const settingsSchema = z
  .object({
    /** Bumped only for breaking migrations. */
    version: z.number().int().min(1).default(1),
    // `.prefault({})` not `.default({})`: in zod 4, `.default` uses the value
    // as the output verbatim, so a nested section would come back as a literal
    // `{}` with none of its own defaults applied. `.prefault` feeds the value
    // through the schema first, which is what recursively fills them in.
    llm: llmSettingsSchema.prefault({}),
    engine: engineSettingsSchema.prefault({}),
    library: librarySettingsSchema.prefault({}),
    ui: uiSettingsSchema.prefault({}),
    /** Opt-in, default off, no-op until consented. No content, ever. */
    telemetryConsent: z.boolean().default(false),
    debugLogging: z.boolean().default(false),
  })
  // Forward-compatibility: a newer build's keys survive a rollback's save.
  // `.loose()` is zod 4's spelling; `.passthrough()` is deprecated.
  .loose()

export type Settings = z.infer<typeof settingsSchema>

/**
 * A patch: every field optional, and — critically — **no defaults applied**.
 *
 * ## Why this is not `settingsSchema.partial()`
 *
 * `.partial()` makes keys optional on *input*, but it does not remove the
 * `.default()` on each field, and in zod 4 a defaulted field always produces a
 * value. So `settingsSchema.partial().parse({ llm: { model: 'x' } })` returns the
 * whole document filled with defaults — and since `register.ts` hands the
 * handler zod's *output*, a patch naming one field arrived at `settings.update`
 * carrying an explicit value for every other field.
 *
 * The user-visible consequence: changing the model reset theme to dark, locale
 * to zh-CN, and every other preference the user had set. Silently, with no
 * error. Found by an integration test asserting a sibling field survived — the
 * unit test missed it because calling `settings.update` directly skips request
 * validation, which is where the inflation happened.
 *
 * ## Why the fields are written out rather than derived
 *
 * A helper walking `settingsSchema` and stripping `.default()` wrappers has to
 * read zod's internal `def`, and if a zod upgrade changed that shape the helper
 * would degrade to passing everything through unvalidated — a patch schema that
 * validates nothing, failing open. Explicit is longer but it cannot break
 * quietly, and a new setting that someone forgets to add here is rejected rather
 * than accepted unchecked.
 *
 * Constraints are reused from the sections above (`.min`/`.max`, the enums), so
 * a bound tightened there tightens here too. Only the defaults are dropped.
 */
const llmPatchSchema = z.object({
  kind: llmProviderKindSchema.optional(),
  baseUrl: z.url().optional(),
  model: z.string().optional(),
  // `hasKey` is intentionally absent: it is a read-only mirror of secret
  // presence, recomputed by `settings:get` from the secrets service. Accepting it
  // here would let the renderer claim a key exists.
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional(),
  toolsSupported: z.boolean().nullable().optional(),
})

const enginePatchSchema = z.object({
  backend: engineBackendSchema.nullable().optional(),
  binaryPath: z.string().optional(),
  networkPath: z.string().optional(),
  maxVisits: z.number().int().min(1).optional(),
  threads: z.number().int().min(1).optional(),
  analyzeOwnership: z.boolean().optional(),
})

const libraryPatchSchema = z.object({
  roots: z.array(z.string()).optional(),
  watchEnabled: z.boolean().optional(),
})

const uiPatchSchema = z.object({
  locale: localeSchema.optional(),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  showCoordinates: z.boolean().optional(),
  animationsEnabled: z.boolean().optional(),
  panelWidths: z
    .object({ library: z.number().optional(), teacher: z.number().optional() })
    .optional(),
})

export const settingsPatchSchema = z
  .object({
    // `version` is absent on purpose: it is bumped by a migration in main, not
    // by the renderer.
    llm: llmPatchSchema.optional(),
    engine: enginePatchSchema.optional(),
    library: libraryPatchSchema.optional(),
    ui: uiPatchSchema.optional(),
    telemetryConsent: z.boolean().optional(),
    debugLogging: z.boolean().optional(),
  })
  // Same forward-compat reason as `settingsSchema`: a newer renderer patching a
  // key this build does not know must not have it rejected.
  .loose()

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

/** Secrets are addressed by name; values never cross IPC. */
export const secretKeySchema = z.enum(['llmApiKey', 'foxSessionToken'])
export type SecretKey = z.infer<typeof secretKeySchema>
