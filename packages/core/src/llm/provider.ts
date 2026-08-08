import type { ChatChunk, ChatMessage, LlmProviderKind } from '@gomentor/shared'

/**
 * The provider contract.
 *
 * `chat()` returns an `AsyncIterable<ChatChunk>` rather than taking callbacks or
 * extending EventEmitter. Streaming becomes a `for await` loop, and cancellation
 * is breaking out of it — the `AbortSignal` propagates to the underlying fetch.
 * Callback-based cancellation would need a separate unsubscribe protocol and a
 * rule about whether callbacks may still fire after it.
 *
 * One implementation only (`OpenAICompatibleProvider`). Cloud and local differ in
 * baseUrl, key presence, and timeout/retry policy — not in protocol — so a second
 * implementation would be two copies of the same SSE parsing.
 */

/** What a provider was asked to do. Model and sampling come from settings. */
export interface ChatRequest {
  readonly messages: readonly ChatMessage[]
  readonly model: string
  readonly temperature?: number
  readonly maxTokens?: number
  /**
   * Tool schemas the model may call. Omitted entirely when the provider has no
   * measured tool support — sending an empty array is not the same thing, and
   * some local servers reject it.
   */
  readonly tools?: readonly ToolSchema[]
}

/** A tool the model may call, in the JSON-Schema shape the wire format wants. */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/**
 * What a provider can actually do, as **measured**, not as configured.
 *
 * `toolsSupported` is `null` until probed. Tool-calling support in Ollama and
 * LM Studio varies by *model*, not just by server, so it cannot be read off the
 * config — see `probe.ts`. M3's agent loop needs the distinction between "no
 * tools" and "not yet known" to decide whether to degrade or to probe.
 */
export interface ProviderCapabilities {
  readonly toolsSupported: boolean | null
  readonly streaming: boolean
}

/** Config a factory resolves; the retry/timeout policy is the factory's point. */
export interface ProviderConfig {
  readonly kind: LlmProviderKind
  readonly baseUrl: string
  readonly model: string
  /** Optional: a local server usually needs none. */
  readonly apiKey?: string
  readonly timeoutMs: number
  /** Local is 0 on purpose — see `local.ts`. */
  readonly maxRetries: number
}

export interface ModelInfo {
  readonly id: string
}

export interface LLMProvider {
  readonly config: ProviderConfig
  readonly capabilities: ProviderCapabilities

  /**
   * Streams a reply. Chunks arrive in wire order; a `done` chunk always
   * terminates a successful stream so consumers need no separate completion
   * signal.
   *
   * Throws `AppError` with an `LLM_*` code. An aborted stream throws
   * `LLM_ABORTED` rather than returning silently, so a caller cannot mistake
   * cancellation for a finished reply.
   */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>

  listModels(): Promise<ModelInfo[]>

  /**
   * Reachability only — deliberately does not validate the key or the model.
   * A health check that failed on a bad key would report "server down" for a
   * typo, which sends the user to the wrong setting.
   */
  health(): Promise<boolean>
}
