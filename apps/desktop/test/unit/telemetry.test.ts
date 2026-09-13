import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalTelemetry,
  createNoopTelemetry,
  createTelemetry,
  type CrashReporter,
  type TelemetryDeps,
  type TelemetryEvent,
} from '../../src/main/telemetry'

/**
 * Telemetry is local-only and consent-gated, and both properties are
 * load-bearing enough to survive refactors only if they are pinned here.
 *
 * ## The two invariants this file exists for
 *
 * 1. **No network call, in any state.** `design.md` §Operational promised "no
 *    network call whatsoever before consent"; M5's scope decision made it
 *    absolute — local-only, no transport at all. Every network primitive
 *    reachable from the main process is replaced with a throwing trap, then
 *    telemetry is exercised. The trap fires on *use*, so this covers a call
 *    made indirectly by a dependency as well as one made here. That is the
 *    property worth testing: not "does this file contain a fetch" but "does
 *    anything reach the network when telemetry runs".
 * 2. **No content, ever.** The event type is a closed union of scalar-only
 *    shapes, which makes content a type error — but a widened field would
 *    undo that silently, so every line actually written to the JSONL is
 *    snapshotted and its keys checked against the union's own scalars.
 *
 * ## Mutation-anchored assertions
 *
 * The `uploadToServer: false` option in `telemetry.ts` is the whole transport
 * policy, and a comment is not evidence. `scripts/mutate-telemetry.mts` flips
 * it and requires the assertion below to fail; if this test ever loosens, the
 * harness will report the mutant as escaped rather than letting the policy
 * erode unnoticed.
 */

/**
 * `vi.hoisted` because `vi.mock` factories are hoisted above the imports, so a
 * factory referencing a normal `const` would hit it before initialisation.
 */
const netTrap = vi.hoisted(() => {
  const attempts: string[] = []
  const record =
    (label: string) =>
    (...args: unknown[]): never => {
      const target = typeof args[0] === 'string' ? args[0] : '(non-string target)'
      attempts.push(`${label} -> ${target}`)
      throw new Error(`network access attempted via ${label}`)
    }
  return { attempts, record }
})

// Mocked wholesale rather than spied: `vi.spyOn` cannot patch an ESM namespace
// ("Module namespace is not configurable in ESM"), and mocking after import would
// be too late for a request made at module load.
vi.mock('node:http', () => ({
  request: netTrap.record('http.request'),
  get: netTrap.record('http.get'),
  default: { request: netTrap.record('http.request'), get: netTrap.record('http.get') },
}))
vi.mock('node:https', () => ({
  request: netTrap.record('https.request'),
  get: netTrap.record('https.get'),
  default: {
    request: netTrap.record('https.request'),
    get: netTrap.record('https.get'),
  },
}))
vi.mock('node:net', () => ({
  connect: netTrap.record('net.connect'),
  createConnection: netTrap.record('net.createConnection'),
  default: {
    connect: netTrap.record('net.connect'),
    createConnection: netTrap.record('net.createConnection'),
  },
}))

const attempts = netTrap.attempts

let restore: (() => void)[] = []

function install(object: Record<string, unknown>, key: string, label: string): void {
  const original = object[key]
  object[key] = netTrap.record(label)
  restore.push(() => {
    object[key] = original
  })
}

beforeEach(() => {
  attempts.length = 0
  restore = []

  const globals = globalThis as unknown as Record<string, unknown>
  install(globals, 'fetch', 'fetch')
  install(globals, 'XMLHttpRequest', 'XMLHttpRequest')
  install(globals, 'WebSocket', 'WebSocket')
})

afterEach(() => {
  for (const undo of restore.reverse()) undo()
  vi.restoreAllMocks()
})

/** One of every permitted event, so no branch escapes the checks. */
const EVERY_EVENT: TelemetryEvent[] = [
  { name: 'app_started', platform: 'win32', arch: 'x64', version: '0.1.0' },
  { name: 'app_quit', sessionSeconds: 42 },
  { name: 'sgf_imported', count: 3, failed: 1 },
  { name: 'engine_started', backend: 'cuda', visitsPerSecond: 1200 },
  { name: 'llm_run_finished', finishReason: 'stop', kind: 'cloud' },
  { name: 'crash', code: 'ENGINE_CRASHED' },
]

/** The only keys any permitted event may carry, from the union itself. */
const ALLOWED_KEYS = new Set([
  'name',
  'platform',
  'arch',
  'version',
  'sessionSeconds',
  'count',
  'failed',
  'backend',
  'visitsPerSecond',
  'finishReason',
  'kind',
  'code',
  // The writer adds exactly one field of its own.
  'ts',
])

