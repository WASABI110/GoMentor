import { randomUUID } from 'node:crypto'
import type { ChatRequest, LLMProvider } from '@gomentor/core/llm/provider'
import {
  AppError,
  type ChatChunk,
  type ChatMessage,
  type ToolCall,
} from '@gomentor/shared'
import { scoped } from '../../logger'
import { dispatchTool, type ToolContext, type ToolOutcome } from './tools'

/**
 * The agent loop (M3 Stage 2): one run's provider turns, tool execution, and
 * stream fan-out.
 *
 * ## One consumption path for both modes
 *
 * Without tools the loop is exactly the pre-M3 single-shot pass-through: it
 * forwards every non-`done` chunk in wire order, consumes `done`, and returns
 * its reason after one turn. The agent mode differs only in what happens after
 * a `done(finishReason: 'tool_calls')`: the turn's tool calls are executed and
 * the loop requests another turn. Keeping both in one consumer is what makes
 * "the degraded path is byte-identical" true by construction rather than by
 * two copies agreeing.
 *
 * ## Why tools execute serially
 *
 * The model may return several calls in one turn. Executing them in parallel
 * would point every one at the same engine, and the agent tier exists inside a
 * latency budget shared with the user's own focus analysis (`design.md`
 * §引擎独立查询通道): two `analyzeOnce` calls at once spend that budget twice
 * as fast for answers the teacher reads one at a time. The step cap below
 * already bounds the run; serial execution additionally bounds the *rate*.
 *
 * ## Why the cap is 8, and what a step is
 *
 * A step is one provider round trip — a `chat()` call and the turn it
 * produces. `MAX_AGENT_STEPS` bounds the count per run, so a scripted or
 * confused model that answers every turn with another tool request ends the
 * run with `LLM_AGENT_LIMIT` instead of recursing until the user's token bill
 * or the engine's queue says otherwise. It is a fixed constant rather than a
 * setting because M3 adds no settings surface; eight turns is generous for
 * "look up the position, analyse it, answer" and small enough that a runaway
 * costs little. If M4 makes it configurable, the constant stays the default
 * and this comment moves with it.
 *
 * ## Errors and cancellation
 *
 * Tool-level failures never end the run — `dispatchTool` returns an
 * `isError` result the model can self-correct from, and that is the loop's
 * whole self-correction mechanism. Two things do end it: the step cap above,
 * and cancellation, which propagates out of either the stream (the provider
 * throws `LLM_ABORTED`) or a tool (`dispatchTool` re-throws it). The caller —
 * `main/llm/service.ts` — owns turning a throw into the `llm:error` /
 * `llm:done` event the renderer already understands.
 *
 * ## The pure core
 *
 * `decideTools`, `isAtCap`, `parseToolArguments`, `materialiseToolCalls`, and
 * `assembleToolExchange` are exported pure functions: they are the decisions
 * the loop makes, and they are what `scripts/mutate-llm.mts` mutates. The
 * stream plumbing around them is deliberately thin and unmutated — its
 * correctness is a property of a live stream, asserted by the integration
 * suite against a scripted provider.
 */

const logger = scoped('main:llm:agent')

/** The finish reasons the wire contract defines, derived so it cannot drift. */
export type FinishReason = Extract<ChatChunk, { type: 'done' }>['finishReason']

/**
 * Provider round trips per run. See the module header for why this number and
 * why it is not configurable.
 */
export const MAX_AGENT_STEPS = 8

/**
 * The degrade decision (R3), as a pure function so the fallback is asserted
 * rather than implied. `true` runs the agent loop; `false` and `null` both
 * run the single-shot path — `null` ("never probed") degrades rather than
 * guessing, because sending a `tools` array to a model that cannot answer it
 * produces a reply that silently ignores the request, and a probe that could
 * not measure (unreachable server, aborted run) has produced no evidence
 * either way. Degrading is the outcome that cannot deadlock the app.
 */
export function decideTools(capability: boolean | null): boolean {
  return capability === true
}

/**
 * Whether another provider turn would exceed the cap. `completedSteps` is the
 * number of turns the run has already consumed, so the check runs *before*
 * issuing the next one: a run that has consumed `MAX_AGENT_STEPS` turns ends
 * here rather than starting turn nine.
 */
export function isAtCap(completedSteps: number): boolean {
  return completedSteps >= MAX_AGENT_STEPS
}

/** The result of reading a turn's argument text against the tool contract. */
export type ParsedToolArguments =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

/**
 * Parses a tool call's accumulated argument text.
 *
 * Both failure modes are reported, never thrown: malformed JSON and a
 * well-formed non-object (`"5"`, `[1,2]`) are the same class — the model
 * produced arguments no tool can read — and both become an `isError` result
 * the model can correct on its next call. The reason strings are fixed
 * phrases on purpose: the raw text was model output, and echoing it back
 * into the transcript would feed the run its own noise as context.
 */
