import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isAppError, type ChatChunk, type ChatMessage } from '@gomentor/shared'
import { createCloudProvider, CLOUD_MAX_RETRIES } from '../../src/llm/cloud'
import {
  createLocalProvider,
  LOCAL_MAX_RETRIES,
  LOCAL_TIMEOUT_MS,
} from '../../src/llm/local'
import { probeCapabilities } from '../../src/llm/probe'

/**
 * A8: streamed deltas assemble in order, tool-call fragments accumulate across
 * chunk boundaries, `AbortSignal` terminates promptly, 429/500 surface as typed
 * errors — for both factories.
 *
 * Against a **real HTTP server** on a real socket, not a mocked SDK object. That
 * is the requirement (`design.md` §Delivery verification) and it is not
 * ceremony: a stubbed client cannot exercise SSE framing, cannot show that a
 * retry is a second HTTP request, and cannot demonstrate that an abort actually
 * closes a connection mid-body. Each of those is a place this code could be
 * wrong while looking right.
 */

/** One recorded request, so retry counts are observed rather than assumed. */
interface RecordedRequest {
  readonly path: string
  readonly authorization: string | undefined
  readonly body: string
}

type Handler = (
  request: RecordedRequest,
  response: import('node:http').ServerResponse,
  requestIndex: number,
) => void | Promise<void>

let server: Server
let baseUrl: string
let requests: RecordedRequest[]
let handler: Handler

