import { randomUUID } from 'node:crypto'
import { createCloudProvider } from '@gomentor/core/llm/cloud'
import { createLocalProvider } from '@gomentor/core/llm/local'
import type { LLMProvider } from '@gomentor/core/llm/provider'
import { AppError, isAppError, type ChatMessage, type Settings } from '@gomentor/shared'
import { scoped } from '../logger'
import { emit } from '../ipc/events'
import type { SecretsService } from '../safe-storage'
import type { SettingsService } from '../settings'

/**
 * Owns the provider instance, issues `runId`s, and fans streamed chunks out to
 * the renderer as events.
 *
 * ## Why the run is not awaited by the handler
 *
 * `llm:sendMessage` returns `{ runId }` as soon as the stream starts. The tokens
 * arrive as `llm:delta` events correlated by that id (`design.md` §IPC).
 * Awaiting the full reply inside the handler would block the invoke round-trip
 * for the length of a completion — no incremental rendering, and a cancel
 * request could not be serviced because the handler holding the response is the
 * only thing that could abort it.
 *
 * The consequence is that **a run's failure cannot be reported by throwing**:
 * the handler has already returned. Errors reach the renderer as `llm:error`
 * events, which is why the finally block below is not optional.
 */

const logger = scoped('main:llm:service')

interface ActiveRun {
  controller: AbortController
}

export interface LlmService {
  /** Starts a run and returns its id immediately. */
  send(input: { content: string; history: readonly ChatMessage[] }): string
  /** Aborts a run. Unknown ids are a no-op, not an error — see the note. */
  cancel(runId: string): void
  /** Reachability check. Never throws; false covers every unreachable cause. */
  health(): Promise<boolean>
  /** Discards the cached provider so the next run rebuilds from settings. */
  invalidate(): void
  /** Aborts every in-flight run. Called on quit. */
  shutdown(): void
}

