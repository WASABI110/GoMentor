import { AppError, isAppError, type ChatChunk } from '@gomentor/shared'
import { OpenAICompatibleProvider } from '@gomentor/core/llm/openai-compatible'
import type { ChatRequest, ModelInfo } from '@gomentor/core/llm/provider'

/**
 * A scripted LLM provider for the M3 agent-loop integration tests.
 *
 * ## Why it extends the real class instead of reimplementing the interface
 *
 * The degrade tri-state (Stage 2's whole entry decision) consumes two things
 * only the real adapter carries: `capabilities` and `setToolsSupported`, the
 * recorder `probeCapabilities` writes through. A hand-rolled object would
 * force the test to invent its own copy of that machinery, and the fake
 * fake-katago lesson applies — a test double legitimises whatever the real
 * thing would reject. Extending the class keeps the probe path, the
 * capability recording, and the request shape honest; only the stream is
 * scripted. The base constructor opens no connection (the SDK client is
 * lazy), and the overridden `chat` never touches it.
 *
 * ## What the script drives
 *
 * Each `script()` call queues one turn: the chunks the model "sends", in wire
 * order, including the terminating `done`. `failNextWith` queues a throw for
 * the next turn instead — how the probe-failure paths are reached without a
 * real unreachable server.
 *
 * Requests are snapshotted (messages array copied) on arrival, because the
 * loop pushes into its working history across turns and a by-reference
 * recording would make every earlier turn look like the last one.
 */
export class ScriptedLlmProvider extends OpenAICompatibleProvider {
  /** Snapshots of every `chat` call, in issue order. */
  readonly requests: ChatRequest[] = []

  readonly #turns: (ChatChunk[] | AppError)[] = []

  /**
   * Synchronous hook, called before each chunk is yielded. A test cancels a
   * run from here — `cancel()` is synchronous, so the abort lands at a known
   * chunk boundary instead of racing the script's flush.
   */
  beforeYield: ((index: number) => void) | undefined

  constructor(options: { readonly toolsSupported?: boolean | null } = {}) {
    super(
      {
        // Never contacted: `chat` is overridden. The baseUrl only has to parse.
        kind: 'cloud',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'scripted-model',
        apiKey: 'unused',
        timeoutMs: 1_000,
        maxRetries: 0,
      },
      { toolsSupported: options.toolsSupported ?? null },
    )
  }

  /** Queues one scripted turn. */
  script(chunks: readonly ChatChunk[]): void {
    this.#turns.push([...chunks])
  }

  /** Makes the next `chat` call throw instead of streaming. */
  failNextWith(error: AppError): void {
    this.#turns.push(error)
  }

  override async *chat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    // Same contract as the real adapter: an already-dead signal costs no turn.
    if (signal?.aborted === true) {
      throw new AppError('LLM_ABORTED', 'aborted before the turn started')
    }
    this.requests.push({ ...request, messages: [...request.messages] })

    const turn = this.#turns.shift()
    if (turn === undefined) {
      throw new AppError('LLM_BAD_RESPONSE', 'no scripted turn remained')
    }
    if (isAppError(turn)) throw turn

    let index = 0
    for (const chunk of turn) {
      // A macrotask per chunk, so a cancel landing mid-stream is observable
      // here the way it is on a real socket: without it the scripted chunks
      // would all flush inside one microtask chain and no abort could
      // interleave.
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      this.beforeYield?.(index)
      index += 1
      if (isAborted(signal)) {
        throw new AppError('LLM_ABORTED', 'the stream was aborted mid-turn')
      }
      yield chunk
    }
  }

  override listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([])
  }

  override health(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

/**
 * Live read of `signal.aborted` — the same shape as the helper in
 * `openai-compatible.ts`: control-flow analysis narrows `aborted` to `false`
 * after the entry guard above, and a function boundary is what keeps the
 * mid-stream check alive. The lint rule that suggests optional chaining here
 * is exactly the rewrite that restores the bad narrowing.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
  return signal !== undefined && signal.aborted
}
