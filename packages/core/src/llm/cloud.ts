import type { LlmSettings } from '@gomentor/shared'
import { OpenAICompatibleProvider } from './openai-compatible'
import type { ProviderCapabilities } from './provider'

/**
 * Cloud factory: short timeout, **2 retries**.
 *
 * A cloud API that fails or stalls is usually having a transient moment, and the
 * request is cheap to repeat — so retrying is worth it and waiting long is not.
 * The mirror-image reasoning for local is in `local.ts`; the asymmetry is the
 * whole reason there are two factories over one adapter.
 */

/** 60s. Long enough for a slow first token on a large cloud model. */
const CLOUD_TIMEOUT_MS = 60_000

/** Two, per `design.md` §LLM provider. */
const CLOUD_MAX_RETRIES = 2

export function createCloudProvider(
  settings: Pick<LlmSettings, 'baseUrl' | 'model' | 'toolsSupported'>,
  apiKey: string,
  capabilities?: Partial<ProviderCapabilities>,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    {
      kind: 'cloud',
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey,
      timeoutMs: CLOUD_TIMEOUT_MS,
      maxRetries: CLOUD_MAX_RETRIES,
    },
    { toolsSupported: settings.toolsSupported, ...capabilities },
  )
}

export { CLOUD_MAX_RETRIES, CLOUD_TIMEOUT_MS }
