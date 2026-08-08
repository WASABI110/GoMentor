import OpenAI, {
  APIConnectionTimeoutError,
  APIConnectionError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from 'openai'
import { AppError, type ChatChunk, type ChatMessage } from '@gomentor/shared'
import type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
} from './provider'

/**
 * The one provider implementation. Cloud and local both speak OpenAI-compatible,
 * so they differ only in the config the factories hand over.
 *
 * Two design points worth stating, because both are easy to "simplify" wrongly:
 *
 * 1. **Tool-call fragments are forwarded, not accumulated.** The wire format
 *    splits a tool call's JSON arguments across chunks, and the first fragment
 *    carries the id and name while later ones carry only more argument text. This
 *    class emits each fragment as it arrives with the id and name it belongs to,
 *    and the *consumer* joins them. Accumulating here would mean buffering the
 *    whole call before yielding anything, which defeats streaming and hides a
 *    truncated stream (the caller would see nothing rather than a partial call).
 *
 * 2. **Retries live in the SDK, not in a loop here.** `maxRetries` is passed
 *    through, so a retried request is a real second HTTP request — which is what
 *    makes the retry policy observable to a test counting requests, rather than
 *    something only a comment claims.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly config: ProviderConfig
  #capabilities: ProviderCapabilities
  readonly #client: OpenAI

  constructor(config: ProviderConfig, capabilities?: Partial<ProviderCapabilities>) {
    this.config = config
    this.#capabilities = {
      // `null`, not `false`: unprobed is not the same as unsupported.
      toolsSupported: capabilities?.toolsSupported ?? null,
      streaming: capabilities?.streaming ?? true,
    }
    this.#client = new OpenAI({
      baseURL: config.baseUrl,
      // A local server usually needs no key, but the SDK requires a non-empty
      // string. This placeholder never travels anywhere a real key would not.
      apiKey: config.apiKey ?? 'not-needed',
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
    })
  }

  get capabilities(): ProviderCapabilities {
    return this.#capabilities
  }

  /** Set by `probeCapabilities`; the measurement, not a configured guess. */
  setToolsSupported(supported: boolean): void {
    this.#capabilities = { ...this.#capabilities, toolsSupported: supported }
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    // Checked before the request rather than relying on the SDK: an already
    // aborted signal should cost zero network calls.
    // Checked before the request rather than relying on the SDK. The SDK does
    // also reject an already-aborted signal, so a mutation removing this line
    // escapes the suite — but relying on that would put a documented contract
    // (`LLM_ABORTED`, zero network calls) at the mercy of an SDK internal that
    // no test of ours pins. Cheap, and explicit about whose guarantee it is.
    if (signal?.aborted === true) {
      throw new AppError('LLM_ABORTED', 'aborted before the request was sent')
    }

    const stream = await this.#openStream(request, signal)

    try {
      for await (const event of stream) {
        const choice = event.choices[0]
        if (choice === undefined) continue

        // The SDK types `delta` as required and `finish_reason` as
        // `string | null`. Both are optimistic: this adapter also talks to
        // Ollama and LM Studio, which are OpenAI-*compatible* rather than
        // OpenAI, and a frame with no `delta` at all is something they emit.
        // Read through a widened view so the runtime guards below are honest
        // code rather than conditions the compiler thinks are dead — deleting
        // them to satisfy the linter would trade a lint error for a crash on a
        // real local server.
        const loose = choice as {
          delta?: typeof choice.delta
          finish_reason?: typeof choice.finish_reason
        }
        const delta = loose.delta
        const finishReason = loose.finish_reason

        const text = delta?.content
        if (text !== undefined && text !== null && text !== '') {
          yield { type: 'text', delta: text }
        }

        for (const fragment of delta?.tool_calls ?? []) {
          // The id and name arrive only on a call's first fragment; later ones
          // carry argument text alone. Remembering them per index is what lets
          // the consumer attribute a fragment to the right call.
          const remembered = this.#rememberToolCall(fragment)
          if (remembered === null) continue
          yield remembered
        }

        if (finishReason !== undefined && finishReason !== null) {
          yield { type: 'done', finishReason: mapFinishReason(finishReason) }
        }
      }

      // The SDK ends the iteration *silently* on abort — verified against
      // v4.104: aborting mid-stream makes `for await` return normally rather
      // than throw, and no `done` chunk is emitted. Without this check a
      // cancelled reply is indistinguishable from a complete one, which is
      // exactly what the `LLM_ABORTED` contract in `provider.ts` exists to
      // prevent. Checked after the loop, not inside it, so chunks already
      // received are still delivered before the error.
      //
      // Read through a helper rather than `signal.aborted` inline: control-flow
      // analysis narrowed the property to `false` from the guard at the top of
      // this method, and both tsc and the linter then call this check dead. The
      // narrowing is wrong — `aborted` is mutable and flips while the loop above
      // is suspended on the network — but a function call is opaque to the
      // analysis, so it reads the live value. Not `!` or `any`: those silence
      // the compiler, this one keeps full type checking.
      if (isAborted(signal)) {
        throw new AppError('LLM_ABORTED', 'the stream was aborted mid-reply')
      }
    } catch (error) {
      throw toAppError(error, signal)
    } finally {
      // Frees the socket when the consumer breaks out of the loop early. Without
      // this, an abandoned `for await` leaves the response body unread.
      this.#toolCallsByIndex.clear()
    }
  }

  /** Per-stream memory of tool-call ids and names, keyed by wire index. */
  readonly #toolCallsByIndex = new Map<number, { id: string; name: string }>()

  #rememberToolCall(fragment: {
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }): ChatChunk | null {
    const existing = this.#toolCallsByIndex.get(fragment.index)
    const id = fragment.id ?? existing?.id
    const name = fragment.function?.name ?? existing?.name

    // A fragment before any id/name is unattributable. Dropping it silently
    // would lose argument text, so this is an error rather than a `continue`.
    if (id === undefined || name === undefined) {
      throw new AppError(
        'LLM_BAD_RESPONSE',
        'tool-call fragment arrived with no id or name',
        {
          context: { index: fragment.index },
        },
      )
    }

    this.#toolCallsByIndex.set(fragment.index, { id, name })

    const argumentsDelta = fragment.function?.arguments ?? ''
    // The opening fragment often carries a name and no arguments. Emitting it
    // anyway tells the consumer a call has started, which it needs in order to
    // show "calling <name>…" before the arguments finish arriving.
    return { type: 'tool_call', id, name, argumentsDelta }
  }

  async #openStream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    try {
      return await this.#client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages.map(toWireMessage),
          stream: true,
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          // Omitted entirely when absent — an empty `tools: []` is a different
          // request and some local servers reject it.
          ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: 'function' as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }),
        },
        signal === undefined ? undefined : { signal },
      )
    } catch (error) {
      throw toAppError(error, signal)
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.#client.models.list()
      return response.data.map((model) => ({ id: model.id }))
    } catch (error) {
      throw toAppError(error)
    }
  }

  /**
   * Reachability only. A bad key or a missing model is deliberately *not* a
   * health failure — reporting "server unreachable" for a typo'd key would send
   * the user to the wrong setting.
   */
  async health(): Promise<boolean> {
    try {
      await this.#client.models.list()
      return true
    } catch (error) {
      if (error instanceof AuthenticationError) return true
      if (error instanceof RateLimitError) return true
      return false
    }
  }
}

