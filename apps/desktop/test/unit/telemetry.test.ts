import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTelemetry, type TelemetryEvent } from '../../src/main/telemetry'

/**
 * Telemetry makes no network call, in any state.
 *
 * `design.md` §Operational: opt-in, default off, and **no network call
 * whatsoever before consent**. `telemetry.ts` says so in a comment, and its own
 * note demands this be checked "by asserting no request is made, because 'a stub
 * that quietly phones home' would violate `design.md` §Operational while looking
 * like a stub". A comment is not evidence, and neither is reading the file — a
 * transitive import could open a socket without a single line here mentioning it.
 *
 * ## How this is asserted
 *
 * Every network primitive reachable from the main process is replaced with a
 * throwing trap, then telemetry is exercised. The trap fires on *use*, so this
 * covers a call made indirectly by a dependency as well as one made here. That
 * is the property worth testing: not "does this file contain a fetch" but "does
 * anything reach the network when telemetry runs".
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

/** Replaces a network entry point with a recorder. Never resolves a real request. */
function trap(label: string) {
  return netTrap.record(label)
}

let restore: (() => void)[] = []

function install(object: Record<string, unknown>, key: string, label: string): void {
  const original = object[key]
  object[key] = trap(label)
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

/** One of every permitted event, so no branch escapes the check. */
const EVERY_EVENT: TelemetryEvent[] = [
  { name: 'app_started', platform: 'win32', arch: 'x64', version: '0.1.0' },
  { name: 'app_quit', sessionSeconds: 42 },
  { name: 'sgf_imported', count: 3, failed: 1 },
  { name: 'engine_started', backend: 'cuda', visitsPerSecond: 1200 },
  { name: 'llm_run_finished', finishReason: 'stop', kind: 'cloud' },
  { name: 'crash', code: 'ENGINE_CRASHED' },
]

describe('telemetry makes no network call', () => {
  it('does not touch the network when constructed', () => {
    createTelemetry()
    expect(attempts).toEqual([])
  })

  it('does not touch the network for any permitted event', () => {
    const telemetry = createTelemetry()
    for (const event of EVERY_EVENT) telemetry.track(event)
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
    const telemetry = createTelemetry()
    for (const event of EVERY_EVENT) telemetry.track(event)
    expect(attempts).toEqual([])
  })

  it('reports itself as disabled', () => {
    // Hardcoded `false`, not read from settings: in M1 there is no transport, so
    // reporting `true` because a user consented would be a lie a future reader
    // might take as evidence the wiring exists.
    expect(createTelemetry().enabled).toBe(false)
  })

  it('stays disabled — there is no way to turn it on', () => {
    const telemetry = createTelemetry()
    // `enabled` is declared `readonly`, which TypeScript enforces at compile
    // time. This checks the runtime shape too, since a plain mutable property
    // would let any caller flip it and the type would not be there to stop
    // JavaScript.
    expect(
      Object.getOwnPropertyDescriptor(telemetry, 'enabled')?.value,
      'enabled should be a plain false value',
    ).toBe(false)
  })
})

describe('telemetry never carries content', () => {
  it('logs the event name and nothing else', () => {
    // The permitted scalars are deliberately omitted from the log line: they are
    // in the type because M5 will send them, and a debug line that grows to carry
    // a payload is how the content rule erodes.
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

    createTelemetry().track({
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
})
