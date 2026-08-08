import type { LlmSettings } from '@gomentor/shared'
import { OpenAICompatibleProvider } from './openai-compatible'
import type { ProviderCapabilities } from './provider'

/**
 * Local factory: long timeout, **zero retries**.
 *
 * Both halves are deliberate and both are the opposite of `cloud.ts`:
 *
 * - **Long timeout.** A local 4090 loading a large model into VRAM can take
 *   well over a minute to produce a first token. A cloud-appropriate timeout
 *   would abort a request that was going to succeed.
 * - **Zero retries.** The failure modes of a local server are not transient —
 *   the model is not loaded, VRAM is exhausted, the process is down. Retrying
 *   multiplies GPU load on a machine already struggling, and turns one long
 *   wait into three.
 */

/** 300s. First-token latency on a cold local model, not a request budget. */
const LOCAL_TIMEOUT_MS = 300_000

/** Zero, per `design.md` §LLM provider. Not a placeholder. */
const LOCAL_MAX_RETRIES = 0

export function createLocalProvider(
  settings: Pick<LlmSettings, 'baseUrl' | 'model' | 'toolsSupported'>,
  apiKey?: string,
  capabilities?: Partial<ProviderCapabilities>,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    {
      kind: 'local',
      baseUrl: settings.baseUrl,
      model: settings.model,
      // Some local servers accept a key and ignore it; some require the header
      // to be present. Passing it through when given costs nothing.
      ...(apiKey === undefined ? {} : { apiKey }),
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxRetries: LOCAL_MAX_RETRIES,
    },
    { toolsSupported: settings.toolsSupported, ...capabilities },
  )
}

export { LOCAL_MAX_RETRIES, LOCAL_TIMEOUT_MS }
