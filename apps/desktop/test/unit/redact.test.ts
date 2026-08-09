import { describe, expect, it } from 'vitest'
import { AppError } from '@gomentor/shared'
import { REDACTION_PLACEHOLDER, redact } from '../../src/main/redact'

/**
 * A10, redaction half: `quality-guidelines.md` requires this to be "tested with
 * a key-shaped value, not assumed from the code".
 *
 * ## What every assertion here is really checking
 *
 * That the **original bytes are absent from the output**, not that the output
 * looks redacted. Those differ: a serializer that produced `sk-live-…` would
 * satisfy "looks redacted" while still leaking a usable prefix, which
 * `logging-guidelines.md` forbids by name ("Not even redacted-looking
 * prefixes"). So the assertions are `not.toContain` against the secret, applied
 * to the serialised output as a whole rather than to the field that was expected
 * to hold it — a leak that lands in a *different* field is still a leak.
 */

/** Real-shaped values. A `'secret'` placeholder would not exercise the patterns. */
const OPENAI_KEY = 'sk-live-4eC39HqLyjWDarjtT1zdp7dcQ8xKmN2v'
const GITHUB_TOKEN = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const SLACK_TOKEN = 'xoxb-123456789012-abcdefghijklmnop'
const GOOGLE_KEY = 'AIzaSyDaGmWKa4JsXZHjjjjjjjjjjjjjjjjjjjjjj'

/** Serialises so a leak anywhere in the structure is visible to one assertion. */
function dump(value: unknown): string {
  return JSON.stringify(redact(value))
}

describe('redaction by field name', () => {
  it('redacts an api key however the field is cased or punctuated', () => {
    // One list, several spellings. A call site writes whichever reads best, and
    // matching on equality rather than substring is how a rule like this ends up
    // covering `apiKey` but not `api_key`.
    //
    // The value deliberately does *not* look like a vendor key. With `sk-…` here
    // the value-shape patterns redact it no matter what the field is called, so
    // the test would still pass with field-name matching entirely removed —
    // verified by mutation, which is how this was caught.
    const opaque = 'zzzz-not-a-recognisable-prefix-1234'
    for (const field of ['apiKey', 'api_key', 'APIKEY', 'llmApiKey', 'openaiApiKey']) {
      const output = dump({ [field]: opaque })
      expect(output, field).not.toContain(opaque)
      expect(output, field).toContain(REDACTION_PLACEHOLDER)
    }
  })

  it('redacts the other credential-shaped field names', () => {
    for (const field of [
      'secret',
      'token',
      'password',
      'authorization',
      'credential',
      'cookie',
    ]) {
      const output = dump({ [field]: 'some-sensitive-value-here' })
      expect(output, field).not.toContain('some-sensitive-value-here')
    }
  })

  it('redacts by name even when the value is not string-shaped', () => {
    // Preserving the type would leak the value's shape — that a token was a
    // 40-element array, say. The replacement is unconditional.
    const output = dump({ apiKey: { nested: OPENAI_KEY }, token: [1, 2, 3] })
    expect(output).not.toContain(OPENAI_KEY)
    expect(output).not.toContain('[1,2,3]')
  })

  it("redacts the user's private material, not just credentials", () => {
    // A different reason from the credential list: this is study material and
    // conversation, which `logging-guidelines.md` puts permanently off-limits.
    const sgf = '(;GM[1]FF[4]SZ[19];B[pd];W[dp]C[a private note])'
    const output = dump({
      sgfContent: sgf,
      prompt: 'analyse this',
      completion: 'move 47 was bad',
    })
    expect(output).not.toContain('B[pd]')
    expect(output).not.toContain('analyse this')
    expect(output).not.toContain('move 47 was bad')
  })
})

describe('redaction by value shape', () => {
  it('redacts a key pasted into free text under an innocent field name', () => {
    // The case field names cannot catch, and the one that actually happens: a
    // key inside a message, under a field nobody thought to list.
    const output = dump({ detail: `request failed for key ${OPENAI_KEY}` })
    expect(output).not.toContain(OPENAI_KEY)
    // Surrounding prose survives — the diagnostic is the point of logging it.
    expect(output).toContain('request failed for key')
  })

  it('redacts vendor-prefixed credentials from several providers', () => {
    for (const value of [OPENAI_KEY, GITHUB_TOKEN, AWS_KEY, SLACK_TOKEN, GOOGLE_KEY]) {
      const output = dump({ detail: `saw ${value} in the config` })
      expect(output, value.slice(0, 6)).not.toContain(value)
    }
  })

  it('redacts a bearer header value', () => {
    const output = dump({ detail: `Authorization: Bearer ${OPENAI_KEY}` })
    expect(output).not.toContain(OPENAI_KEY)
  })

  it('leaves no prefix of the secret behind', () => {
    // `logging-guidelines.md`: not even a redacted-looking prefix. A `sk-abc…`
    // preview would pass a `not.toContain(fullKey)` check, so the prefix is
    // asserted separately.
    const output = dump({ detail: OPENAI_KEY })
    expect(output).not.toContain('sk-live')
    expect(output).not.toContain(OPENAI_KEY.slice(0, 12))
  })

  it('redacts every occurrence, not just the first', () => {
    // A `/g` regex is module-level state; `lastIndex` surviving between calls
    // would make this intermittent and order-dependent.
    const output = dump({ detail: `${OPENAI_KEY} and again ${OPENAI_KEY}` })
    expect(output).not.toContain(OPENAI_KEY)
    expect(output.match(/\[redacted\]/g)?.length).toBe(2)
  })

  it('stays clean across repeated calls', () => {
    // The same concern as above, exercised the way it would actually break: the
    // second call reusing a regex whose lastIndex was left mid-string.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        dump({ detail: `key is ${OPENAI_KEY}` }),
        `attempt ${String(attempt)}`,
      ).not.toContain(OPENAI_KEY)
    }
  })
})

