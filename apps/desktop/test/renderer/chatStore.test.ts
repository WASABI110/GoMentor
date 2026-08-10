import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chatChunkSchema,
  errorEnvelopeSchema,
  type ChatChunk,
  type ErrorEnvelope,
} from '@gomentor/shared'
import { useChatStore } from '../../src/renderer/src/state/chatStore'

/**
 * `chatStore` — the teacher conversation and the stream filling it.
 *
 * ## Chunks are built through the schema, not as literals
 *
 * Every `ChatChunk` below goes through `chatChunkSchema.parse`. A hand-written
 * literal is checked by TypeScript at compile time only, so a chunk shape that
 * drifted from the contract would still satisfy this file while failing in
 * production against the real `llm:delta` payload — main validates events against
 * `EVENTS` before sending. Parsing here means these tests exercise the same shapes
 * the store will actually receive.
 *
 * ## What is asserted hardest, and why
 *
 * The `runId` filter. Nothing prevents a cancelled run's deltas from arriving —
 * `llm:cancel` asks main to stop, and events already in flight still land. A store
 * that appends them interleaves an abandoned answer into a new one, which looks
 * like the model malfunctioning rather than like a bug here. Several cases below
 * exist only to prove foreign runs are dropped.
 */

const RUN = 'run-1'
const OTHER_RUN = 'run-2'

// Built through the schema, not written as a literal, for the same reason the
// chunks are: a literal is checked by `tsc` alone, and an invented code that no
// `errors` i18n entry translates would still satisfy this file. `parse` makes
// the runtime reject it too.
const FAILURE: ErrorEnvelope = errorEnvelopeSchema.parse({
  code: 'LLM_BAD_RESPONSE',
  message: 'the provider returned an unusable response',
})

function textChunk(delta: string): ChatChunk {
  return chatChunkSchema.parse({ type: 'text', delta })
}

function toolCallChunk(id: string, name: string, argumentsDelta: string): ChatChunk {
  return chatChunkSchema.parse({ type: 'tool_call', id, name, argumentsDelta })
}

interface BridgeCalls {
  sendMessage: unknown[]
  cancel: unknown[]
}

/**
 * Installs a fake bridge. Same seam as the other store tests: `contextBridge`
 * injects a global, so there is no module to `vi.mock`.
 */
function stubBridge(handlers: {
  sendMessage?: (request: unknown) => unknown
  cancel?: (request: unknown) => unknown
}): BridgeCalls {
  const calls: BridgeCalls = { sendMessage: [], cancel: [] }
  vi.stubGlobal('window', {
    gomentor: {
      llm: {
        sendMessage: (request: unknown) => {
          calls.sendMessage.push(request)
          return handlers.sendMessage === undefined
            ? { ok: true, data: { runId: RUN } }
            : handlers.sendMessage(request)
        },
        cancel: (request: unknown) => {
          calls.cancel.push(request)
          return handlers.cancel === undefined
            ? { ok: true, data: {} }
            : handlers.cancel(request)
        },
      },
    },
  })
  return calls
}

/** Drives a send to the point where the store is accepting chunks for `RUN`. */
async function startRun(): Promise<BridgeCalls> {
  const calls = stubBridge({})
  await useChatStore.getState().send('why is this move bad?')
  return calls
}