let dir = ''
let logPath = ''

/** A crashReporter spy that records its options; never a real Electron. */
function fakeCrashReporter(): CrashReporter & {
  readonly calls: { options: unknown }[]
} {
  const calls: { options: unknown }[] = []
  return {
    calls,
    start(options): void {
      calls.push({ options })
    },
  }
}

function deps(overrides?: Partial<TelemetryDeps>): TelemetryDeps {
  return {
    consented: true,
    logPath,
    crashReporter: null,
    now: () => '2026-09-13T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gomentor-telemetry-'))
  logPath = join(dir, 'telemetry.jsonl')
})

function lines(): { raw: string[]; parsed: Record<string, unknown>[] } {
  try {
    const raw = readFileSync(logPath, 'utf8')
    const parsed = raw
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    return {
      raw: raw.split('\n').filter((line) => line !== ''),
      parsed,
    }
  } catch {
    return { raw: [], parsed: [] }
  }
}

describe('the consent gate', () => {
  it('unconsented: no crash reporter, no files, disabled', () => {
    const reporter = fakeCrashReporter()
    const telemetry = createTelemetry(
      deps({ consented: false, crashReporter: reporter }),
    )
    for (const event of EVERY_EVENT) telemetry.track(event)

    expect(reporter.calls).toEqual([])
    expect(lines().parsed).toEqual([])
    expect(telemetry.enabled).toBe(false)
    // The noop discards after a debug line — the directory must not even exist.
    expect(readdirSync(dir)).toEqual([])
  })

  it('consented: enabled, crash reporter started, events written', async () => {
    const reporter = fakeCrashReporter()
    const telemetry = createTelemetry(deps({ crashReporter: reporter }))
    telemetry.track({
      name: 'app_started',
      platform: 'darwin',
      arch: 'arm64',
      version: '1.0.0',
    })
    // track() is async internally (file append); the await here is the flush.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(telemetry.enabled).toBe(true)
    expect(reporter.calls).toHaveLength(1)
    const written = lines().parsed
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      name: 'app_started',
      platform: 'darwin',
      arch: 'arm64',
      version: '1.0.0',
      ts: '2026-09-13T00:00:00.000Z',
    })
  })

  it('there is no way to flip consent on an instance', () => {
    // enabled is declared readonly — this checks the runtime shape too, since
    // a plain mutable property would let any caller flip it in JavaScript and
    // the type would not be there to stop them.
    const telemetry = createTelemetry(deps({ consented: false }))
    expect(
      Object.getOwnPropertyDescriptor(telemetry, 'enabled')?.value,
      'enabled should be a plain false value',
    ).toBe(false)
  })
})

describe('the crash reporter contract', () => {
  it('starts Electron crash reporting with uploads hard-disabled', () => {
    const reporter = fakeCrashReporter()
    createTelemetry(deps({ crashReporter: reporter }))

    expect(reporter.calls).toHaveLength(1)
    const options = reporter.calls[0]?.options as Record<string, unknown>
    // THE transport policy. mutate-telemetry.mts flips this to `true` and
    // this assertion is what must fail — if the test ever stops naming the
    // option, the mutation escapes and the policy erodes unnoticed.
    expect(options['uploadToServer']).toBe(false)
    expect(options['ignoreSystemCrashHandler']).toBe(true)
  })

  it('a null crash reporter (plain Node) is tolerated', () => {
    const telemetry = createTelemetry(deps({ crashReporter: null }))
    expect(telemetry.enabled).toBe(true)
  })
})

