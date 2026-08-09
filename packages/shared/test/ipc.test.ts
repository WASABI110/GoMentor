import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import {
  CHANNELS,
  CHANNEL_NAMES,
  EVENTS,
  EVENT_NAMES,
  type ChannelName,
  type EventName,
} from '../src/ipc'

/**
 * A9: every channel accepts one valid payload and rejects at least two
 * invalid ones, and a meta-test asserts no channel lacks coverage.
 *
 * The meta-test is the load-bearing part. Per-channel cases can be forgotten
 * when a channel is added; the meta-test cannot be, because it fails.
 * `test/ipc-meta.test.ts` proves the meta-test itself is not vacuous.
 */

interface ChannelCase {
  validRequest: unknown
  invalidRequests: [unknown, unknown, ...unknown[]]
  validResponse: unknown
  invalidResponses: [unknown, unknown, ...unknown[]]
}

const gameFixture = {
  id: 'g1',
  meta: { boardSize: 19, handicap: 0, komi: 6.5 },
  moves: [{ number: 1, player: 'black', coord: { x: 3, y: 3 } }],
  source: 'import',
  contentHash: 'abc123',
  importedAt: '2026-08-04T00:00:00Z',
}

const summaryFixture = {
  id: 'g1',
  moveCount: 1,
  boardSize: 19,
  source: 'import',
}

const settingsFixture = {
  version: 1,
  llm: {
    kind: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    hasKey: false,
    temperature: 0.7,
    maxTokens: 4096,
    toolsSupported: null,
  },
  engine: {
    backend: null,
    maxVisits: 500,
    threads: 4,
    analyzeOwnership: true,
  },
  library: { roots: [], watchEnabled: true },
  ui: {
    locale: 'zh-CN',
    theme: 'dark',
    showCoordinates: true,
    animationsEnabled: true,
    panelWidths: { library: 260, teacher: 360 },
  },
  telemetryConsent: false,
  debugLogging: false,
}

const CASES: Record<ChannelName, ChannelCase> = {
  'sgf:parse': {
    validRequest: { content: '(;GM[1]FF[4]SZ[19])' },
    invalidRequests: [{}, { content: 42 }, { content: null }],
    validResponse: gameFixture,
    invalidResponses: [
      {},
      // Board size 21 is not a supported size.
      { ...gameFixture, meta: { ...gameFixture.meta, boardSize: 21 } },
      // Move numbers are 1-based; 0 is the empty board, not a move.
      { ...gameFixture, moves: [{ number: 0, player: 'black', coord: null }] },
    ],
  },
  'sgf:serialize': {
    validRequest: { gameId: 'g1' },
    invalidRequests: [{}, { gameId: '' }, { gameId: 7 }],
    validResponse: { content: '(;GM[1])' },
    invalidResponses: [{}, { content: 1 }],
  },
  'sgf:openDialog': {
    validRequest: {},
    invalidRequests: [null, 'nope'],
    // Empty array is valid: the user cancelled, which is not an error.
    validResponse: { filePaths: [] },
    invalidResponses: [{}, { filePaths: 'a.sgf' }, { filePaths: [1] }],
  },

  'library:list': {
    validRequest: {},
    invalidRequests: [null, 42],
    validResponse: { games: [summaryFixture] },
    invalidResponses: [{}, { games: {} }, { games: [{ id: 'g1' }] }],
  },
  'library:import': {
    validRequest: { filePaths: ['a.sgf'] },
    // An empty batch is a caller bug, not an empty result.
    invalidRequests: [{ filePaths: [] }, {}, { filePaths: 'a.sgf' }],
    validResponse: { imported: [summaryFixture], duplicates: 0, failures: [] },
    invalidResponses: [
      {},
      { imported: [], duplicates: -1, failures: [] },
      // failures must carry a typed error envelope, not a bare string.
      { imported: [], duplicates: 0, failures: [{ filePath: 'a.sgf', error: 'boom' }] },
    ],
  },

  'llm:sendMessage': {
    validRequest: { content: 'why was move 47 bad?', history: [] },
    invalidRequests: [{ content: '' }, {}, { content: 5, history: [] }],
    validResponse: { runId: 'r1' },
    invalidResponses: [{}, { runId: 1 }],
  },
  'llm:cancel': {
    validRequest: { runId: 'r1' },
    invalidRequests: [{}, { runId: '' }, { runId: null }],
    validResponse: {},
    invalidResponses: [null, 'ok'],
  },

  'settings:get': {
    validRequest: {},
    invalidRequests: [null, 3],
    validResponse: settingsFixture,
    invalidResponses: [
      null,
      { ...settingsFixture, ui: { ...settingsFixture.ui, locale: 'klingon' } },
      { ...settingsFixture, llm: { ...settingsFixture.llm, baseUrl: 'not a url' } },
    ],
  },
  'settings:set': {
    validRequest: { patch: { debugLogging: true } },
    invalidRequests: [{}, { patch: null }, { patch: { telemetryConsent: 'yes' } }],
    validResponse: settingsFixture,
    invalidResponses: [null, { ...settingsFixture, version: 0 }],
  },
  'settings:setSecret': {
    validRequest: { key: 'llmApiKey', value: 'sk-test' },
    invalidRequests: [
      { key: 'llmApiKey' },
      // Arbitrary secret names would let the renderer address anything.
      { key: 'somethingElse', value: 'x' },
      { value: 'x' },
    ],
    validResponse: {},
    invalidResponses: [null, 'stored'],
  },
  'settings:hasSecret': {
    validRequest: { key: 'foxSessionToken' },
    invalidRequests: [{}, { key: 'nope' }, { key: 123 }],
    validResponse: { present: true },
    invalidResponses: [{}, { present: 'yes' }],
  },
}