beforeEach(async () => {
  requests = []
  handler = (_request, response) => {
    response.writeHead(500).end()
  }

  server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const recorded: RecordedRequest = {
        path: incoming.url ?? '',
        authorization: incoming.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(recorded)
      void handler(recorded, response, requests.length - 1)
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${String(address.port)}/v1`
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })
})

/** Writes SSE frames, one per `chunk`, then `[DONE]`. */
function sendSse(
  response: import('node:http').ServerResponse,
  frames: unknown[],
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const frame of frames) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  response.write('data: [DONE]\n\n')
  response.end()
}

/** A text-delta frame in the wire shape. */
function textFrame(delta: string, finishReason: string | null = null): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { content: delta }, finish_reason: finishReason }],
  }
}

/** A tool-call fragment frame. `id`/`name` omitted on continuation fragments. */
function toolFrame(
  fragment: { index: number; id?: string; name?: string; args?: string },
  finishReason: string | null = null,
): unknown {
  const call: Record<string, unknown> = { index: fragment.index }
  if (fragment.id !== undefined) call.id = fragment.id
  const fn: Record<string, unknown> = {}
  if (fragment.name !== undefined) fn.name = fragment.name
  if (fragment.args !== undefined) fn.arguments = fragment.args
  if (Object.keys(fn).length > 0) call.function = fn
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: finishReason }],
  }
}

const USER_MESSAGE: ChatMessage = {
  id: 'm1',
  role: 'user',
  content: 'explain this position',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function cloud(): ReturnType<typeof createCloudProvider> {
  return createCloudProvider(
    { baseUrl, model: 'test-model', toolsSupported: null },
    'sk-test-key',
  )
}

function local(): ReturnType<typeof createLocalProvider> {
  return createLocalProvider({ baseUrl, model: 'test-model', toolsSupported: null })
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** Text deltas in arrival order. Narrowed once here rather than at every use. */
function textDeltas(chunks: readonly ChatChunk[]): string[] {
  return chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : []))
}

/** Tool-call chunks, narrowed so tests can read `.id` without re-checking. */
function toolCalls(
  chunks: readonly ChatChunk[],
): { id: string; name: string; argumentsDelta: string }[] {
  return chunks.flatMap((chunk) =>
    chunk.type === 'tool_call'
      ? [{ id: chunk.id, name: chunk.name, argumentsDelta: chunk.argumentsDelta }]
      : [],
  )
}

describe('chunk assembly order', () => {
  it('yields text deltas in wire order', async () => {
    // Deliberately words whose concatenation is only right in one order, so a
    // test that passed on a set-like comparison would fail here.
    const words = ['White', ' is', ' ahead', ' by', ' four', ' points']
    handler = (_request, response) => {
      sendSse(response, [...words.map((w) => textFrame(w)), textFrame('', 'stop')])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )

    const text = textDeltas(chunks)
    expect(text).toEqual(words)
    expect(text.join('')).toBe('White is ahead by four points')
  })

  it('terminates a successful stream with exactly one done chunk', async () => {
    handler = (_request, response) => {
      sendSse(response, [textFrame('a'), textFrame('b'), textFrame('', 'stop')])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )

    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1)
    // Last, not merely present: a done in the middle would mean a consumer
    // could stop reading before the text arrived.
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'stop' })
  })

  it('drops empty text deltas rather than emitting no-op chunks', async () => {
    // The wire sends an empty content delta alongside the finish reason. Passing
    // it through would make consumers handle a meaningless chunk.
    handler = (_request, response) => {
      sendSse(response, [textFrame('real'), textFrame(''), textFrame('', 'stop')])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(1)
  })

  it('reports an unknown finish reason as error, not stop', async () => {
    // Coercing an unrecognised reason to `stop` would tell the UI a truncated
    // reply completed normally.
    handler = (_request, response) => {
      sendSse(response, [textFrame('partial'), textFrame('', 'content_filter')])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'error' })
  })

  it('maps length and tool_calls finish reasons', async () => {
    for (const [wire, expected] of [
      ['length', 'length'],
      ['tool_calls', 'tool_calls'],
      ['function_call', 'tool_calls'],
    ] as const) {
      handler = (_request, response) => {
        sendSse(response, [textFrame('x'), textFrame('', wire)])
      }
      const chunks = await collect(
        cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
      )
      expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: expected })
    }
  })
})

describe('tool-call fragments across chunk boundaries', () => {
  it('attributes continuation fragments to the call that opened them', async () => {
    // The shape that matters: id and name arrive once, on the first fragment.
    // Every later fragment carries argument text only. A provider that did not
    // remember the id would emit unattributed fragments or throw.
    handler = (_request, response) => {
      sendSse(response, [
        toolFrame({ index: 0, id: 'call_1', name: 'get_analysis', args: '' }),
        toolFrame({ index: 0, args: '{"move' }),
        toolFrame({ index: 0, args: 'Number":' }),
        toolFrame({ index: 0, args: '42}' }),
        textFrame('', 'tool_calls'),
      ])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )
    const calls = toolCalls(chunks)

    expect(calls).toHaveLength(4)
    for (const call of calls) {
      expect(call.id).toBe('call_1')
      expect(call.name).toBe('get_analysis')
    }

    // The point of streaming fragments: the consumer joins them into the JSON.
    const joined = calls.map((c) => c.argumentsDelta).join('')
    expect(joined).toBe('{"moveNumber":42}')
    expect(JSON.parse(joined)).toEqual({ moveNumber: 42 })
  })

  it('keeps two concurrent calls separate by wire index', async () => {
    // Interleaved on purpose. Keying on index rather than arrival order is what
    // stops one call's arguments from being appended to the other's.
    handler = (_request, response) => {
      sendSse(response, [
        toolFrame({ index: 0, id: 'call_a', name: 'first', args: '{"a"' }),
        toolFrame({ index: 1, id: 'call_b', name: 'second', args: '{"b"' }),
        toolFrame({ index: 0, args: ':1}' }),
        toolFrame({ index: 1, args: ':2}' }),
        textFrame('', 'tool_calls'),
      ])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )
    const byId = new Map<string, string>()
    for (const chunk of chunks) {
      if (chunk.type !== 'tool_call') continue
      byId.set(chunk.id, (byId.get(chunk.id) ?? '') + chunk.argumentsDelta)
    }

    expect(byId.get('call_a')).toBe('{"a":1}')
    expect(byId.get('call_b')).toBe('{"b":2}')
  })

  it('interleaves text and tool-call chunks in wire order', async () => {
    handler = (_request, response) => {
      sendSse(response, [
        textFrame('Let me check. '),
        toolFrame({ index: 0, id: 'call_1', name: 'lookup', args: '{}' }),
        textFrame('Found it.'),
        textFrame('', 'stop'),
      ])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )
    expect(chunks.map((c) => c.type)).toEqual(['text', 'tool_call', 'text', 'done'])
  })

  it('rejects a fragment that never carried an id', async () => {
    // Unattributable argument text. Silently dropping it would lose part of a
    // tool call and produce invalid JSON downstream.
    handler = (_request, response) => {
      sendSse(response, [
        toolFrame({ index: 0, args: '{"orphan":1}' }),
        textFrame('', 'tool_calls'),
      ])
    }

    const provider = cloud()
    await expect(
      collect(provider.chat({ messages: [USER_MESSAGE], model: 'test-model' })),
    ).rejects.toMatchObject({ code: 'LLM_BAD_RESPONSE' })
  })
})

describe('abort', () => {
  it('terminates promptly mid-stream and throws LLM_ABORTED', async () => {
    // The server keeps writing frames and never ends the response, so the only
    // way this test finishes is the abort actually closing the stream.
    let closed = false
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.on('close', () => {
        closed = true
      })
      const timer = setInterval(() => {
        response.write(`data: ${JSON.stringify(textFrame('tick '))}\n\n`)
      }, 5)
      response.on('close', () => {
        clearInterval(timer)
      })
    }

    const controller = new AbortController()
    const provider = cloud()
    const started = Date.now()
    let received = 0

    await expect(
      (async () => {
        for await (const chunk of provider.chat(
          { messages: [USER_MESSAGE], model: 'test-model' },
          controller.signal,
        )) {
          if (chunk.type === 'text') {
            received += 1
            if (received === 3) controller.abort()
          }
        }
      })(),
    ).rejects.toMatchObject({ code: 'LLM_ABORTED' })

    // Promptly: an abort that only took effect at some timeout would blow this.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(received).toBe(3)
    // The socket is released, not leaked until GC.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(true)
  })

  it('costs zero requests when the signal is already aborted', async () => {
    handler = (_request, response) => {
      sendSse(response, [textFrame('should never be sent', 'stop')])
    }
    const controller = new AbortController()
    controller.abort()

    await expect(
      collect(
        cloud().chat(
          { messages: [USER_MESSAGE], model: 'test-model' },
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ code: 'LLM_ABORTED' })

    expect(requests).toHaveLength(0)
  })

  it('reports an abort as aborted, never as a server error', async () => {
    // The distinction users feel: "you cancelled" versus "the provider broke".
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(textFrame('a'))}\n\n`)
      // Left open.
    }

    const controller = new AbortController()
    const provider = cloud()
    setTimeout(() => {
      controller.abort()
    }, 30)

    const error = await collect(
      provider.chat(
        { messages: [USER_MESSAGE], model: 'test-model' },
        controller.signal,
      ),
    ).catch((e: unknown) => e)

    expect(isAppError(error)).toBe(true)
    expect(isAppError(error) ? error.code : '').toBe('LLM_ABORTED')
  })
})

