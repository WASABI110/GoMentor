import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@gomentor/shared'
import {
  MAX_AGENT_STEPS,
  assembleToolExchange,
  decideTools,
  isAtCap,
  materialiseToolCalls,
  parseToolArguments,
} from '../../../src/main/llm/agent/runner'

/**
 * The agent loop's pure core (M3 Stage 2).
 *
 * These are the decisions the loop makes, in the form `scripts/mutate-llm.mts`
 * mutates: the degrade tri-state, the step cap, argument parsing, the
 * call-materialisation split, and the history assembly the provider's wire
 * encoder consumes. The stream plumbing around them is covered by the
 * integration suite against a scripted provider (`test/integration/
 * llm-agent.test.ts`), which is where its correctness actually lives.
 */

describe('decideTools — the degrade tri-state', () => {
  it('runs the agent loop only on a measured true', () => {
    expect(decideTools(true)).toBe(true)
  })

  it('degrades on a measured false', () => {
    expect(decideTools(false)).toBe(false)
  })

  it('degrades on null — unprobed is not supported', () => {
    // The load-bearing half: `null` must not read as "try tools anyway". A
    // model that cannot call tools ignores a `tools` array silently, which
    // presents to the user as the teacher answering a different question.
    expect(decideTools(null)).toBe(false)
  })
})

describe('isAtCap — the step budget', () => {
  it('caps at MAX_AGENT_STEPS consumed turns, inclusive', () => {
    expect(MAX_AGENT_STEPS).toBe(8)
    expect(isAtCap(MAX_AGENT_STEPS - 1)).toBe(false)
    expect(isAtCap(MAX_AGENT_STEPS)).toBe(true)
    expect(isAtCap(MAX_AGENT_STEPS + 1)).toBe(true)
  })
})

describe('parseToolArguments', () => {
  it('parses a JSON object into the record the contract wants', () => {
    const parsed = parseToolArguments('{"gameId":"g1","moveNumber":2}')
    expect(parsed).toEqual({
      ok: true,
      value: { gameId: 'g1', moveNumber: 2 },
    })
  })

  it('accepts the empty object — the tool schema, not this parser, judges completeness', () => {
    expect(parseToolArguments('{}')).toEqual({ ok: true, value: {} })
  })

  it('keeps a __proto__ key in model output a key, not a prototype', () => {
    // The raw text is model output, i.e. untrusted. Assigned into a normal
    // object, that key hits `Object.prototype`'s accessor and becomes the
    // record's prototype — the field the model wrote disappears. The
    // null-prototype record keeps it a plain own property the schema judges.
    const parsed = parseToolArguments('{"__proto__":{"x":1},"moveNumber":1}')
    if (!parsed.ok) throw new Error('unreachable')
    expect(Object.getPrototypeOf(parsed.value)).toBe(null)
    expect(Object.hasOwn(parsed.value, '__proto__')).toBe(true)
    expect(parsed.value).toMatchObject({ moveNumber: 1 })
  })

  it('reports malformed JSON instead of throwing', () => {
    const parsed = parseToolArguments('{"gameId": ')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('unreachable')
    // The fixed phrase is the tool result the model reads; echoing the raw
    // text would feed the run its own malformed output as context.
    expect(parsed.reason).toBe('the arguments were not valid JSON')
  })

  it.each(['[1,2]', '"5"', '5', 'null', 'true'])(
    'rejects %s — valid JSON that is not an object',
    (raw) => {
      const parsed = parseToolArguments(raw)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) throw new Error('unreachable')
      expect(parsed.reason).toBe('the arguments were not a JSON object')
    },
  )
})

describe('materialiseToolCalls', () => {
  it('keeps wire order and attaches parsed arguments', () => {
    const { calls, invalid } = materialiseToolCalls([
      { id: 'a', name: 'get_position', argumentsText: '{"moveNumber":1}' },
      { id: 'b', name: 'search_library', argumentsText: '{"player":"lee"}' },
    ])
    expect(invalid.size).toBe(0)
    expect(calls).toEqual([
      { id: 'a', name: 'get_position', arguments: { moveNumber: 1 } },
      { id: 'b', name: 'search_library', arguments: { player: 'lee' } },
    ])
  })

  it('lists an unparseable call anyway, with empty arguments and a recorded reason', () => {
    // Listed: the assistant message and its tool replies must stay one-to-one
    // or the provider rejects the history on the next turn.
    const { calls, invalid } = materialiseToolCalls([
      { id: 'bad', name: 'get_position', argumentsText: 'not json' },
    ])
    expect(calls).toEqual([{ id: 'bad', name: 'get_position', arguments: {} }])
    expect(invalid.get('bad')).toBe(
      'IPC_INVALID_REQUEST: the arguments were not valid JSON',
    )
  })
})

describe('assembleToolExchange', () => {
  const calls: ToolCall[] = [
    { id: 'call-1', name: 'get_position', arguments: { moveNumber: 2 } },
  ]

  it('pairs every tool reply with its call id and carries the outcome twice', () => {
    // `content` is duplicated deliberately: the provider's history encoder
    // sends `content` as the message body, so a result stored only under
    // `toolResult` would reach the model as an empty reply.
    const exchange = assembleToolExchange(
      '',
      calls,
      [{ toolCallId: 'call-1', outcome: { content: '{"ok":true}', isError: false } }],
      () => 'msg-id',
      () => '2026-09-07T00:00:00.000Z',
    )
    expect(exchange.assistant).toEqual({
      id: 'msg-id',
      role: 'assistant',
      content: '',
      toolCalls: calls,
      createdAt: '2026-09-07T00:00:00.000Z',
    })
    expect(exchange.toolMessages).toHaveLength(1)
    expect(exchange.toolMessages[0]).toMatchObject({
      role: 'tool',
      content: '{"ok":true}',
      toolResult: { toolCallId: 'call-1', content: '{"ok":true}', isError: false },
    })
  })

  it('carries isError through — the model self-corrects on it', () => {
    const exchange = assembleToolExchange(
      'thinking',
      calls,
      [
        {
          toolCallId: 'call-1',
          outcome: { content: 'IPC_INVALID_REQUEST: bad', isError: true },
        },
      ],
      () => 'id',
      () => 't',
    )
    expect(exchange.toolMessages[0]?.toolResult).toMatchObject({
      isError: true,
      toolCallId: 'call-1',
    })
    expect(exchange.assistant.content).toBe('thinking')
  })

  it('assembles one reply per outcome, in outcome order, each with its own id', () => {
    let next = 0
    const exchange = assembleToolExchange(
      '',
      calls,
      [
        { toolCallId: 'call-1', outcome: { content: 'first', isError: false } },
        { toolCallId: 'call-2', outcome: { content: 'second', isError: true } },
      ],
      () => `id-${String(next++)}`,
      () => 't',
    )
    expect(exchange.toolMessages.map((message) => message.id)).toEqual(['id-1', 'id-2'])
    expect(exchange.toolMessages.map((message) => message.content)).toEqual([
      'first',
      'second',
    ])
  })
})
