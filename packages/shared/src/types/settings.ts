import { z } from 'zod'
import { engineBackendSchema } from './analysis'

/**
 * Persisted settings.
 *
 * Unknown keys must survive a load→save cycle: a user who runs a newer build
 * then rolls back must not lose their newer settings. `.passthrough()` on the
 * root schema is what guarantees that, and it is tested.
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
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
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
    .default({ library: 260, teacher: 360 }),
})
export type UiSettings = z.infer<typeof uiSettingsSchema>

export const settingsSchema = z
  .object({
    /** Bumped only for breaking migrations. */
    version: z.number().int().min(1).default(1),
    llm: llmSettingsSchema.default({}),
    engine: engineSettingsSchema.default({}),
    library: librarySettingsSchema.default({}),
    ui: uiSettingsSchema.default({}),
    /** Opt-in, default off, no-op until consented. No content, ever. */
    telemetryConsent: z.boolean().default(false),
    debugLogging: z.boolean().default(false),
  })
  // Forward-compatibility: a newer build's keys survive a rollback's save.
  .passthrough()

export type Settings = z.infer<typeof settingsSchema>

/** Secrets are addressed by name; values never cross IPC. */
export const secretKeySchema = z.enum(['llmApiKey', 'foxSessionToken'])
export type SecretKey = z.infer<typeof secretKeySchema>
