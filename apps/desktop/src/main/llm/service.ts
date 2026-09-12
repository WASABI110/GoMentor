import { randomUUID } from 'node:crypto'
import { createCloudProvider } from '@gomentor/core/llm/cloud'
import { createLocalProvider } from '@gomentor/core/llm/local'
import { probeCapabilities } from '@gomentor/core/llm/probe'
import type { ChatRequest } from '@gomentor/core/llm/provider'
import type { OpenAICompatibleProvider } from '@gomentor/core/llm/openai-compatible'
import {
  AppError,
  isAppError,
  type ChatContext,
  type ChatMessage,
  type ProfileSnapshot,
  type Settings,
} from '@gomentor/shared'
import { scoped } from '../logger'
import { emit } from '../ipc/events'
import type { SecretsService } from '../safe-storage'
import type { SettingsService } from '../settings'
import type { EngineService } from '../katago/service'
import type { GameStore } from '../library/store'
import { decideTools, runAgentLoop } from './agent/runner'
import { toolSchemas } from './agent/tools'

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
 *
 * ## Where the degrade decision lives (M3, R3)
 *
 * The tri-state (`toolsSupported` true/false/null) is resolved here, at the
 * send entry, and nowhere else — by the time the loop starts, the run is
 * either carrying tool schemas or is the byte-identical single-shot request
 * the pre-M3 code sent. A decision made anywhere deeper (per turn, per tool)
 * would let a half-agent run exist: some turns with tools, some without,
 * against a model that may not support them at all. `null` runs the existing
 * capability probe first, cached on the provider by `probeCapabilities`
 * itself; a probe that cannot measure degrades to single-shot rather than
 * guessing, and an aborted probe ends the run as the cancellation it is —
 * not as a capability measurement.
 */

const logger = scoped('main:llm:service')

interface ActiveRun {
  controller: AbortController
}

/** What the agent loop needs beyond the provider to answer tool calls. */
export interface LlmServiceDeps {
  readonly store: GameStore
  readonly engine: EngineService
  /**
   * The student profile, derived on demand (M4). A seam like the store: the
   * service does not know it comes from the analysis repository, and tests
   * stub it with a fixed snapshot.
   */
  readonly profile: () => ProfileSnapshot
  /**
   * Provider seam, for tests. Defaults to the two factories. Typed as the
   * concrete class because the degrade path calls `probeCapabilities`, which
   * needs `setToolsSupported` — the measurement recorder `LLMProvider` does
   * not carry.
   */
  readonly createProvider?: (
    document: Settings,
    apiKey: string | undefined,
  ) => OpenAICompatibleProvider
}

export interface LlmService {
  /**
   * Starts a run and returns its id immediately. `context` names the game the
   * renderer is looking at, so agent tool calls can default to it.
   */
  send(input: {
    content: string
    history: readonly ChatMessage[]
    context?: ChatContext
  }): string
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
  deps: LlmServiceDeps,
): LlmService {
  const runs = new Map<string, ActiveRun>()

  /**
   * Cached because constructing one opens a connection pool, and settings change
   * far less often than messages are sent. `invalidate()` drops it; the
   * alternative — rebuilding per message — would make every send pay the setup.
   */
  let cached: { provider: OpenAICompatibleProvider; fingerprint: string } | undefined

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

  function provider(): OpenAICompatibleProvider {
    const document = settings.get()
    const apiKey = secrets.get('llmApiKey')
    const fingerprint = fingerprintOf(document, apiKey !== undefined)

    if (cached?.fingerprint === fingerprint) return cached.provider

    const built =
      deps.createProvider !== undefined
        ? // Test seam: the scripted provider stands in for both factories so
          // the run path, the degrade tri-state, and the event fan-out are
          // all exercised against the real service.
          deps.createProvider(document, apiKey)
        : document.llm.kind === 'local'
          ? // Local takes no key: a local server usually needs none, and the
            // factory's point is the policy difference — zero retries and a
            // long timeout, because retrying against a loading local model
            // just multiplies GPU load (`design.md` §LLM provider).
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

  function buildCloud(
    document: Settings,
    apiKey: string | undefined,
  ): OpenAICompatibleProvider {
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

  /**
   * Resolves the tri-state to a measurement, probing only when nothing has
   * been measured yet. Returns `null` when the probe could not measure — the
   * shape `decideTools` degrades on — and re-throws only a cancellation,
   * which is the run's outcome rather than evidence about tools.
   */
  async function measuredToolSupport(
    active: OpenAICompatibleProvider,
    signal: AbortSignal,
  ): Promise<boolean | null> {
    const known = active.capabilities.toolsSupported
    if (known !== null) return known

    try {
      const probe = await probeCapabilities(active, signal)
      logger.debug('tool support probe finished', {
        toolsSupported: probe.toolsSupported,
        reason: probe.reason,
      })
      return probe.toolsSupported
    } catch (error) {
      // A cancelled probe measured nothing. Recording or degrading on it
      // would answer a run the user already stopped.
      if (isAppError(error) && error.code === 'LLM_ABORTED') throw error
      // `warn`, not `error`: an unreachable server is expected degradation,
      // and the run continues without tools (`logging-guidelines.md`). The
      // typed code is the safe, enumerable part — the message may carry
      // server-built text, so it stays out of the log — and it is what answers
      // "why does my teacher never use tools?" from the log file alone.
      logger.warn('tool support probe failed; degrading to single-shot', {
        ...(isAppError(error) ? { code: error.code } : {}),
      })
      return null
    }
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
          // The degrade tri-state resolves here, before anything is sent, so a
          // run is wholly one mode or the other (see the module note).
          const measured = await measuredToolSupport(active, controller.signal)
          const agent = decideTools(measured)
          if (measured === null) {
            logger.debug('tool support unknown; running without tools')
          }

          const request: ChatRequest = {
            messages,
            model: document.llm.model,
            temperature: document.llm.temperature,
            maxTokens: document.llm.maxTokens,
            // Absent, not empty, on the degraded path: the wire shape is then
            // byte-identical to the pre-M3 single-shot request, and an empty
            // `tools: []` is a different request that some local servers
            // reject (`provider.ts`).
            ...(agent ? { tools: toolSchemas() } : {}),
          }

          const turn = await runAgentLoop({
            provider: active,
            request,
            signal: controller.signal,
            onDelta: (chunk) => {
              emit('llm:delta', { runId, chunk })
            },
            ...(agent
              ? {
                  toolContext: {
                    // The game under discussion when the message was sent is
                    // the default every tool call falls back to. Spread rather
                    // than assigned: `exactOptionalPropertyTypes` distinguishes
                    // an absent key from one carrying `undefined`.
                    ...(input.context?.gameId === undefined
                      ? {}
                      : { gameId: input.context.gameId }),
                    store: deps.store,
                    engine: deps.engine,
                    profile: deps.profile,
                  },
                }
              : {}),
          })

          emit('llm:done', { runId, finishReason: turn.finishReason })
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