describe('typed HTTP errors', () => {
  it('surfaces 429 as LLM_RATE_LIMITED', async () => {
    handler = (_request, response) => {
      response
        .writeHead(429, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'slow down' } }))
    }

    await expect(
      collect(cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' })),
    ).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' })
  })

  it('surfaces 500 as LLM_BAD_RESPONSE', async () => {
    handler = (_request, response) => {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'internal' } }))
    }

    await expect(
      collect(cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' })),
    ).rejects.toMatchObject({ code: 'LLM_BAD_RESPONSE' })
  })

  it('surfaces 401 as LLM_UNAUTHORIZED, distinct from unreachable', async () => {
    handler = (_request, response) => {
      response
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'bad key' } }))
    }

    await expect(
      collect(cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' })),
    ).rejects.toMatchObject({ code: 'LLM_UNAUTHORIZED' })
  })

  it('does not leak the api key or request detail into the error envelope', async () => {
    // `quality-guidelines.md`: no secrets reachable by a log call. The envelope
    // is what crosses to the renderer and what gets logged.
    //
    // The key is not the only hazard. An SDK error's own message can carry the
    // request URL — which for some providers holds the key in a query string —
    // and the local address and port. So this asserts the envelope message is
    // *our* fixed string, not a wrapped SDK one. A mutation appending
    // `String(error)` to the message escaped a key-only check.
    handler = (_request, response) => {
      response
        .writeHead(418, { 'content-type': 'application/json' })
        .end('{"error":{"message":"boom"}}')
    }

    const error = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    ).catch((e: unknown) => e)

    expect(isAppError(error)).toBe(true)
    const envelope = isAppError(error)
      ? error.toEnvelope()
      : { code: '' as const, message: '', context: undefined }
    const serialised = JSON.stringify(envelope)

    expect(serialised).not.toContain('sk-test-key')
    // Nothing about where the request went.
    expect(serialised).not.toContain('127.0.0.1')
    expect(serialised).not.toContain('/v1/chat')
    // Not the provider's own error text either — it is attacker-influenced and
    // unbounded.
    expect(serialised).not.toContain('boom')
    // Our fixed message, exactly.
    expect(envelope.message).toBe('the provider request failed')

    // And no stack or cause crosses the boundary.
    expect(Object.keys(envelope)).not.toContain('stack')
    expect(Object.keys(envelope)).not.toContain('cause')
  })

  it('keeps the key out of the envelope on every error path', async () => {
    // Each mapped status, not just the fallback: any one of them could grow a
    // message that interpolates the failure.
    for (const status of [401, 429, 500, 503]) {
      handler = (_request, response) => {
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end('{"error":{"message":"sk-test-key appeared in provider output"}}')
      }
      const error = await collect(
        cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
      ).catch((e: unknown) => e)

      expect(isAppError(error)).toBe(true)
      const serialised = JSON.stringify(isAppError(error) ? error.toEnvelope() : {})
      expect(serialised).not.toContain('sk-test-key')
    }
  })
})

