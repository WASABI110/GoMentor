import { AppError, isAppError } from '@gomentor/shared'
import type { OpenAICompatibleProvider } from './openai-compatible'
import type { ToolSchema } from './provider'

/**
 * Measures whether tool calling actually works, by trying one.
 *
 * Tool support in Ollama and LM Studio varies by *model*, not just by server, so
 * it cannot be read off the configuration — a server that supports tools will
 * happily accept a `tools` array for a model that then never emits a call. The
 * only reliable signal is an attempt.
 *
 * Recording the result lets M3's agent loop degrade to a no-tools prompt strategy
 * up front, instead of discovering the gap at the first tool dispatch mid-answer.
 */

/**
 * Chosen so a model that supports tools has no plausible reason *not* to call
 * it: one required parameter, an unmistakable instruction, and a name that
 * matches the request. A prompt the model might reasonably answer in prose would
 * make a false negative look like missing support.
 */
const PROBE_TOOL: ToolSchema = {
  name: 'report_probe_ok',
  description: 'Report that tool calling works. Call this immediately with value "ok".',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string', description: 'Always the string "ok".' } },
    required: ['value'],
  },
}

export interface ProbeResult {
  readonly toolsSupported: boolean
  /**
   * Why the probe concluded what it did. `'tool_call'` and `'no_tool_call'` are
   * measurements; the others mean the probe could not measure and the caller
   * should treat support as still unknown rather than absent.
   */
  readonly reason: 'tool_call' | 'no_tool_call' | 'rejected' | 'unreachable'
}

/**
 * Runs the probe and records the result on the provider.
 *
 * Never throws for a negative result — "tools do not work" is a state, not an
 * exception (`quality-guidelines.md`). It does propagate an abort, because a
 * cancelled probe measured nothing and must not be recorded as a negative.
 */
export async function probeCapabilities(
  provider: OpenAICompatibleProvider,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    let sawToolCall = false

    for await (const chunk of provider.chat(
      {
        model: provider.config.model,
        messages: [
          {
            id: 'probe',
            role: 'user',
            content:
              'Call the report_probe_ok tool with value "ok". Do not reply in prose.',
            createdAt: PROBE_TIMESTAMP,
          },
        ],
        tools: [PROBE_TOOL],
        // Minimal: the probe cares whether a call starts, not what it says.
        maxTokens: 64,
        // Deterministic, so a probe that passes once does not fail the next time
        // on sampling alone.
        temperature: 0,
      },
      signal,
    )) {
      if (chunk.type === 'tool_call') {
        sawToolCall = true
        // Stops the stream as soon as the question is answered. `break` closes
        // the iterator, which releases the socket.
        break
      }
    }

    const result: ProbeResult = sawToolCall
      ? { toolsSupported: true, reason: 'tool_call' }
      : { toolsSupported: false, reason: 'no_tool_call' }
    provider.setToolsSupported(result.toolsSupported)
    return result
  } catch (error) {
    // An aborted probe measured nothing. Recording `false` here would leave a
    // wrong capability behind for the rest of the session.
    if (isAppError(error) && error.code === 'LLM_ABORTED') throw error

    // A server that rejects the request outright (a 400 for an unknown `tools`
    // field, say) is evidence tools do not work, and is worth recording.
    if (isAppError(error) && error.code === 'LLM_BAD_RESPONSE') {
      provider.setToolsSupported(false)
      return { toolsSupported: false, reason: 'rejected' }
    }

    // Unreachable, unauthorized, timed out: the probe learned nothing about
    // tools. Left unrecorded so a later probe can still measure it.
    if (isAppError(error)) return { toolsSupported: false, reason: 'unreachable' }

    throw new AppError('LLM_UNREACHABLE', 'the capability probe failed')
  }
}

/**
 * Fixed rather than `new Date()`: the probe message is not user content and its
 * timestamp is never displayed, and a constant keeps the request byte-identical
 * across runs so a test can assert on the body.
 */
const PROBE_TIMESTAMP = '1970-01-01T00:00:00.000Z'

export { PROBE_TOOL }