beforeEach(() => {
  // zustand stores are module singletons: without this reset a run left active by
  // one test is the starting state of the next, and the suite passes by file order.
  useChatStore.setState({
    messages: [],
    activeRunId: null,
    status: 'idle',
    streaming: '',
    toolCalls: [],
    error: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('send', () => {
  it('appends the user turn and records the run', async () => {
    const calls = await startRun()

    expect(calls.sendMessage).toHaveLength(1)
    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.role).toBe('user')
    expect(state.messages[0]?.content).toBe('why is this move bad?')
    expect(state.activeRunId).toBe(RUN)
    expect(state.status).toBe('streaming')
  })

  it('sends the history from before this turn, not including it', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('because it is slow'))
    useChatStore.getState().finishRun(RUN, 'stop')

    vi.unstubAllGlobals()
    const calls = stubBridge({})
    await useChatStore.getState().send('what should I play instead?')

    const request = calls.sendMessage[0]
    if (typeof request !== 'object' || request === null) throw new Error('no request')
    const { history, content } = request as { history: unknown[]; content: string }

    // Two turns existed before this send: the first question and its answer. The
    // new question must appear only as `content`. Sending it in `history` too reads
    // to the model as the user asking twice.
    expect(history).toHaveLength(2)
    expect(content).toBe('what should I play instead?')
    expect(JSON.stringify(history)).not.toContain('what should I play instead?')
  })

  it('gives every message a distinct id', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('first answer'))
    useChatStore.getState().finishRun(RUN, 'stop')

    const ids = useChatStore.getState().messages.map((message) => message.id)
    // Duplicate ids make React reuse the wrong DOM node and would let any future
    // persistence layer overwrite one message with another.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the user message when the send fails', async () => {
    stubBridge({ sendMessage: () => ({ ok: false, error: FAILURE }) })
    await useChatStore.getState().send('why is this move bad?')

    const state = useChatStore.getState()
    // Erasing what the user typed because the request failed forces them to retype
    // it to retry.
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.content).toBe('why is this move bad?')
    expect(state.status).toBe('error')
    expect(state.error).toEqual(FAILURE)
    expect(state.activeRunId).toBeNull()
  })

  it('does not throw on a refused send', async () => {
    stubBridge({ sendMessage: () => ({ ok: false, error: FAILURE }) })
    // A bridge call resolves to the union. If this throws, the store has started
    // unwrapping envelopes — which `contextBridge` strips down to `message` alone.
    await expect(useChatStore.getState().send('hello')).resolves.toBeUndefined()
  })

  it('refuses a second send while one is streaming', async () => {
    const calls = await startRun()
    await useChatStore.getState().send('and another thing')

    // A concurrent run would leave the first run's events arriving against a new
    // `activeRunId` — exactly the interleaving this store filters for.
    expect(calls.sendMessage).toHaveLength(1)
    expect(useChatStore.getState().messages).toHaveLength(1)
  })

  it('clears a previous error when a new send starts', async () => {
    stubBridge({ sendMessage: () => ({ ok: false, error: FAILURE }) })
    await useChatStore.getState().send('first')
    expect(useChatStore.getState().error).not.toBeNull()

    vi.unstubAllGlobals()
    stubBridge({})
    await useChatStore.getState().send('second')

    // A stale envelope keeps an error banner above a conversation that is working.
    expect(useChatStore.getState().error).toBeNull()
  })
})

describe('a foreign runId is dropped, never appended', () => {
  it('ignores text chunks from another run', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('the real answer'))
    useChatStore.getState().receiveChunk(OTHER_RUN, textChunk(' INTERLEAVED'))

    expect(useChatStore.getState().streaming).toBe('the real answer')
  })

  it('ignores a done event from another run', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('half an answer'))
    useChatStore.getState().finishRun(OTHER_RUN, 'stop')

    // Committing on a foreign `done` would publish a half-written answer as a
    // finished turn.
    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().activeRunId).toBe(RUN)
    expect(useChatStore.getState().streaming).toBe('half an answer')
  })

  it('ignores an error event from another run', async () => {
    await startRun()
    useChatStore.getState().failRun(OTHER_RUN, FAILURE)

    expect(useChatStore.getState().status).toBe('streaming')
    expect(useChatStore.getState().error).toBeNull()
  })

  it('ignores every chunk once no run is active', async () => {
    await startRun()
    useChatStore.getState().finishRun(RUN, 'stop')
    const after = useChatStore.getState().messages.length

    // Late deltas after a completed run must not start a new buffer, which would
    // show a phantom streaming answer with nothing producing it.
    useChatStore.getState().receiveChunk(RUN, textChunk('late straggler'))
    expect(useChatStore.getState().streaming).toBe('')
    expect(useChatStore.getState().messages).toHaveLength(after)
  })
})

describe('streaming text', () => {
  it('accumulates deltas in order', async () => {
    await startRun()
    for (const part of ['This ', 'move ', 'is ', 'slow.']) {
      useChatStore.getState().receiveChunk(RUN, textChunk(part))
    }
    expect(useChatStore.getState().streaming).toBe('This move is slow.')
  })

  it('is not in messages while it streams', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('partial'))

    // A half-written message in the list is indistinguishable from a complete one
    // to anything that later persists or exports the conversation.
    expect(useChatStore.getState().messages).toHaveLength(1)
    expect(useChatStore.getState().messages[0]?.role).toBe('user')
  })

  it('becomes an assistant message on done, and the buffer clears', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('Because it is slow.'))
    useChatStore.getState().finishRun(RUN, 'stop')

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]?.role).toBe('assistant')
    expect(state.messages[1]?.content).toBe('Because it is slow.')
    expect(state.streaming).toBe('')
    expect(state.activeRunId).toBeNull()
    expect(state.status).toBe('done')
  })

  it('discards a partial answer when the run fails', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('This move is sl'))
    useChatStore.getState().failRun(RUN, FAILURE)

    const state = useChatStore.getState()
    // A failed run's text stops mid-sentence; in a transcript that is
    // indistinguishable from a complete reply.
    expect(state.messages).toHaveLength(1)
    expect(state.streaming).toBe('')
    expect(state.status).toBe('error')
    expect(state.error).toEqual(FAILURE)
  })

  it('discards a partial answer when the run is aborted', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('This move is sl'))
    useChatStore.getState().finishRun(RUN, 'aborted')

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.streaming).toBe('')
    expect(state.status).toBe('idle')
  })
})