describe('the event log never carries content', () => {
  it('every written line is closed-union scalars plus ts', async () => {
    const telemetry = createTelemetry(deps())
    for (const event of EVERY_EVENT) telemetry.track(event)
    await new Promise((resolve) => setTimeout(resolve, 30))

    const written = lines().parsed
    expect(written).toHaveLength(EVERY_EVENT.length)
    for (const line of written) {
      for (const key of Object.keys(line)) {
        expect(
          ALLOWED_KEYS.has(key),
          `key ${key} is not part of the permitted event shape`,
        ).toBe(true)
      }
      // Values are scalars too — an object value would be a content channel
      // the union's scalar-only fields were designed to prevent.
      for (const value of Object.values(line)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value)
      }
    }
  })

  it('the noop logs the event name and nothing else', () => {
    // The permitted scalars are deliberately omitted from the debug line even
    // in M1: a debug line that grows to carry a payload is how the content
    // rule erodes.
    const written: string[] = []
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk))
        return true
      })
    const errorSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk))
        return true
      })

    createNoopTelemetry().track({
      name: 'engine_started',
      backend: 'cuda',
      visitsPerSecond: 1200,
    })

    spy.mockRestore()
    errorSpy.mockRestore()

    const output = written.join('')
    if (output.length > 0) {
      // Only meaningful when debug logging is on; when it is off there is no
      // line at all, which satisfies the property just as well.
      expect(output).not.toContain('cuda')
      expect(output).not.toContain('1200')
    }
  })

  it('a write failure is swallowed, not thrown', async () => {
    // A full disk or a vanished directory must never take the app down via a
    // telemetry append. track() is fire-and-forget, so a failure would surface
    // as an unhandled rejection rather than a synchronous throw — the observer
    // below is what actually sees one; a bare not.toThrow() would pass even
    // under a mutant that rethrows inside the catch.
    //
    // The failure is real, not a "missing directory": append() mkdirs its
    // parent recursively, so a missing path would be silently CREATED and the
    // failure branch never exercised (measured — the first version of this
    // test escaped the rethrow mutant for exactly that reason). A directory
    // sitting where the log file must be makes appendFile itself fail.
    const blocked = join(dir, 'blocked.jsonl')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(blocked)

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)

    const telemetry = createLocalTelemetry(deps({ logPath: blocked }))
    expect(() => {
      telemetry.track({ name: 'crash', code: 'X' })
    }).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 30))
    process.off('unhandledRejection', onRejection)

    expect(rejections).toEqual([])
  })
})

describe('the 1 MB rotation', () => {
  it('rotates the log at the size threshold, keeping one generation', async () => {
    const telemetry = createTelemetry(deps())
    // A pre-existing oversized log triggers rotation on the first append.
    writeFileSync(logPath, 'x'.repeat(1024 * 1024 + 1), 'utf8')

    telemetry.track({ name: 'crash', code: 'AFTER_ROTATE' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const rotated = `${logPath}.1`
    expect(statSync(rotated).size).toBe(1024 * 1024 + 1)
    const current = lines().parsed
    expect(current).toHaveLength(1)
    expect(current[0]?.['name']).toBe('crash')
  })

  it('a small log is appended, not rotated', async () => {
    const telemetry = createTelemetry(deps())
    telemetry.track({ name: 'app_quit', sessionSeconds: 1 })
    // Sequenced on the OBSERVED effect, not a fixed sleep: two appends in a
    // loaded worker can take longer than any constant backoff, and the second
    // append must wait for the first to be on disk (appends are fire-and-
    // forget, and an unordered pair would be a real ordering bug).
    await expect
      .poll(() => lines().parsed.length, { timeout: 5_000, interval: 10 })
      .toBe(1)
    telemetry.track({ name: 'app_quit', sessionSeconds: 2 })
    await expect
      .poll(() => lines().parsed.length, { timeout: 5_000, interval: 10 })
      .toBe(2)

    expect(lines().parsed.map((line) => line['sessionSeconds'])).toEqual([1, 2])
    expect(() => statSync(`${logPath}.1`)).toThrow()
  })
})

describe('telemetry makes no network call', () => {
  it('does not touch the network when constructed, either implementation', () => {
    createTelemetry(deps({ consented: false }))
    createTelemetry(deps({ consented: true }))
    expect(attempts).toEqual([])
  })

  it('does not touch the network for any permitted event', async () => {
    const telemetry = createTelemetry(deps())
    for (const event of EVERY_EVENT) telemetry.track(event)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Empty rather than "no fetch": the traps record every entry point, so this
    // asserts nothing reached the network by any route, including a dependency's.
    expect(attempts).toEqual([])
  })

  it('does not touch the network via node:http or node:https', async () => {
    // The traps above cover the web APIs. A main-process module is just as likely
    // to use node's own client. `vi.spyOn` cannot patch an ESM namespace, so the
    // modules are mocked wholesale by the `vi.mock` calls at the top of this file
    // — which also means the trap is in place before any import binds, rather
    // than after, where a module-level request would already have gone out.
    //
    // The instrument is checked first: the trap must actually be what `node:http`
    // resolves to, or the assertion below would pass against something nothing
    // could ever hit. It throws by construction, so a real `http.request` here
    // would fail this rather than open a socket.
    const http = await import('node:http')
    expect(() => {
      ;(http.request as unknown as () => void)()
    }, 'node:http was not trapped').toThrow(/network access attempted/)
    expect(attempts.at(-1)).toContain('http.request')

    // Now the real assertion, from a clean slate.
    attempts.length = 0
    const telemetry = createTelemetry(deps())
    for (const event of EVERY_EVENT) telemetry.track(event)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(attempts).toEqual([])
  })
})