describe('retry policy is observable, not just configured', () => {
  it('cloud retries a 500 exactly twice, for three requests total', async () => {
    handler = (_request, response) => {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end('{"error":{}}')
    }

    await expect(
      collect(cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' })),
    ).rejects.toMatchObject({ code: 'LLM_BAD_RESPONSE' })

    // Counted on the wire. 1 initial + 2 retries.
    expect(requests).toHaveLength(CLOUD_MAX_RETRIES + 1)
  })

  it('local does not retry at all, for one request total', async () => {
    handler = (_request, response) => {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end('{"error":{}}')
    }

    await expect(
      collect(local().chat({ messages: [USER_MESSAGE], model: 'test-model' })),
    ).rejects.toMatchObject({ code: 'LLM_BAD_RESPONSE' })

    expect(requests).toHaveLength(LOCAL_MAX_RETRIES + 1)
    expect(requests).toHaveLength(1)
  })

  it('cloud succeeds on a retry after a transient failure', async () => {
    // Shows the retry is a real second request that can succeed, not a loop
    // that reports the first failure regardless.
    handler = (_request, response, index) => {
      if (index === 0) {
        response
          .writeHead(500, { 'content-type': 'application/json' })
          .end('{"error":{}}')
        return
      }
      sendSse(response, [textFrame('recovered'), textFrame('', 'stop')])
    }

    const chunks = await collect(
      cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }),
    )
    expect(chunks.filter((c) => c.type === 'text')).toEqual([
      { type: 'text', delta: 'recovered' },
    ])
    expect(requests).toHaveLength(2)
  })

  it('local surfaces a 429 without retrying', async () => {
    handler = (_request, response) => {
      response
        .writeHead(429, { 'content-type': 'application/json' })
        .end('{"error":{}}')
    }

    await expect(
      collect(local().chat({ messages: [USER_MESSAGE], model: 'test-model' })),
    ).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' })
    expect(requests).toHaveLength(1)
  })
})

describe('factory configuration', () => {
  it('gives local a long timeout and cloud a short one', () => {
    // The asymmetry is the reason two factories exist over one adapter.
    expect(local().config.timeoutMs).toBe(LOCAL_TIMEOUT_MS)
    expect(local().config.maxRetries).toBe(0)
    expect(cloud().config.maxRetries).toBe(CLOUD_MAX_RETRIES)
    expect(local().config.timeoutMs).toBeGreaterThan(cloud().config.timeoutMs)
  })

  it('sends the key as a bearer token for cloud', async () => {
    handler = (_request, response) => {
      sendSse(response, [textFrame('ok', 'stop')])
    }
    await collect(cloud().chat({ messages: [USER_MESSAGE], model: 'test-model' }))
    expect(requests[0]?.authorization).toBe('Bearer sk-test-key')
  })

  it('reports capabilities as unprobed rather than unsupported', () => {
    // `null` and `false` mean different things to M3's agent loop: probe, or
    // degrade. Defaulting to `false` would skip the probe forever.
    expect(cloud().capabilities.toolsSupported).toBeNull()
    expect(local().capabilities.toolsSupported).toBeNull()
  })

  it('omits the tools field entirely when no tools are given', async () => {
    // Not `tools: []` — some local servers reject an empty array, and it is a
    // different request.
    handler = (_request, response) => {
      sendSse(response, [textFrame('ok', 'stop')])
    }
    await collect(local().chat({ messages: [USER_MESSAGE], model: 'test-model' }))
    const body: unknown = JSON.parse(requests[0]?.body ?? '{}')
    expect(Object.keys(body as object)).not.toContain('tools')
  })

  it('omits the tools field for an explicitly empty array too', async () => {
    // The `undefined` case alone does not pin this: dropping the
    // `.length === 0` guard leaves that path identical and only breaks when a
    // caller passes `[]`, which a `for`-loop over no tools naturally produces.
    handler = (_request, response) => {
      sendSse(response, [textFrame('ok', 'stop')])
    }
    await collect(
      local().chat({ messages: [USER_MESSAGE], model: 'test-model', tools: [] }),
    )
    const body: unknown = JSON.parse(requests[0]?.body ?? '{}')
    expect(Object.keys(body as object)).not.toContain('tools')
  })

  it('sends tools when they are given', async () => {
    // The other half: the omission above must not be "never sends tools".
    handler = (_request, response) => {
      sendSse(response, [textFrame('ok', 'stop')])
    }
    await collect(
      local().chat({
        messages: [USER_MESSAGE],
        model: 'test-model',
        tools: [
          { name: 'get_analysis', description: 'd', parameters: { type: 'object' } },
        ],
      }),
    )
    const body = JSON.parse(requests[0]?.body ?? '{}') as {
      tools?: { type: string; function: { name: string } }[]
    }
    expect(body.tools).toHaveLength(1)
    expect(body.tools?.[0]?.type).toBe('function')
    expect(body.tools?.[0]?.function.name).toBe('get_analysis')
  })
})