const EVENT_CASES: Record<
  EventName,
  { valid: unknown; invalid: [unknown, unknown, ...unknown[]] }
> = {
  'llm:delta': {
    valid: { runId: 'r1', chunk: { type: 'text', delta: 'hello' } },
    invalid: [
      {},
      // Unknown chunk type: the discriminated union must reject it.
      { runId: 'r1', chunk: { type: 'mystery', delta: 'x' } },
      { runId: 'r1', chunk: { type: 'text' } },
    ],
  },
  'llm:done': {
    valid: { runId: 'r1', finishReason: 'stop' },
    invalid: [{}, { runId: 'r1', finishReason: 'whatever' }],
  },
  'llm:error': {
    valid: { runId: 'r1', error: { code: 'LLM_TIMEOUT', message: 'timed out' } },
    invalid: [
      {},
      // Error codes are a closed set so the UI can translate them.
      { runId: 'r1', error: { code: 'MADE_UP', message: 'x' } },
      { runId: 'r1', error: { message: 'no code' } },
    ],
  },
  'library:changed': {
    valid: { reason: 'import' },
    invalid: [{}, { reason: 'telepathy' }],
  },
  'menu:command': {
    valid: { command: 'openSgf' },
    invalid: [
      {},
      // A closed enum, not a free string. The renderer switches on this to pick
      // a flow, so an unknown command would silently do nothing — and an open
      // string would let a future main-side typo ship undetected.
      { command: 'openSGF' },
      { command: 'rm -rf' },
    ],
  },
  'engine:status': {
    valid: { status: 'unavailable' },
    invalid: [{}, { status: 'confused' }, { status: 'ready', downloadProgress: 2 }],
  },
}

function expectAccepts(schema: ZodType, value: unknown, label: string): void {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(
      `${label} should accept ${JSON.stringify(value)}: ${result.error.message}`,
    )
  }
}

function expectRejects(schema: ZodType, value: unknown, label: string): void {
  expect(
    schema.safeParse(value).success,
    `${label} should reject ${JSON.stringify(value)}`,
  ).toBe(false)
}

describe('IPC channel schemas', () => {
  for (const name of CHANNEL_NAMES) {
    const spec = CHANNELS[name]
    const testCase = CASES[name]

    describe(name, () => {
      it('accepts a valid request', () => {
        expectAccepts(spec.request, testCase.validRequest, `${name} request`)
      })

      it('rejects invalid requests', () => {
        for (const bad of testCase.invalidRequests) {
          expectRejects(spec.request, bad, `${name} request`)
        }
      })

      it('accepts a valid response', () => {
        expectAccepts(spec.response, testCase.validResponse, `${name} response`)
      })

      it('rejects invalid responses', () => {
        for (const bad of testCase.invalidResponses) {
          expectRejects(spec.response, bad, `${name} response`)
        }
      })
    })
  }
})

describe('IPC event schemas', () => {
  for (const name of EVENT_NAMES) {
    const schema = EVENTS[name]
    const testCase = EVENT_CASES[name]

    describe(name, () => {
      it('accepts a valid payload', () => {
        expectAccepts(schema, testCase.valid, name)
      })

      it('rejects invalid payloads', () => {
        for (const bad of testCase.invalid) {
          expectRejects(schema, bad, name)
        }
      })
    })
  }
})