describe('tool calls accumulate as text', () => {
  it('appends argument fragments for the same call id', async () => {
    await startRun()
    useChatStore
      .getState()
      .receiveChunk(RUN, toolCallChunk('c1', 'get_position', '{"co'))
    useChatStore
      .getState()
      .receiveChunk(RUN, toolCallChunk('c1', 'get_position', 'ord":'))
    useChatStore
      .getState()
      .receiveChunk(RUN, toolCallChunk('c1', 'get_position', '"d4"}'))

    const calls = useChatStore.getState().toolCalls
    expect(calls).toHaveLength(1)
    // Replacing rather than appending would keep only the final fragment, leaving
    // `"d4"}` — which parses as nothing and names no coordinate.
    expect(calls[0]?.argumentsText).toBe('{"coord":"d4"}')
  })

  it('does not parse fragments as JSON', async () => {
    await startRun()
    // Mid-stream this text is not valid JSON. Parsing each fragment would throw on
    // almost every chunk; the store must hold it verbatim.
    expect(() => {
      useChatStore.getState().receiveChunk(RUN, toolCallChunk('c1', 'tool', '{"a'))
    }).not.toThrow()
    expect(useChatStore.getState().toolCalls[0]?.argumentsText).toBe('{"a')
  })

  it('tracks distinct call ids separately', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, toolCallChunk('c1', 'first', '{}'))
    useChatStore.getState().receiveChunk(RUN, toolCallChunk('c2', 'second', '{}'))

    expect(useChatStore.getState().toolCalls.map((call) => call.name)).toEqual([
      'first',
      'second',
    ])
  })

  it('carries completed calls onto the finished message', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, toolCallChunk('c1', 'get_position', '{}'))
    useChatStore.getState().receiveChunk(RUN, textChunk('Here is why.'))
    useChatStore.getState().finishRun(RUN, 'tool_calls')

    const assistant = useChatStore.getState().messages[1]
    expect(assistant?.toolCalls).toHaveLength(1)
    expect(assistant?.toolCalls?.[0]?.name).toBe('get_position')
  })

  it('omits toolCalls entirely when no tool ran', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('A plain answer.'))
    useChatStore.getState().finishRun(RUN, 'stop')

    // Optional in `chatMessageSchema`; an empty array would serialise into every
    // message that never used a tool.
    expect(useChatStore.getState().messages[1]?.toolCalls).toBeUndefined()
  })

  it('clears tool calls between runs', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, toolCallChunk('c1', 'first', '{}'))
    useChatStore.getState().finishRun(RUN, 'tool_calls')

    vi.unstubAllGlobals()
    stubBridge({})
    await useChatStore.getState().send('next question')

    // A leftover call would attach the previous turn's tool to this one.
    expect(useChatStore.getState().toolCalls).toEqual([])
  })
})

describe('cancel', () => {
  it('stops accepting the run it cancelled', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('being written'))

    const pending = useChatStore.getState().cancel()
    // Asserted before the await resolves: deltas arrive in exactly this window, and
    // clearing `activeRunId` only after the response would accept every one.
    useChatStore.getState().receiveChunk(RUN, textChunk(' MORE'))
    expect(useChatStore.getState().streaming).toBe('')

    await pending
    expect(useChatStore.getState().activeRunId).toBeNull()
    expect(useChatStore.getState().status).toBe('idle')
  })

  it('sends the active runId', async () => {
    const calls = await startRun()
    await useChatStore.getState().cancel()
    expect(calls.cancel).toEqual([{ runId: RUN }])
  })

  it('does nothing with no active run', async () => {
    const calls = stubBridge({})
    await useChatStore.getState().cancel()
    expect(calls.cancel).toEqual([])
  })

  it('stays idle locally even if main refuses the cancel', async () => {
    await startRun()
    vi.unstubAllGlobals()
    stubBridge({ cancel: () => ({ ok: false, error: FAILURE }) })

    await useChatStore.getState().cancel()

    const state = useChatStore.getState()
    // From the user's point of view the cancel happened. The envelope records that
    // main may still be running the request.
    expect(state.activeRunId).toBeNull()
    expect(state.status).toBe('idle')
    expect(state.error).toEqual(FAILURE)
  })

  it('allows a new send after cancelling', async () => {
    await startRun()
    await useChatStore.getState().cancel()

    vi.unstubAllGlobals()
    const calls = stubBridge({})
    await useChatStore.getState().send('a different question')

    // If cancel left `status` at 'streaming', the send guard would reject every
    // subsequent question and the input box would appear dead.
    expect(calls.sendMessage).toHaveLength(1)
  })
})

describe('clear', () => {
  it('empties the conversation and any active run', async () => {
    await startRun()
    useChatStore.getState().receiveChunk(RUN, textChunk('mid-answer'))
    useChatStore.getState().clear()

    const state = useChatStore.getState()
    expect(state.messages).toEqual([])
    expect(state.streaming).toBe('')
    expect(state.activeRunId).toBeNull()
    expect(state.status).toBe('idle')
    expect(state.error).toBeNull()
  })
})
