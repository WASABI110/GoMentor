import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../src/types/settings'
import { AppError, errorEnvelopeSchema, isAppError } from '../src/types/errors'

describe('settings forward-compatibility', () => {
  /**
   * A user who runs a newer build and then rolls back must not lose the newer
   * build's settings. `.passthrough()` on the root schema is what guarantees
   * this, and it is easy to remove by accident — hence a test rather than a
   * comment.
   */
  it('preserves unknown keys through a parse cycle', () => {
    const fromNewerBuild = {
      version: 1,
      futureFeature: { enabled: true, threshold: 42 },
      anotherNewKey: 'keep me',
    }

    const parsed = settingsSchema.parse(fromNewerBuild)

    expect(parsed).toMatchObject({
      futureFeature: { enabled: true, threshold: 42 },
      anotherNewKey: 'keep me',
    })
  })

  it('survives a full load-save-load round trip with unknown keys', () => {
    const original = { version: 1, unknownBlock: { a: [1, 2, 3] } }

    const first = settingsSchema.parse(original)
    const serialized = JSON.stringify(first)
    const second = settingsSchema.parse(JSON.parse(serialized))

    expect(second['unknownBlock']).toEqual({ a: [1, 2, 3] })
  })

  it('applies defaults for absent sections', () => {
    const parsed = settingsSchema.parse({})

    expect(parsed.ui.locale).toBe('zh-CN')
    expect(parsed.llm.kind).toBe('cloud')
    expect(parsed.engine.backend).toBeNull()
    // Both must default to off: telemetry is opt-in, and content telemetry is
    // permanently off the table.
    expect(parsed.telemetryConsent).toBe(false)
    expect(parsed.debugLogging).toBe(false)
  })

  it('rejects a structurally invalid known section', () => {
    // Passthrough must not make known fields permissive.
    expect(settingsSchema.safeParse({ ui: { locale: 'klingon' } }).success).toBe(false)
    expect(settingsSchema.safeParse({ llm: { baseUrl: 'not-a-url' } }).success).toBe(
      false,
    )
  })

  it('never carries a plaintext key field in the schema', () => {
    const parsed = settingsSchema.parse({})
    // Only the boolean mirror belongs here. The key itself lives in an
    // encrypted blob and never reaches the renderer.
    expect(parsed.llm.hasKey).toBe(false)
    expect('apiKey' in parsed.llm).toBe(false)
  })
})

describe('AppError', () => {
  it('carries a code that callers can branch on', () => {
    const err = new AppError('SGF_TRUNCATED', 'unexpected end of input')

    expect(isAppError(err)).toBe(true)
    expect(err.code).toBe('SGF_TRUNCATED')
    expect(err).toBeInstanceOf(Error)
  })

  it('strips cause and stack when converted for the wire', () => {
    const err = new AppError('LLM_TIMEOUT', 'no first token in 60s', {
      cause: new Error('socket hang up at /home/someone/secret/path'),
      context: { timeoutMs: 60_000 },
    })

    const envelope = err.toEnvelope()

    // Stacks and causes can carry filesystem paths and argument values, so
    // they stay in main. Only the code crosses to the renderer.
    expect(envelope).toEqual({
      code: 'LLM_TIMEOUT',
      message: 'no first token in 60s',
      context: { timeoutMs: 60_000 },
    })
    expect('cause' in envelope).toBe(false)
    expect('stack' in envelope).toBe(false)
    expect(errorEnvelopeSchema.safeParse(envelope).success).toBe(true)
  })

  it('omits context entirely when none was given', () => {
    const envelope = new AppError('LIBRARY_NOT_FOUND', 'no such game').toEnvelope()

    expect(envelope).toEqual({ code: 'LIBRARY_NOT_FOUND', message: 'no such game' })
    expect('context' in envelope).toBe(false)
  })

  it('rejects an unrecognised error code at the boundary', () => {
    expect(
      errorEnvelopeSchema.safeParse({ code: 'INVENTED', message: 'x' }).success,
    ).toBe(false)
  })

  it('distinguishes non-AppError throwables', () => {
    expect(isAppError(new Error('plain'))).toBe(false)
    expect(isAppError('a string')).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})
