import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGpuService,
  type GpuProgress,
  type GpuServiceDeps,
} from '../../src/main/katago/gpu'

/**
 * The GPU download service's own logic, over a scripted pipeline: the
 * one-at-a-time slot, the state sequence, the throttled progress, and the two
 * refusals. The fetch pipeline underneath is injectable (`deps.ensure`) —
 * that is the seam the production binding fills with the real
 * `@gomentor/engines` pipeline, which is proven live by the CLI run and the
 * scripts suite, not by faking a network here.
 */

let dir = ''
let sidecar = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gomentor-gpu-'))
  sidecar = join(dir, 'engines-checksums.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  service: ReturnType<typeof createGpuService>
  events: GpuProgress[]
  ensured: ('cuda' | 'opencl')[]
  failNext: (error: Error) => void
  settle: () => Promise<void>
}

function build(
  overrides: Partial<Pick<GpuServiceDeps, 'target' | 'preference'>> = {},
): Harness {
  const events: GpuProgress[] = []
  const ensured: ('cuda' | 'opencl')[] = []
  let failure: Error | null = null
  // Each download holds its own settled-promise so `settle()` waits for the
  // exact pipeline this harness ran, however many ran.
  let pending: Promise<void> = Promise.resolve()

  const deps: GpuServiceDeps = {
    preference: () => null,
    target: 'win32-x64',
    checksumsPath: sidecar,
    dirFor: (backend) => join(dir, backend),
    emitProgress: (progress) => {
      events.push(progress)
    },
    ensure: (backend) => {
      ensured.push(backend)
      const run = pending.then(() => {
        if (failure !== null) throw failure
        // The real pipeline ends with the binary in the layout directory —
        // the fact `downloaded` reads.
        mkdirSync(join(dir, backend), { recursive: true })
        writeFileSync(join(dir, backend, 'katago.exe'), 'MZ-fake')
      })
      pending = run
      return run
    },
    ...overrides,
  }
  const service = createGpuService(deps)
  return {
    service,
    events,
    ensured,
    failNext: (error) => {
      failure = error
    },
    // A scripted failure rejects the pipeline promise on purpose — the test
    // observed it through the error event, so settle swallows the rejection
    // instead of failing the test with the pipeline's own error.
    settle: () =>
      pending.then(
        () => undefined,
        () => undefined,
      ),
  }
}

describe('gpu:status', () => {
  it('reports nothing downloaded with no preference', () => {
    const { service } = build()
    expect(service.status()).toEqual({
      backends: [
        { backend: 'cuda', downloaded: false, preferred: false },
        { backend: 'opencl', downloaded: false, preferred: false },
      ],
    })
  })

  it('mirrors the live preference and the on-disk layout', () => {
    let preferred: 'cuda' | null = null
    const { service } = build({ preference: () => preferred })
    mkdirSync(join(dir, 'cuda'), { recursive: true })
    writeFileSync(join(dir, 'cuda', 'katago.exe'), 'MZ-fake')

    let status = service.status()
    expect(status.backends[0]).toEqual({
      backend: 'cuda',
      downloaded: true,
      preferred: false,
    })

    // Read live, not cached at construction: the settings write flips the
    // next answer without rebuilding the service.
    preferred = 'cuda'
    status = service.status()
    expect(status.backends[0]?.preferred).toBe(true)
  })

  it('a platform with no tier-2 assets reports nothing, downloads refuse', async () => {
    const harness = build({ target: 'darwin-arm64' })
    expect(harness.service.status().backends.every((b) => !b.downloaded)).toBe(true)
    expect(() => harness.service.download('cuda')).toThrow(/no tier-2 assets/)
    await harness.settle()
  })
})

describe('gpu:download (the service logic)', () => {
  it('emits the full state sequence and ends downloaded', async () => {
    const harness = build()
    harness.service.download('cuda')
    await harness.settle()

    expect(harness.ensured).toEqual(['cuda'])
    const states = harness.events.map((e) => e.state)
    expect(states[0]).toBe('downloading')
    expect(states).toContain('extracting')
    expect(states.at(-1)).toBe('done')
    expect(harness.service.status().backends[0]?.downloaded).toBe(true)
  })

  it('refuses a concurrent download, and frees the slot when done', async () => {
    const harness = build()
    harness.service.download('cuda')
    expect(() => harness.service.download('opencl')).toThrow(/already running/)
    await harness.settle()
    // The slot freed after completion: the second backend starts.
    expect(() => harness.service.download('opencl')).not.toThrow()
    await harness.settle()
    expect(harness.ensured).toEqual(['cuda', 'opencl'])
  })

  it('an error state names the failure and frees the slot', async () => {
    const harness = build()
    harness.failNext(new Error('sha256 mismatch'))
    harness.service.download('cuda')
    await harness.settle()

    const last = harness.events.at(-1)
    expect(last?.state).toBe('error')
    expect(last?.error).toBe('sha256 mismatch')
    // The slot freed: a follow-up download starts rather than refusing.
    expect(() => harness.service.download('opencl')).not.toThrow()
  })
})
