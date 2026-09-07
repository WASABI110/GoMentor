import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AppError,
  type AnalysisResult,
  type ChatChunk,
  type EngineGame,
  type Game,
  type SecretKey,
} from '@gomentor/shared'
import type { SgfCollection } from '@gomentor/core/sgf/ast'
import type { SettingsFs } from '../../src/main/settings'
import type { EngineService } from '../../src/main/katago/service'
import type { LlmService } from '../../src/main/llm/service'
import type { GameStore } from '../../src/main/library/store'

/**
 * M3 Stage 2 integration: the agent loop and the degrade tri-state, driven
 * through the **real** `createLlmService` and the real `runAgentLoop` by a
 * scripted provider (see `fake-llm-provider.ts` for why the fake extends the
 * real adapter class rather than reimplementing the interface).
 *
 * ## What is asserted here that no unit test can see
 *
 * - The wire: whether the request the provider received carried a `tools` key
 *   at all is the A3 acceptance criterion, and it exists only on this side of
 *   the service.
 * - The events: chunk order on `llm:delta`, exactly one terminal event per
 *   run, and the `LLM_AGENT_LIMIT` code reaching the renderer as a
 *   translatable envelope.
 * - The loop's history: what turn two's request actually contained — the
 *   assembled assistant + tool messages, and the self-correction path.
 */

/** Payloads pushed via `webContents.send`, so event fan-out is observable. */
const sentEvents: { channel: string; payload: unknown }[] = []

const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send(channel: string, payload: unknown) {
      sentEvents.push({ channel, payload })
    },
  },
}

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [fakeWindow] },
}))

// Imported after `vi.mock` so the mocked `electron` is what `events.ts` binds.
const { createLlmService } = await import('../../src/main/llm/service')
const { createGameStore } = await import('../../src/main/library/store')
const { createSettingsService } = await import('../../src/main/settings')
const { runAgentLoop } = await import('../../src/main/llm/agent/runner')
const { ScriptedLlmProvider } = await import('./fake-llm-provider')

type ScriptedLlm = InstanceType<typeof ScriptedLlmProvider>

// ---------------------------------------------------------------------------
// Fixtures and harness
// ---------------------------------------------------------------------------

function memoryFs(): SettingsFs {
  const files = new Map<string, string>()
  return {
    read: (path) => files.get(path),
    write: (path, contents) => {
      files.set(path, contents)
    },
    preserve: (path, contents) => {
      files.set(`${path}.corrupt`, contents)
    },
  }
}

function fakeSecrets() {
  const held = new Map<SecretKey, string>()
  return {
    set: (key: SecretKey, value: string) => {
      held.set(key, value)
    },
    get: (key: SecretKey) => held.get(key),
    has: (key: SecretKey) => held.has(key),
    delete: (key: SecretKey) => {
      held.delete(key)
    },
    isPersistent: () => true,
  }
}

const GAME: Game = {
  id: 'g1',
  meta: {
    boardSize: 19,
    handicap: 0,
    komi: 6.5,
    blackName: 'Lee Changho',
    whiteName: 'Cho Hoonhyun',
    date: '2023-05-01',
    ruleset: 'japanese',
  },
  setup: { black: [], white: [] },
  moves: [
    { number: 1, player: 'black', coord: { x: 3, y: 3 } },
    { number: 2, player: 'white', coord: { x: 15, y: 3 } },
  ],
  branches: [],
  source: 'import',
  contentHash: 'g1',
  importedAt: '2026-09-07T00:00:00.000Z',
}

/** A minimal collection body; these tests never serialise, only store. */
const COLLECTION: SgfCollection = {
  roots: [],
  bom: null,
  encoding: 'utf-8',
  leadingText: '',
}

const ANALYSIS: AnalysisResult = {
  queryId: 'agent:1',
  gameId: 'g1',
  moveNumber: 2,
  player: 'white',
  winrate: 0.42,
  scoreLead: -3.5,
  visits: 128,
  candidates: [],
  ownership: [0.3, -0.25],
  complete: true,
}