/**
 * Live read of `signal.aborted`.
 *
 * Exists because `aborted` is mutable but the compiler treats it as narrowable:
 * after an early `if (signal?.aborted === true) throw`, later reads of the same
 * property are analysed as `false`, so the mid-stream check in `chat()` gets
 * flagged as dead code by both tsc and the linter. A function boundary is opaque
 * to that analysis, so the value is read at the moment it is asked for. Not `!`
 * or `any` — those switch checking off; this keeps it.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  // `signal?.aborted` is the form that triggers the bad narrowing this function
  // exists to avoid, so the rule is off for this line specifically.
  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
  return signal !== undefined && signal.aborted
}

function toWireMessage(
  message: ChatMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      // A tool message without the id it answers is unroutable.
      tool_call_id: message.toolResult?.toolCallId ?? '',
    }
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function mapFinishReason(
  reason: string,
): 'stop' | 'length' | 'tool_calls' | 'aborted' | 'error' {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    default:
      // An unrecognised reason is reported as `error` rather than coerced to
      // `stop`: claiming a truncated reply finished normally is worse than
      // admitting the reason is unknown.
      return 'error'
  }
}

/**
 * Maps SDK and network failures onto our codes.
 *
 * The abort check comes first because the SDK surfaces an aborted fetch in more
 * than one shape depending on where the abort landed, and a cancellation must
 * never be reported as a server error.
 */
function toAppError(error: unknown, signal?: AbortSignal): AppError {
  if (error instanceof AppError) return error

  if (signal?.aborted === true || error instanceof APIUserAbortError) {
    return new AppError('LLM_ABORTED', 'the request was aborted')
  }
  if (error instanceof RateLimitError) {
    return new AppError('LLM_RATE_LIMITED', 'the provider rate-limited the request')
  }
  if (error instanceof AuthenticationError) {
    return new AppError('LLM_UNAUTHORIZED', 'the provider rejected the credentials')
  }
  if (error instanceof InternalServerError) {
    return new AppError('LLM_BAD_RESPONSE', 'the provider returned a server error', {
      context: { status: error.status },
    })
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AppError('LLM_TIMEOUT', 'the provider did not respond in time')
  }
  if (error instanceof APIConnectionError) {
    return new AppError('LLM_UNREACHABLE', 'the provider could not be reached')
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AppError('LLM_ABORTED', 'the request was aborted')
  }
  // Deliberately not `cause: error` — the message can carry a URL with a key in
  // a query string. See `quality-guidelines.md`: no secrets reachable by a log.
  return new AppError('LLM_UNREACHABLE', 'the provider request failed')
}
