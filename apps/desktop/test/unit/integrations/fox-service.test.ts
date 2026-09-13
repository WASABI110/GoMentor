/*
 * The fixture transports are deliberately synchronous functions typed as
 * async (the contract the protocol layer consumes). require-await would
 * force a meaningless `await Promise.resolve()` into every one of them.
 */
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'
import {
  FoxServiceError,
  createFoxService,
} from '../../../src/main/integrations/fox/service'

/**
 * The Fox service: the rate limiter's spacing math and the error mapping from
 * protocol failures to the integration codes the renderer translates. The
 * limiter's clock and wait are injected, so these tests assert the COMPUTED
 * delays instead of sleeping through them — a real 2-second wait per case
 * would be the suite slowing down to prove nothing.
 */

const USER_OK = JSON.stringify([{ uid: 42, nickname: 'n' }])

describe('the rate limiter', () => {
  it('paces a second request 2s after the first', async () => {
    let now = 1_000
    const waits: number[] = []
    const service = createFoxService({
      fetch: async () => ({ ok: true, status: 200, text: async () => USER_OK }),
      now: () => now,
      wait: async (ms) => {
        waits.push(ms)
        now += ms
      },
    })

    await service.lookupUser('a')
    await service.lookupUser('b')
    // The second request arrived 0ms after the first → waited the full interval.
    expect(waits).toEqual([2000])
  })

  it('does not wait when the interval has already elapsed', async () => {
    let now = 1_000
    const waits: number[] = []
    const service = createFoxService({
      fetch: async () => ({ ok: true, status: 200, text: async () => USER_OK }),
      now: () => now,
      wait: async (ms) => {
        waits.push(ms)
        now += ms
      },
    })

    await service.lookupUser('a')
    now += 5_000 // five seconds pass before the user acts again
    await service.lookupUser('b')
    expect(waits).toEqual([])
  })

  it('paces by the last request, not the last completion', async () => {
    let now = 1_000
    const waits: number[] = []
    const service = createFoxService({
      fetch: async () => ({ ok: true, status: 200, text: async () => USER_OK }),
      now: () => now,
      wait: async (ms) => {
        waits.push(ms)
        now += ms
      },
    })

    await service.lookupUser('a')
    now += 1_000 // half the interval elapsed
    await service.lookupUser('b')
    // Only the REMAINING 1s is waited, not the full interval again.
    expect(waits).toEqual([1000])
  })
})

describe('error mapping', () => {
  it('maps protocol failures onto the integration codes', async () => {
    const service = createFoxService({
      fetch: async () => ({ ok: true, status: 200, text: async () => '[]' }),
      now: () => 0,
      wait: async () => undefined,
    })
    const error = await service.lookupUser('nobody').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FoxServiceError)
    expect((error as FoxServiceError).code).toBe('FOX_USER_NOT_FOUND')
  })

  it('a network-level rejection is SOURCE_UNREACHABLE', async () => {
    const service = createFoxService({
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      now: () => 0,
      wait: async () => undefined,
    })
    const error = await service.lookupUser('x').catch((e: unknown) => e)
    expect((error as FoxServiceError).code).toBe('SOURCE_UNREACHABLE')
  })
})