/**
 * A full stub of `EngineService` — not a partial cast — so an interface
 * addition fails this file's compile. `analyzeOnce` is injectable per test.
 */
function fakeEngine(
  analyzeOnce: EngineService['analyzeOnce'] = () =>
    Promise.reject(new AppError('ENGINE_UNAVAILABLE', 'not used by this test')),
): EngineService {
  return {
    info: () => ({ status: 'unavailable' }),
    start: () => Promise.resolve({ status: 'unavailable' }),
    notifyStatus: () => undefined,
    setGame: () => ({ focusQueryId: null }),
    setCursor: () => ({ focusQueryId: null }),
    analyzeOnce,
    shutdown: () => Promise.resolve(),
  }
}

/** A real store that counts `get` calls, so "the tool never ran" is observable. */
function countingStore(): { readonly store: GameStore; readonly reads: () => number } {
  const inner = createGameStore()
  inner.put({ game: GAME, collection: COLLECTION })
  let reads = 0
  const store: GameStore = {
    put: (entry) => {
      inner.put(entry)
    },
    get: (id) => {
      reads += 1
      return inner.get(id)
    },
    has: (id) => inner.has(id),
    list: () => inner.list(),
    delete: (id) => inner.delete(id),
    clear: () => {
      inner.clear()
    },
    get size() {
      return inner.size
    },
  }
  return { store, reads: () => reads }
}

function harness(
  options: {
    readonly toolsSupported?: boolean | null
    readonly analyzeOnce?: EngineService['analyzeOnce']
    readonly store?: GameStore
  } = {},
): { readonly provider: ScriptedLlm; readonly service: LlmService } {
  const store = options.store ?? countingStore().store
  const engine = fakeEngine(options.analyzeOnce)
  const provider = new ScriptedLlmProvider({
    toolsSupported: options.toolsSupported ?? null,
  })
  const settings = createSettingsService(memoryFs(), '/virtual/settings.json')
  const service = createLlmService(settings, fakeSecrets(), {
    store,
    engine,
    // The same provider for every fingerprint: each test scripts one
    // conversation and never changes settings mid-run.
    createProvider: () => provider,
  })
  return { provider, service }
}

/** A `get_position` tool-call turn, split across two argument fragments. */
function positionCall(id: string, args: string): ChatChunk[] {
  return toolCallTurn('get_position', id, args)
}

/** A `get_analysis` tool-call turn — the one that reaches the engine. */
function analysisCall(id: string, args: string): ChatChunk[] {
  return toolCallTurn('get_analysis', id, args)
}

function toolCallTurn(name: string, id: string, args: string): ChatChunk[] {
  return [
    { type: 'tool_call', id, name, argumentsDelta: args.slice(0, 10) },
    { type: 'tool_call', id, name, argumentsDelta: args.slice(10) },
    { type: 'done', finishReason: 'tool_calls' },
  ]
}

function textTurn(delta: string): ChatChunk[] {
  return [
    { type: 'text', delta },
    { type: 'done', finishReason: 'stop' },
  ]
}

// ---------------------------------------------------------------------------
// Event observation
// ---------------------------------------------------------------------------

/** Terminal payloads are `{ runId, finishReason }` or `{ runId, error }`. */
interface TerminalPayload {
  readonly runId: string
  readonly finishReason?: string
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly context?: Record<string, unknown>
  }
}

function deltas(): { runId: string; chunk: ChatChunk }[] {
  return sentEvents
    .filter((entry) => entry.channel === 'llm:delta')
    .map((entry) => entry.payload as { runId: string; chunk: ChatChunk })
}

function terminalEvents(runId: string): {
  channel: string
  payload: TerminalPayload
}[] {
  return sentEvents
    .filter((entry) => {
      if (entry.channel === 'llm:delta') return false
      return (entry.payload as TerminalPayload).runId === runId
    })
    .map((entry) => entry as { channel: string; payload: TerminalPayload })
}