describe('health and models', () => {
  it('treats a 401 as reachable', async () => {
    // A bad key means the server answered. Reporting "unreachable" would send
    // the user to check their network instead of their key.
    handler = (_request, response) => {
      response
        .writeHead(401, { 'content-type': 'application/json' })
        .end('{"error":{}}')
    }
    expect(await cloud().health()).toBe(true)
  })

  it('treats a connection failure as unhealthy', async () => {
    const unreachable = createCloudProvider(
      // Port 1 on loopback: nothing listens there.
      { baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model', toolsSupported: null },
      'sk-test-key',
    )
    expect(await unreachable.health()).toBe(false)
  })

  it('lists models', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'model-a' }, { id: 'model-b' }],
        }),
      )
    }
    expect(await local().listModels()).toEqual([{ id: 'model-a' }, { id: 'model-b' }])
  })
})

describe('capability probe', () => {
  it('records tools as supported when the model calls one', async () => {
    handler = (_request, response) => {
      sendSse(response, [
        toolFrame({
          index: 0,
          id: 'call_1',
          name: 'report_probe_ok',
          args: '{"value":"ok"}',
        }),
        textFrame('', 'tool_calls'),
      ])
    }

    const provider = local()
    const result = await probeCapabilities(provider)

    expect(result).toEqual({ toolsSupported: true, reason: 'tool_call' })
    expect(provider.capabilities.toolsSupported).toBe(true)
  })

  it('records tools as unsupported when the model answers in prose', async () => {
    // The case that cannot be inferred from config: the server accepted the
    // tools array and the model ignored it.
    handler = (_request, response) => {
      sendSse(response, [textFrame('Sure, tools work!'), textFrame('', 'stop')])
    }

    const provider = local()
    const result = await probeCapabilities(provider)

    expect(result).toEqual({ toolsSupported: false, reason: 'no_tool_call' })
    expect(provider.capabilities.toolsSupported).toBe(false)
  })

  it('does not record a result when it could not measure', async () => {
    // Unreachable says nothing about tool support. Recording `false` would
    // leave a wrong capability behind for the session.
    const provider = createLocalProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test-model',
      toolsSupported: null,
    })
    const result = await probeCapabilities(provider)

    expect(result.reason).toBe('unreachable')
    expect(provider.capabilities.toolsSupported).toBeNull()
  })

  it('propagates an abort instead of recording a negative', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'event-stream' })
      // Left open so only the abort ends it.
    }

    const provider = local()
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 30)

    await expect(probeCapabilities(provider, controller.signal)).rejects.toMatchObject({
      code: 'LLM_ABORTED',
    })
    expect(provider.capabilities.toolsSupported).toBeNull()
  })

  it('sends the probe tool in the request', async () => {
    handler = (_request, response) => {
      sendSse(response, [textFrame('no', 'stop')])
    }
    await probeCapabilities(local())

    const body = JSON.parse(requests[0]?.body ?? '{}') as {
      tools?: { function: { name: string } }[]
      temperature?: number
    }
    expect(body.tools?.[0]?.function.name).toBe('report_probe_ok')
    // Deterministic, so a probe that passes once does not fail next time on
    // sampling alone.
    expect(body.temperature).toBe(0)
  })
})