describe('redaction of urls', () => {
  it('keeps the host and drops userinfo and query', () => {
    // `logging-guidelines.md`: log the host, never userinfo or query params —
    // both are places a key arrives.
    const output = dump({
      baseUrl: `https://user:hunter2@api.example.com/v1?api_key=${OPENAI_KEY}`,
    })
    expect(output).toContain('api.example.com')
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain(OPENAI_KEY)
    expect(output).not.toContain('/v1')
  })

  it('does not pass an unparseable url through unchanged', () => {
    // An unparseable value in a URL field is exactly where a malformed
    // credential would hide, so falling back to the raw string would defeat the
    // point of handling URLs specially.
    const output = dump({ baseUrl: `not-a-url-but-here-is-${OPENAI_KEY}` })
    expect(output).not.toContain(OPENAI_KEY)
  })
})

describe('redaction of long values', () => {
  it('replaces a long string with its length', () => {
    // The length is the only diagnostically useful part, and it is the same
    // reasoning as `sgf/diagnostic.ts`. An SGF arriving under an unlisted field
    // is the case this covers.
    const long = 'x'.repeat(5000)
    const output = dump({ payload: long })
    expect(output).not.toContain('xxxxxxxxxx')
    expect(output).toContain('5000 characters')
  })

  it('keeps a short value verbatim so the log stays useful', () => {
    // A counterweight: a redactor that replaced everything would satisfy every
    // leak assertion above while making the log worthless.
    expect(dump({ backend: 'cuda', visitsPerSecond: 1200 })).toBe(
      '{"backend":"cuda","visitsPerSecond":1200}',
    )
  })
})

describe('redaction of errors', () => {
  it('serialises an Error rather than rendering it as {}', () => {
    // `JSON.stringify(new Error('x'))` is `{}` — an Error has no enumerable own
    // properties, so a naive walk drops the only useful part.
    const output = dump({ err: new Error('something broke') })
    expect(output).toContain('something broke')
    expect(output).toContain('Error')
  })

  it("keeps an AppError's code and follows its cause", () => {
    // `cause` is followed on purpose: this runs in main, where
    // `logging-guidelines.md` line 54 requires it. What must never carry a cause
    // is the envelope crossing to the renderer, which is
    // `AppError.toEnvelope()`'s job, not this function's.
    const error = new AppError('LLM_TIMEOUT', 'provider timed out', {
      cause: new Error('socket hang up'),
      context: { host: 'api.example.com' },
    })
    const output = dump({ err: error })
    expect(output).toContain('LLM_TIMEOUT')
    expect(output).toContain('socket hang up')
    expect(output).toContain('api.example.com')
  })

  it('scrubs a secret out of an error message and its cause', () => {
    // The leak path with no log call near it: a message built from raw input
    // becomes another error's cause, and cause is logged in main.
    const error = new AppError('LLM_UNAUTHORIZED', `rejected key ${OPENAI_KEY}`, {
      cause: new Error(`upstream said: Bearer ${GITHUB_TOKEN}`),
    })
    const output = dump({ err: error })
    expect(output).not.toContain(OPENAI_KEY)
    expect(output).not.toContain(GITHUB_TOKEN)
  })
})

describe('redaction robustness', () => {
  it('survives a cycle', () => {
    // Log serialisation must not be able to throw: the crash would happen while
    // trying to report a problem.
    const node: Record<string, unknown> = { name: 'a' }
    node['self'] = node
    expect(dump(node)).toContain('circular')
  })

  it('stops at a depth limit rather than blowing the stack', () => {
    let deep: Record<string, unknown> = { end: true }
    for (let level = 0; level < 200; level += 1) deep = { nested: deep }
    expect(() => dump(deep)).not.toThrow()
    expect(dump(deep)).toContain('depth limit')
  })

  it('handles values that are not JSON at all', () => {
    expect(() =>
      dump({
        fn: () => 1,
        sym: Symbol('x'),
        big: 10n,
        when: new Date(0),
        set: new Set([1]),
      }),
    ).not.toThrow()
  })
})