/** Resolves once the run has ended, failing the test if it never does. */
async function waitForRunEnd(
  runId: string,
): Promise<{ channel: string; payload: TerminalPayload }> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const found = terminalEvents(runId)
    if (found.length > 0)
      return found[0] as { channel: string; payload: TerminalPayload }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never ended`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

beforeEach(() => {
  sentEvents.length = 0
})

// ---------------------------------------------------------------------------
// The degrade tri-state at the service entry (R3, A3)
// ---------------------------------------------------------------------------

describe('degrade: toolsSupported false runs the single-shot path', () => {
  it('sends no tools key and forwards the stream unchanged', async () => {
    const { provider, service } = harness({ toolsSupported: false })
    provider.script([
      { type: 'text', delta: 'White played ' },
      { type: 'text', delta: 'R17.' },
      { type: 'done', finishReason: 'stop' },
    ])

    const runId = service.send({ content: 'what happened?', history: [] })
    const end = await waitForRunEnd(runId)

    expect(end).toEqual({
      channel: 'llm:done',
      payload: { runId, finishReason: 'stop' },
    })
    // A3: the wire shape is the pre-M3 single-shot request. `tools` is
    // absent, not empty — an empty array is a different request.
    expect(provider.requests).toHaveLength(1)
    const request = provider.requests[0]
    expect(request && 'tools' in request).toBe(false)
    expect(request?.model).toBe('gpt-4o')
    expect(request?.temperature).toBe(0.7)
    expect(request?.maxTokens).toBe(4096)
    expect(request?.messages).toHaveLength(1)
    // Deltas forwarded in wire order; no tool activity at all.
    expect(deltas().map((entry) => entry.chunk.type)).toEqual(['text', 'text'])
  })

  it('ends a degraded run on a protocol-violating tool_calls instead of dispatching', async () => {
    // A degraded run was never offered tools; if a server returns tool_calls
    // anyway, the run ends rather than executing calls no registry answers.
    const { provider, service } = harness({ toolsSupported: false })
    provider.script([{ type: 'done', finishReason: 'tool_calls' }])

    const runId = service.send({ content: 'hi', history: [] })
    const end = await waitForRunEnd(runId)

    expect(end.payload).toEqual({ runId, finishReason: 'tool_calls' })
    expect(provider.requests).toHaveLength(1)
  })
})

describe('degrade: toolsSupported true runs the agent loop', () => {
  it('offers the registry, executes the call, and closes the loop', async () => {
    const { provider, service } = harness({ toolsSupported: true })
    provider.script(positionCall('call-1', '{"gameId":"g1","moveNumber":2}'))
    provider.script(textTurn('At move 2, White answered nearby.'))

    const runId = service.send({
      content: 'what happened at move 2?',
      history: [],
      context: { gameId: 'g1' },
    })
    const end = await waitForRunEnd(runId)

    expect(end.payload).toEqual({ runId, finishReason: 'stop' })
    expect(provider.requests).toHaveLength(2)

    const first = provider.requests[0]
    expect(first?.tools?.map((tool) => tool.name)).toEqual([
      'get_position',
      'get_analysis',
      'search_library',
    ])
    expect(first?.messages).toHaveLength(1)

    // Turn two carries the assembled exchange: the assistant message with its
    // parsed tool call, then the tool reply bound to it by id.
    const second = provider.requests[1]
    expect(second?.messages).toHaveLength(3)
    const user = second?.messages[0]
    const assistant = second?.messages[1]
    const tool = second?.messages[2]
    expect(user?.role).toBe('user')
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'get_position',
        arguments: { gameId: 'g1', moveNumber: 2 },
      },
    ])
    expect(tool?.role).toBe('tool')
    expect(tool?.toolResult).toMatchObject({ toolCallId: 'call-1', isError: false })
    // The tool ran against the real store: the summary is the position, not
    // an echo of the request.
    const summary = JSON.parse(tool?.content ?? '') as {
      gameId: string
      moveAtNumber: { coord: { x: number; y: number } }
    }
    expect(summary.gameId).toBe('g1')
    expect(summary.moveAtNumber.coord).toEqual({ x: 15, y: 3 })

    // The renderer's stream: fragments as they arrived, then the result, then
    // the answer text. No new event kinds, no new channels.
    expect(deltas().map((entry) => entry.chunk.type)).toEqual([
      'tool_call',
      'tool_call',
      'tool_result',
      'text',
    ])
  })
})

describe('degrade: toolsSupported null probes first', () => {
  it('probes, records true, and then runs the agent loop', async () => {
    const { provider, service } = harness({ toolsSupported: null })
    provider.script([
      {
        type: 'tool_call',
        id: 'probe-1',
        name: 'report_probe_ok',
        argumentsDelta: '{"value":"ok"}',
      },
      { type: 'done', finishReason: 'tool_calls' },
    ])
    provider.script(positionCall('call-1', '{"moveNumber":1}'))
    provider.script(textTurn('done'))

    const runId = service.send({ content: 'hi', history: [] })
    await waitForRunEnd(runId)

    expect(provider.requests).toHaveLength(3)
    const probe = provider.requests[0]
    // The probe is its own minimal request, not the user's conversation.
    expect(probe?.tools?.map((tool) => tool.name)).toEqual(['report_probe_ok'])
    expect(probe?.messages).toHaveLength(1)
    expect(probe?.maxTokens).toBe(64)
    expect(probe?.temperature).toBe(0)
    // The measurement is recorded on the provider for the rest of the session.
    expect(provider.capabilities.toolsSupported).toBe(true)
    // The real send carried the registry, so the run became an agent run.
    expect(provider.requests[1]?.tools?.map((tool) => tool.name)).toEqual([
      'get_position',
      'get_analysis',
      'search_library',
    ])
  })

  it('does not re-probe once a measurement is recorded', async () => {
    // The cache is the point of recording: a probe costs a provider round trip
    // per message, and `measuredToolSupport` short-circuits on anything but
    // `null`. A regression to probing every send shows up here as extra
    // `report_probe_ok` requests and a shifted request order.
    const { provider, service } = harness({ toolsSupported: null })
    provider.script([
      {
        type: 'tool_call',
        id: 'probe-1',
        name: 'report_probe_ok',
        argumentsDelta: '{"value":"ok"}',
      },
      { type: 'done', finishReason: 'tool_calls' },
    ])
    provider.script(textTurn('first answer'))
    provider.script(textTurn('second answer'))

    await waitForRunEnd(service.send({ content: 'first', history: [] }))
    await waitForRunEnd(service.send({ content: 'second', history: [] }))

    // One probe, then exactly one request per run — the second run went
    // straight to its turn, carrying the registry.
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      'report_probe_ok',
    ])
    expect(provider.requests[2]?.tools?.[0]?.name).toBe('get_position')
  })

  it('does not re-probe a recorded false either', async () => {
    const { provider, service } = harness({ toolsSupported: null })
    provider.script(textTurn('probe answered in prose'))
    provider.script(textTurn('first answer'))
    provider.script(textTurn('second answer'))

    await waitForRunEnd(service.send({ content: 'first', history: [] }))
    const second = await waitForRunEnd(service.send({ content: 'second', history: [] }))

    expect(provider.capabilities.toolsSupported).toBe(false)
    expect(provider.requests).toHaveLength(3)
    expect(second.channel).toBe('llm:done')
    expect(second.payload.finishReason).toBe('stop')
  })

  it('degrades when the probe measures no tool call', async () => {
    const { provider, service } = harness({ toolsSupported: null })
    // The probe turn: the model answers in prose — the no_tool_call measurement.
    provider.script(textTurn('ok'))
    provider.script(textTurn('single-shot answer'))

    const runId = service.send({ content: 'hi', history: [] })
    await waitForRunEnd(runId)

    expect(provider.capabilities.toolsSupported).toBe(false)
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1] && 'tools' in provider.requests[1]).toBe(false)
  })

  it('degrades when the probe cannot measure — without recording a capability', async () => {
    const { provider, service } = harness({ toolsSupported: null })
    provider.failNextWith(new AppError('LLM_UNREACHABLE', 'the server is down'))
    provider.script(textTurn('single-shot answer'))

    const runId = service.send({ content: 'hi', history: [] })
    const end = await waitForRunEnd(runId)

    expect(end.payload).toEqual({ runId, finishReason: 'stop' })
    // The run continued without tools rather than failing — the fallback the
    // design calls "prefer degrading to deadlock".
    expect(provider.requests[1] && 'tools' in provider.requests[1]).toBe(false)
    // Nothing was measured, so nothing was recorded: a later run can still
    // probe a server that has come back.
    expect(provider.capabilities.toolsSupported).toBe(null)
  })

  it('ends the run aborted when the probe is cancelled — that is not a measurement', async () => {
    const { provider, service } = harness({ toolsSupported: null })
    provider.failNextWith(new AppError('LLM_ABORTED', 'cancelled during the probe'))

    const runId = service.send({ content: 'hi', history: [] })
    const end = await waitForRunEnd(runId)

    // Cancellation semantics unchanged by M3: `llm:done` with `aborted`, not
    // an error, and not a degraded single-shot run.
    expect(end).toEqual({
      channel: 'llm:done',
      payload: { runId, finishReason: 'aborted' },
    })
    expect(provider.requests).toHaveLength(1)
    expect(provider.capabilities.toolsSupported).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle (R4): the cap, and cancellation mid-stream and mid-tool
// ---------------------------------------------------------------------------

describe('the step cap', () => {
  it('ends the run with LLM_AGENT_LIMIT after MAX_AGENT_STEPS turns, not later', async () => {
    const { provider, service } = harness({ toolsSupported: true })
    for (let turn = 0; turn < 9; turn += 1) {
      provider.script(positionCall(`call-${String(turn)}`, '{"moveNumber":1}'))
    }

    const runId = service.send({ content: 'loop forever', history: [] })
    const end = await waitForRunEnd(runId)

    // Eight provider turns happened; the ninth was refused.
    expect(provider.requests).toHaveLength(8)
    expect(end.channel).toBe('llm:error')
    expect(end.payload.error).toMatchObject({
      code: 'LLM_AGENT_LIMIT',
      context: { maxSteps: 8 },
    })
    // Exactly one terminal event: no done after the error.
    expect(terminalEvents(runId)).toHaveLength(1)
  })
})

describe('cancel mid-tool', () => {
  it('aborts the engine query, propagates, and ends the run aborted', async () => {
    let signalAtQuery: AbortSignal | undefined
    let started: () => void = () => undefined
    const queryStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const { provider, service } = harness({
      toolsSupported: true,
      analyzeOnce: (_game: EngineGame, _moveNumber: number, signal?: AbortSignal) =>
        new Promise<AnalysisResult>((_resolve, reject) => {
          signalAtQuery = signal
          started()
          signal?.addEventListener(
            'abort',
            () => {
              reject(new AppError('LLM_ABORTED', 'the analysis query was cancelled'))
            },
            { once: true },
          )
        }),
    })
    provider.script(analysisCall('call-1', '{"gameId":"g1","moveNumber":2}'))

    const runId = service.send({ content: 'analyse move 2', history: [] })
    await queryStarted
    service.cancel(runId)
    const end = await waitForRunEnd(runId)

    expect(end).toEqual({
      channel: 'llm:done',
      payload: { runId, finishReason: 'aborted' },
    })
    // The run's own signal reached the engine query — cancel threads all the
    // way down, not only into the stream.
    expect(signalAtQuery?.aborted).toBe(true)
    // Exactly one terminal event, here too — the cap path pins this count
    // explicitly; the cancellation paths must not leak a second event after
    // the abort lands (runner.ts emits once per path, and this keeps it true).
    expect(terminalEvents(runId)).toHaveLength(1)
    // No tool_result crossed to the renderer for the aborted call.
    expect(deltas().map((entry) => entry.chunk.type)).toEqual([
      'tool_call',
      'tool_call',
    ])
  })
})

describe('cancel mid-stream', () => {
  it('interrupts the provider stream and reports aborted', async () => {
    const { provider, service } = harness({ toolsSupported: false })
    provider.script([
      ...Array.from({ length: 40 }, (_, index) => ({
        type: 'text' as const,
        delta: `chunk ${String(index)} `,
      })),
      { type: 'done' as const, finishReason: 'stop' as const },
    ])

    const runId = service.send({ content: 'long answer please', history: [] })
    // Cancel at a known chunk boundary. Doing it from the hook, rather than
    // from a poll, is what makes this deterministic: the script would
    // otherwise drain its whole queue inside the poll's own await.
    provider.beforeYield = (index) => {
      if (index === 1) service.cancel(runId)
    }
    const end = await waitForRunEnd(runId)

    expect(end).toEqual({
      channel: 'llm:done',
      payload: { runId, finishReason: 'aborted' },
    })
    expect(deltas().length).toBeLessThan(40)
    expect(terminalEvents(runId)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Argument validation and self-correction (the isError path)
// ---------------------------------------------------------------------------

describe('argument validation self-correction', () => {
  it('returns an isError result for out-of-range arguments and completes on the retry', async () => {
    const { provider, service } = harness({ toolsSupported: true })
    provider.script(positionCall('call-1', '{"gameId":"g1","moveNumber":-5}'))
    provider.script(positionCall('call-2', '{"gameId":"g1","moveNumber":2}'))
    provider.script(textTurn('Move 2 was White.'))

    const runId = service.send({ content: 'move 2?', history: [] })
    await waitForRunEnd(runId)

    expect(provider.requests).toHaveLength(3)
    const last = provider.requests[2]
    expect(last?.messages).toHaveLength(5)
    const firstReply = last?.messages[2]
    expect(firstReply?.toolResult).toMatchObject({
      toolCallId: 'call-1',
      isError: true,
    })
    expect(firstReply?.content).toContain('IPC_INVALID_REQUEST')
    expect(firstReply?.content).toContain('moveNumber')
    const secondReply = last?.messages[4]
    expect(secondReply?.toolResult).toMatchObject({
      toolCallId: 'call-2',
      isError: false,
    })
  })

  it('reports malformed JSON arguments as an error without running the tool', async () => {
    const counted = countingStore()
    const { provider, service } = harness({
      toolsSupported: true,
      store: counted.store,
    })
    // Valid JSON text that is not an object: caught before any dispatch.
    provider.script(positionCall('call-1', '["moveNumber",2]'))
    provider.script(textTurn('recovered'))

    const runId = service.send({ content: 'hi', history: [] })
    await waitForRunEnd(runId)

    expect(counted.reads()).toBe(0)
    const last = provider.requests[1]
    expect(last?.messages[2]?.toolResult).toMatchObject({
      toolCallId: 'call-1',
      isError: true,
    })
    expect(last?.messages[2]?.content).toContain('not a JSON object')
  })
})

// ---------------------------------------------------------------------------
// The loop in isolation — the paths the service entry does not reach
// ---------------------------------------------------------------------------

describe('runAgentLoop (direct)', () => {
  const baseRequest = {
    messages: [{ id: 'u', role: 'user' as const, content: 'hi', createdAt: 't' }],
    model: 'scripted-model',
  }

  it('executes multiple calls of one turn serially, in wire order', async () => {
    const ran: string[] = []
    const engine = fakeEngine(() => {
      ran.push('start')
      return new Promise<AnalysisResult>((resolve) => {
        setImmediate(() => {
          ran.push('end')
          resolve(ANALYSIS)
        })
      })
    })
    const counted = countingStore()
    const provider = new ScriptedLlmProvider({ toolsSupported: true })
    provider.script([
      {
        type: 'tool_call',
        id: 'a',
        name: 'get_analysis',
        argumentsDelta: '{"moveNumber":2}',
      },
      {
        type: 'tool_call',
        id: 'b',
        name: 'get_analysis',
        argumentsDelta: '{"moveNumber":1}',
      },
      { type: 'done', finishReason: 'tool_calls' },
    ])
    provider.script(textTurn('both analysed'))

    const collected: ChatChunk['type'][] = []
    const result = await runAgentLoop({
      provider,
      request: baseRequest,
      signal: new AbortController().signal,
      onDelta: (chunk) => {
        collected.push(chunk.type)
      },
      toolContext: { gameId: 'g1', store: counted.store, engine },
    })

    expect(result.finishReason).toBe('stop')
    // Interleaved start/end pairs prove serial execution: a parallel run
    // would show both starts before either end.
    expect(ran).toEqual(['start', 'end', 'start', 'end'])
    expect(collected).toEqual([
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'text',
    ])
  })

  it('answers an unknown tool name with an error listing the registry', async () => {
    const provider = new ScriptedLlmProvider({ toolsSupported: true })
    provider.script([
      { type: 'tool_call', id: 'x', name: 'set_move', argumentsDelta: '{}' },
      { type: 'done', finishReason: 'tool_calls' },
    ])
    provider.script(textTurn('understood'))

    const result = await runAgentLoop({
      provider,
      request: baseRequest,
      signal: new AbortController().signal,
      onDelta: () => undefined,
      toolContext: { store: countingStore().store, engine: fakeEngine() },
    })

    expect(result.finishReason).toBe('stop')
    const second = provider.requests[1]
    const reply = second?.messages[2]
    expect(reply?.toolResult).toMatchObject({ isError: true })
    expect(reply?.content).toContain('unknown tool')
    expect(reply?.content).toContain('get_position')
    expect(reply?.content).toContain('get_analysis')
    expect(reply?.content).toContain('search_library')
  })

  it('without a tool context, a tool_calls turn ends the run instead of dispatching', async () => {
    const provider = new ScriptedLlmProvider({ toolsSupported: true })
    provider.script(positionCall('x', '{"moveNumber":1}'))

    const result = await runAgentLoop({
      provider,
      request: baseRequest,
      signal: new AbortController().signal,
      onDelta: () => undefined,
      // No toolContext: the degraded path.
    })

    expect(result.finishReason).toBe('tool_calls')
    expect(provider.requests).toHaveLength(1)
  })

  it('propagates an abort that fires before the first turn, at zero request cost', async () => {
    const provider = new ScriptedLlmProvider({ toolsSupported: true })
    provider.script(textTurn('never read'))
    const controller = new AbortController()
    controller.abort()

    await expect(
      runAgentLoop({
        provider,
        request: baseRequest,
        signal: controller.signal,
        onDelta: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'LLM_ABORTED' })
    expect(provider.requests).toHaveLength(0)
  })

  it('ends on a length finish reason without executing anything', async () => {
    const provider = new ScriptedLlmProvider({ toolsSupported: true })
    provider.script([
      { type: 'text', delta: 'partial' },
      { type: 'done', finishReason: 'length' },
    ])

    const result = await runAgentLoop({
      provider,
      request: baseRequest,
      signal: new AbortController().signal,
      onDelta: () => undefined,
      toolContext: { store: countingStore().store, engine: fakeEngine() },
    })
    expect(result.finishReason).toBe('length')
    expect(provider.requests).toHaveLength(1)
  })

  it('throws LLM_AGENT_LIMIT at the cap when driven directly', async () => {
    const provider = new ScriptedLlmProvider({ toolsSupported: true })
    for (let turn = 0; turn < 9; turn += 1) {
      provider.script(positionCall('call', '{"moveNumber":1}'))
    }

    await expect(
      runAgentLoop({
        provider,
        request: baseRequest,
        signal: new AbortController().signal,
        onDelta: () => undefined,
        toolContext: { store: countingStore().store, engine: fakeEngine() },
      }),
    ).rejects.toMatchObject({ code: 'LLM_AGENT_LIMIT' })
    expect(provider.requests).toHaveLength(8)
  })
})