export function parseToolArguments(raw: string): ParsedToolArguments {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'the arguments were not valid JSON' }
  }
  // An array is valid JSON but not a record: `toolCallSchema.arguments` is a
  // string-keyed object, and silently coercing an array into `{"0":...}`
  // would hand the tool arguments the model never wrote.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'the arguments were not a JSON object' }
  }
  // Rebuilt entry by entry rather than cast: `JSON.parse` returns `any`, and
  // this is the one place that value is narrowed into the contract. The record
  // is prototype-less because the raw text is model output: on a normal object
  // a `__proto__` key in that text would hit `Object.prototype`'s accessor and
  // set this record's [[Prototype]] instead of becoming a field — silently
  // swallowing the key the model wrote and tainting the object it lands on.
  // Assignment on a null-prototype record is a plain data property, so every
  // key the model sent survives as a key the schema can judge.
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, entry] of Object.entries(parsed)) {
    value[key] = entry
  }
  return { ok: true, value }
}

/** One tool call as the stream delivered it: identity plus raw argument text. */
export interface RawToolCall {
  readonly id: string
  readonly name: string
  readonly argumentsText: string
}

export interface MaterialisedToolCalls {
  /**
   * Wire order preserved. A call whose arguments did not parse is still
   * listed — with empty arguments — because the assistant message and its
   * tool replies must stay one-to-one: a provider that counts them will
   * reject a history where a `tool_calls` entry has no matching tool message.
   */
  readonly calls: readonly ToolCall[]
  /** `id` → the fixed reason phrase, for the calls whose arguments failed. */
  readonly invalid: ReadonlyMap<string, string>
}

/**
 * Turns the turn's raw calls into contract-shaped `ToolCall`s, separating the
 * ones that must not be dispatched.
 */
export function materialiseToolCalls(
  raw: readonly RawToolCall[],
): MaterialisedToolCalls {
  const calls: ToolCall[] = []
  const invalid = new Map<string, string>()
  for (const call of raw) {
    const parsed = parseToolArguments(call.argumentsText)
    if (parsed.ok) {
      calls.push({ id: call.id, name: call.name, arguments: parsed.value })
    } else {
      calls.push({ id: call.id, name: call.name, arguments: {} })
      invalid.set(call.id, `IPC_INVALID_REQUEST: ${parsed.reason}`)
    }
  }
  return { calls, invalid }
}

/** One executed (or rejected-before-execution) tool call, keyed by its id. */
export interface ToolOutcomeForCall {
  readonly toolCallId: string
  readonly outcome: ToolOutcome
}

/** The messages one tool turn adds to the running conversation. */
export interface ToolExchange {
  readonly assistant: ChatMessage
  readonly toolMessages: readonly ChatMessage[]
}

/**
 * Assembles the assistant message carrying the model's tool calls and the
 * `role: 'tool'` replies, in the shape the provider's history encoder
 * (`toWireMessage`) expects: ids and timestamps from the injected factories,
 * each reply carrying its call's id so the pair is routable on the wire, and
 * the outcome content in *both* `content` and `toolResult.content` — the
 * encoder sends `content` as the message body, so a result stored only under
 * `toolResult` would reach the model as an empty reply.
 */
export function assembleToolExchange(
  content: string,
  calls: readonly ToolCall[],
  outcomes: readonly ToolOutcomeForCall[],
  newId: () => string,
  now: () => string,
): ToolExchange {
  const assistant: ChatMessage = {
    id: newId(),
    role: 'assistant',
    content,
    toolCalls: [...calls],
    createdAt: now(),
  }
  const toolMessages: ChatMessage[] = outcomes.map((entry) => ({
    id: newId(),
    role: 'tool',
    content: entry.outcome.content,
    toolResult: {
      toolCallId: entry.toolCallId,
      content: entry.outcome.content,
      isError: entry.outcome.isError,
    },
    createdAt: now(),
  }))
  return { assistant, toolMessages }
}

export interface AgentLoopOptions {
  readonly provider: LLMProvider
  /**
   * The request as the caller built it: messages, sampling, and — on the
   * agent path — the tool schemas. The loop replaces `messages` with its own
   * working copy each turn and leaves everything else byte-identical.
   */
  readonly request: ChatRequest
  readonly signal: AbortSignal
  /**
   * Stream fan-out, owned by the caller so this module stays Electron-free in
   * its event plumbing: the service passes `(chunk) => emit('llm:delta', ...)`
   * and tests collect the chunks directly.
   */
  readonly onDelta: (chunk: ChatChunk) => void
  /**
   * Present only on the agent path (the request carried tools). Its absence
   * is what makes a `tool_calls` finish reason end a degraded run instead of
   * trying to execute calls no registry can answer.
   */
  readonly toolContext?: ToolContext
}