export function createLlmService(
  settings: SettingsService,
  secrets: SecretsService,
): LlmService {
  const runs = new Map<string, ActiveRun>()

  /**
   * Cached because constructing one opens a connection pool, and settings change
   * far less often than messages are sent. `invalidate()` drops it; the
   * alternative — rebuilding per message — would make every send pay the setup.
   */
  let cached: { provider: LLMProvider; fingerprint: string } | undefined

  /**
   * Identity of the settings a cached provider was built from. Compared rather
   * than relying on `invalidate()` alone: a settings write that forgot to call
   * it would otherwise leave the app talking to the old endpoint with no visible
   * cause. `hasKey` is included because adding a key must rebuild, but the key
   * itself is not — a fingerprint is not a place to put a secret.
   */
  function fingerprintOf(document: Settings, hasKey: boolean): string {
    return JSON.stringify([
      document.llm.kind,
      document.llm.baseUrl,
      document.llm.model,
      document.llm.toolsSupported,
      hasKey,
    ])
  }

  function provider(): LLMProvider {
    const document = settings.get()
    const apiKey = secrets.get('llmApiKey')
    const fingerprint = fingerprintOf(document, apiKey !== undefined)

    if (cached?.fingerprint === fingerprint) return cached.provider

    const built =
      document.llm.kind === 'local'
        ? // Local takes no key: a local server usually needs none, and the
          // factory's point is the policy difference — zero retries and a long
          // timeout, because retrying against a loading local model just
          // multiplies GPU load (`design.md` §LLM provider).
          createLocalProvider(document.llm)
        : buildCloud(document, apiKey)

    // Host only, never the full URL: `logging-guidelines.md` forbids logging a
    // baseUrl with credentials, and a query-string key is the common shape.
    logger.info('llm provider built', {
      kind: document.llm.kind,
      model: document.llm.model,
      host: hostOf(document.llm.baseUrl),
      hasKey: apiKey !== undefined,
    })

    cached = { provider: built, fingerprint }
    return built
  }

  function buildCloud(document: Settings, apiKey: string | undefined): LLMProvider {
    if (apiKey === undefined) {
      // A cloud provider with no key cannot do anything, and failing here — at
      // construction, with a code the renderer can translate into "configure a
      // key" — is better than a 401 the user has to interpret.
      throw new AppError(
        'LLM_NO_KEY',
        'no API key is configured for the cloud provider',
      )
    }
    return createCloudProvider(document.llm, apiKey)
  }

  return {
    send(input) {
      // Issued here, before anything can fail, so an error is always reportable
      // against a run the renderer knows about.
      const runId = randomUUID()
      const controller = new AbortController()
      runs.set(runId, { controller })

      const document = settings.get()
      // `id` and `createdAt` are stamped here rather than taken from the
      // renderer: they are the message's identity and its ordering key, and a
      // renderer clock that is wrong or a duplicate id would corrupt the history
      // that gets replayed into the next request. The renderer's copy is for
      // display; this is the one the provider sees.
      const messages: ChatMessage[] = [
        ...input.history,
        {
          id: randomUUID(),
          role: 'user',
          content: input.content,
          createdAt: new Date().toISOString(),
        },
      ]

      // Not awaited: see the module note. `void` is explicit rather than an
      // ignored floating promise — the rejection path is handled inside.
      void (async () => {
        try {
          const active = provider()
          const request = {
            messages,
            model: document.llm.model,
            temperature: document.llm.temperature,
            maxTokens: document.llm.maxTokens,
          }

          let finishReason: 'stop' | 'length' | 'tool_calls' | 'aborted' | 'error' =
            'stop'

          for await (const chunk of active.chat(request, controller.signal)) {
            if (chunk.type === 'done') {
              finishReason = chunk.finishReason
              continue
            }
            // Chunks are forwarded in wire order. No buffering or coalescing:
            // A8 asserts assembly *order*, and a tool-call's arguments arrive
            // fragmented across chunks for the renderer to accumulate.
            emit('llm:delta', { runId, chunk })
          }

          emit('llm:done', { runId, finishReason })
        } catch (error) {
          // Cancellation is a successful outcome, and `logging-guidelines.md`
          // calibrates it as `debug`, not `warn` — a user pressing cancel is not
          // a degradation. It is still reported as an event so the renderer can
          // stop its spinner.
          if (isAppError(error) && error.code === 'LLM_ABORTED') {
            logger.debug('run aborted', { runId })
            emit('llm:done', { runId, finishReason: 'aborted' })
            return
          }

          // No message content in the log — not the prompt, not the partial
          // completion. `failure` logs the code, context, and cause.
          logger.failure('run failed', error, { runId })
          emit('llm:error', {
            runId,
            error: isAppError(error)
              ? error.toEnvelope()
              : { code: 'LLM_BAD_RESPONSE', message: 'The provider request failed' },
          })
        } finally {
          // Must run on every path. A run left in the map would leak an
          // AbortController and make `cancel` claim success for a finished run.
          runs.delete(runId)
        }
      })()

      return runId
    },

    cancel(runId) {
      const run = runs.get(runId)
      if (run === undefined) {
        // Not an error. The run may have completed between the renderer deciding
        // to cancel and the request arriving — a race that happens routinely,
        // and whose outcome the user wanted anyway.
        logger.debug('cancel for unknown run', { runId })
        return
      }
      run.controller.abort()
      logger.debug('cancel requested', { runId })
    },

    async health() {
      try {
        return await provider().health()
      } catch (error) {
        // Includes LLM_NO_KEY from `buildCloud`. Reachability is what the caller
        // asked about; a missing key is reported through settings, not here.
        logger.failure('health check failed', error)
        return false
      }
    },

    invalidate() {
      cached = undefined
    },

    shutdown() {
      for (const [runId, run] of runs) {
        run.controller.abort()
        logger.debug('run aborted on shutdown', { runId })
      }
      runs.clear()
    },
  }
}

/**
 * Host and port only. Returns a placeholder rather than the input on a parse
 * failure: an unparseable baseUrl is exactly where a malformed credential would
 * be, so falling back to the raw string would defeat the point.
 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return '<unparseable>'
  }
}
