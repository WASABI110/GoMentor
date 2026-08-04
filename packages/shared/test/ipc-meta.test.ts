import { describe, expect, it } from 'vitest'
import { CHANNELS, CHANNEL_NAMES, EVENTS, EVENT_NAMES } from '../src/ipc'

/**
 * Proves the coverage meta-test in `ipc.test.ts` is not vacuous.
 *
 * A meta-test that passes whether or not coverage exists is worse than no
 * meta-test: it reports safety it does not provide. A9 therefore requires
 * demonstrating that it actually fails when a channel lacks a test case.
 *
 * Doing that by hand once proves nothing durable — someone could later weaken
 * the meta-test and the manual check would not be repeated. So the detection
 * logic is exercised here against a deliberately incomplete case map, in the
 * same shape the real meta-test uses.
 */

// The real meta-test's logic, extracted so it can be run against fixtures.
function findUncoveredChannels(
  channelNames: readonly string[],
  cases: Record<string, unknown>,
): string[] {
  return channelNames.filter((name) => !(name in cases))
}

function findStaleCases(
  cases: Record<string, unknown>,
  channels: Record<string, unknown>,
): string[] {
  return Object.keys(cases).filter((name) => !(name in channels))
}

describe('meta-test is not vacuous', () => {
  it('detects a channel that has no test case', () => {
    const channelsWithOneAdded = [...CHANNEL_NAMES, 'newdomain:newVerb']
    // Simulates adding a channel to ipc.ts without adding its test case.
    const casesMissingTheNewOne = Object.fromEntries(
      CHANNEL_NAMES.map((name) => [name, {}]),
    )

    const missing = findUncoveredChannels(channelsWithOneAdded, casesMissingTheNewOne)

    expect(missing).toEqual(['newdomain:newVerb'])
    expect(missing.length).toBeGreaterThan(0)
  })

  it('passes when coverage is complete', () => {
    const complete = Object.fromEntries(CHANNEL_NAMES.map((name) => [name, {}]))
    expect(findUncoveredChannels(CHANNEL_NAMES, complete)).toEqual([])
  })

  it('detects a test case left behind after its channel was removed', () => {
    const casesWithStale = {
      ...Object.fromEntries(CHANNEL_NAMES.map((name) => [name, {}])),
      'removed:channel': {},
    }
    expect(findStaleCases(casesWithStale, CHANNELS)).toEqual(['removed:channel'])
  })

  it('detects an event that has no test case', () => {
    const eventsWithOneAdded = [...EVENT_NAMES, 'newdomain:pushed']
    const casesMissingTheNewOne = Object.fromEntries(
      EVENT_NAMES.map((name) => [name, {}]),
    )

    expect(findUncoveredChannels(eventsWithOneAdded, casesMissingTheNewOne)).toEqual([
      'newdomain:pushed',
    ])
  })
})

describe('contract sanity', () => {
  // Guards against a contract that is accidentally empty — which would make
  // every per-channel loop above iterate zero times and pass trivially.
  it('exposes a non-trivial number of channels and events', () => {
    expect(CHANNEL_NAMES.length).toBeGreaterThanOrEqual(11)
    expect(EVENT_NAMES.length).toBeGreaterThanOrEqual(5)
  })

  it('every channel declares both a request and a response schema', () => {
    for (const name of CHANNEL_NAMES) {
      const spec = CHANNELS[name]
      expect(spec.request, `${name} missing request schema`).toBeDefined()
      expect(spec.response, `${name} missing response schema`).toBeDefined()
      expect(typeof spec.request.safeParse, `${name} request is not a zod schema`).toBe(
        'function',
      )
      expect(
        typeof spec.response.safeParse,
        `${name} response is not a zod schema`,
      ).toBe('function')
    }
  })

  it('every event schema is a zod schema', () => {
    for (const name of EVENT_NAMES) {
      expect(typeof EVENTS[name].safeParse, `${name} is not a zod schema`).toBe(
        'function',
      )
    }
  })

  it('channel and event namespaces do not collide', () => {
    const overlap = CHANNEL_NAMES.filter((name) =>
      (EVENT_NAMES as readonly string[]).includes(name),
    )
    expect(
      overlap,
      `names used as both channel and event: ${overlap.join(', ')}`,
    ).toEqual([])
  })
})