export interface AgentRunResult {
  readonly finishReason: FinishReason
}

/** Ids and timestamps for assembled messages; a seam only for determinism. */
export interface MessageStamp {
  readonly newId: () => string
  readonly now: () => string
}

/**
 * Runs the loop to completion. Throws only what must end the run: the step
 * cap (`LLM_AGENT_LIMIT`) and cancellation (`LLM_ABORTED`). Every other
 * failure inside a tool has already become an `isError` result.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
  stamps: MessageStamp = {
    newId: () => randomUUID(),
    now: () => new Date().toISOString(),
  },
): Promise<AgentRunResult> {
  const { provider, request, signal, onDelta, toolContext } = options
  const messages: ChatMessage[] = [...request.messages]
  let completedSteps = 0

  for (;;) {
    if (isAtCap(completedSteps)) {
      throw new AppError(
        'LLM_AGENT_LIMIT',
        'the agent loop reached its step limit before the model produced an answer',
        { context: { maxSteps: MAX_AGENT_STEPS } },
      )
    }
    completedSteps += 1

    const turn = await consumeTurn(
      provider.chat({ ...request, messages }, signal),
      onDelta,
    )
    logger.debug('agent turn consumed', {
      finishReason: turn.finishReason,
      toolCalls: turn.calls.length,
      step: completedSteps,
    })

    // A degraded run (no tool context) ends on whatever the provider says,
    // including a protocol-violating `tool_calls` from a model that was never
    // offered tools: ending it here is honest, executing calls without a
    // registry would be worse.
    if (turn.finishReason !== 'tool_calls' || toolContext === undefined) {
      return { finishReason: turn.finishReason }
    }

    const { calls, invalid } = materialiseToolCalls(turn.calls)
    const outcomes: ToolOutcomeForCall[] = []
    for (const call of calls) {
      // Serial on purpose — see the module header.
      const rejected = invalid.get(call.id)
      const outcome: ToolOutcome =
        rejected !== undefined
          ? { content: rejected, isError: true }
          : await dispatchTool(call.name, call.arguments, toolContext, signal)
      outcomes.push({ toolCallId: call.id, outcome })
      // Progress crosses on the existing channel, so Stage 3's step rows are
      // pure consumption. The chunk union has no `isError` field — the model
      // reads it from the result text, and the renderer from the same.
      onDelta({ type: 'tool_result', toolCallId: call.id, content: outcome.content })
    }

    const exchange = assembleToolExchange(
      turn.text,
      calls,
      outcomes,
      stamps.newId,
      stamps.now,
    )
    messages.push(exchange.assistant, ...exchange.toolMessages)
  }
}

/** What one provider turn delivered, with its tool calls not yet parsed. */
interface TurnResult {
  readonly finishReason: FinishReason
  /** Text deltas joined, for the assistant message's `content`. */
  readonly text: string
  readonly calls: readonly RawToolCall[]
}

/**
 * Consumes one turn: forwards every non-`done` chunk exactly as it arrived,
 * accumulates the text and the fragmented tool-call arguments, and keeps only
 * the `done` reason for the loop's decision. The renderer does its own
 * accumulation from the forwarded fragments (that is the M1 contract), so the
 * two readers of one stream cannot disagree about what was streamed.
 */
async function consumeTurn(
  stream: AsyncIterable<ChatChunk>,
  onDelta: (chunk: ChatChunk) => void,
): Promise<TurnResult> {
  let text = ''
  const calls = new Map<string, RawToolCall>()
  let finishReason: FinishReason = 'stop'

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text':
        text += chunk.delta
        onDelta(chunk)
        break
      case 'tool_call': {
        onDelta(chunk)
        const existing = calls.get(chunk.id)
        calls.set(chunk.id, {
          id: chunk.id,
          name: existing?.name ?? chunk.name,
          // Argument text arrives fragmented across chunks; later fragments
          // append to the call already started under this id.
          argumentsText: (existing?.argumentsText ?? '') + chunk.argumentsDelta,
        })
        break
      }
      case 'tool_result':
        // Only the loop produces these in a well-formed session. Forwarded
        // rather than dropped so the stream stays a pure pass-through: the
        // renderer reads it as status only, exactly as it did in M1.
        onDelta(chunk)
        break
      case 'done':
        finishReason = chunk.finishReason
        break
    }
  }

  return { finishReason, text, calls: [...calls.values()] }
}