describe('coverage meta-test', () => {
  // The point of this block: a channel added without a test case fails here,
  // so coverage cannot silently rot. Proven non-vacuous in ipc-meta.test.ts.
  it('every channel has a test case', () => {
    const missing = CHANNEL_NAMES.filter((name) => !(name in CASES))
    expect(missing, `channels without test cases: ${missing.join(', ')}`).toEqual([])
  })

  it('every event has a test case', () => {
    const missing = EVENT_NAMES.filter((name) => !(name in EVENT_CASES))
    expect(missing, `events without test cases: ${missing.join(', ')}`).toEqual([])
  })

  it('no test case refers to a channel that no longer exists', () => {
    const stale = Object.keys(CASES).filter((name) => !(name in CHANNELS))
    expect(stale, `stale channel cases: ${stale.join(', ')}`).toEqual([])
  })

  it('every channel provides at least two invalid request cases', () => {
    for (const name of CHANNEL_NAMES) {
      expect(
        CASES[name].invalidRequests.length,
        `${name} needs >=2 invalid requests`,
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('channel names all follow domain:verb', () => {
    for (const name of CHANNEL_NAMES) {
      expect(name, `${name} must be domain:verb`).toMatch(/^[a-z]+:[a-zA-Z]+$/)
    }
  })
})

describe('a settings patch is not inflated by validation', () => {
  /**
   * `register.ts` hands the handler zod's **output**, not the raw request. So a
   * request schema that fills in defaults does not merely permit a value — it
   * fabricates one, and the handler cannot tell a default apart from a field the
   * user deliberately set.
   *
   * That is what `settingsSchema.partial()` did here. `.partial()` makes keys
   * optional on input but leaves each field's `.default()` in place, so a patch
   * naming `llm.model` arrived carrying an explicit value for every other
   * setting — resetting theme to dark, locale to zh-CN, and each preference the
   * user had chosen. Silently, with no error.
   *
   * These tests assert on the *output* rather than on `success`, because
   * acceptance was never the problem.
   */
  const parse = (patch: unknown): unknown => {
    const result = CHANNELS['settings:set'].request.safeParse({ patch })
    // `?? '(root)'`: with `noUncheckedIndexedAccess`, `issues[0]` is possibly
    // undefined, and a bare template would stringify that as "undefined" — a
    // rejection message that names no field at all.
    if (!result.success) {
      throw new Error(`rejected: ${result.error.issues[0]?.path.join('.') ?? '(root)'}`)
    }
    return (result.data as { patch: unknown }).patch
  }

  it('returns exactly the fields the caller named', () => {
    expect(parse({ llm: { model: 'gpt-5' } })).toEqual({ llm: { model: 'gpt-5' } })
  })

  it('does not invent sibling fields inside a named section', () => {
    // The specific regression: `temperature` and `baseUrl` must not appear.
    // Keys, not just values — an added key with the default value is what
    // overwrote the user's setting downstream.
    expect(Object.keys(parse({ llm: { model: 'gpt-5' } }) as object)).toEqual(['llm'])
    expect(
      Object.keys((parse({ llm: { model: 'gpt-5' } }) as { llm: object }).llm),
    ).toEqual(['model'])
  })

  it('does not invent whole sections the caller never mentioned', () => {
    expect(Object.keys(parse({ debugLogging: true }) as object)).toEqual([
      'debugLogging',
    ])
  })

  it('leaves an empty patch empty', () => {
    // A no-op patch that came back as the full default document would rewrite
    // every setting on the next save.
    expect(parse({})).toEqual({})
  })

  it('still rejects an out-of-range value', () => {
    // Dropping defaults must not have dropped validation with them.
    expect(() => parse({ llm: { temperature: 99 } })).toThrow()
    expect(() => parse({ engine: { maxVisits: 0 } })).toThrow()
    expect(() => parse({ ui: { theme: 'neon' } })).toThrow()
  })

  it('preserves an unknown key for forward compatibility', () => {
    // A newer renderer patching a key this build does not know must not have it
    // rejected — the same rollback scenario `settingsSchema` is `.loose()` for.
    expect(parse({ futureSetting: 'x' })).toEqual({ futureSetting: 'x' })
  })

  it('accepts an explicit null where the schema allows one', () => {
    // `null` is meaningful — `engine.backend: null` means auto-detect. Stripping
    // nullability while stripping defaults would make that unexpressible.
    expect(parse({ engine: { backend: null } })).toEqual({ engine: { backend: null } })
  })

  it('does not accept hasKey from the renderer', () => {
    // `hasKey` is a read-only mirror of secret presence, recomputed by
    // `settings:get`. If a patch could set it, the renderer could claim a key
    // exists and the UI would offer to use one that is not there.
    expect(parse({ llm: { hasKey: true } })).toEqual({ llm: {} })
  })
})
