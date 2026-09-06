import { describe, expect, it } from 'vitest'
import {
  reduceEnginePhase,
  type EngineEvent,
  type EnginePhase,
} from '../../src/main/katago/state-machine'

/**
 * The transition table, exhaustively enough to matter. The decisions under
 * test (`design.md` §Engine lifecycle):
 *
 * - start is lazy and idempotent — from `ready`/`starting` it is a no-op, so a
 *   double-fire cannot respawn the engine;
 * - only a proven probe reaches `ready` — a machine that could declare
 *   readiness without one is the bug this stage exists to prevent;
 * - a crash after `ready` is still a crash (the badge must not fossilise);
 * - dev-absence degrades to `unavailable`, never `failed`.
 *
 * Every assertion is written against the table's semantics, so a mutation of
 * the table (wrong target state, dropped guard) flips a result here.
 */

function step(current: EnginePhase, event: EngineEvent): EnginePhase {
  return reduceEnginePhase(current, event)
}

describe('reduceEnginePhase', () => {
  it('start-requested moves unavailable and failed to starting', () => {
    expect(step('unavailable', { kind: 'start-requested' })).toBe('starting')
    expect(step('failed', { kind: 'start-requested' })).toBe('starting')
  })

  it('start-requested is a no-op from starting and ready', () => {
    // Idempotence: the second call joins the in-flight attempt, it does not
    // restart it.
    expect(step('starting', { kind: 'start-requested' })).toBe('starting')
    expect(step('ready', { kind: 'start-requested' })).toBe('ready')
  })

  it('probe-succeeded reaches ready only from starting', () => {
    expect(step('starting', { kind: 'probe-succeeded' })).toBe('ready')
    // A late probe answer after a failure/timeout must not resurrect the
    // engine to `ready`.
    expect(step('failed', { kind: 'probe-succeeded' })).toBe('failed')
    expect(step('unavailable', { kind: 'probe-succeeded' })).toBe('unavailable')
  })

  it('probe-timed-out fails only from starting', () => {
    expect(step('starting', { kind: 'probe-timed-out' })).toBe('failed')
    expect(step('ready', { kind: 'probe-timed-out' })).toBe('ready')
  })

  it('crashed fails from either live phase and nothing else', () => {
    expect(step('starting', { kind: 'crashed' })).toBe('failed')
    expect(step('ready', { kind: 'crashed' })).toBe('failed')
    expect(step('failed', { kind: 'crashed' })).toBe('failed')
    expect(step('unavailable', { kind: 'crashed' })).toBe('unavailable')
  })

  it('crash-retry moves ready back to starting and nothing else', () => {
    // The wire shape of a bounded restart (module header): the badge honestly
    // shows `starting` while the engine comes back up. It must not resurrect a
    // terminal `failed` (the circuit breaker would re-open itself), must not
    // flicker the already-`starting` probe phase, and must not touch absence.
    expect(step('ready', { kind: 'crash-retry' })).toBe('starting')
    expect(step('starting', { kind: 'crash-retry' })).toBe('starting')
    expect(step('failed', { kind: 'crash-retry' })).toBe('failed')
    expect(step('unavailable', { kind: 'crash-retry' })).toBe('unavailable')
  })

  it('missing-in-dev degrades starting to unavailable, never to failed', () => {
    expect(step('starting', { kind: 'missing-in-dev' })).toBe('unavailable')
    expect(step('ready', { kind: 'missing-in-dev' })).toBe('ready')
  })

  it('start-failed fails only from starting', () => {
    expect(step('starting', { kind: 'start-failed' })).toBe('failed')
    expect(step('ready', { kind: 'start-failed' })).toBe('ready')
  })

  it('shutdown returns to unavailable from every phase', () => {
    for (const phase of ['unavailable', 'starting', 'ready', 'failed'] as const) {
      expect(step(phase, { kind: 'shutdown' })).toBe('unavailable')
    }
  })

  it('the table is closed: every event kind is handled from every phase', () => {
    // Not a substitute for the cases above — a guard against a future edit
    // adding an event kind and forgetting half the matrix, which TypeScript's
    // exhaustiveness check already forbids in the implementation. This exists
    // so the *semantics* stay specified where a reader looks first.
    const events: EngineEvent['kind'][] = [
      'start-requested',
      'start-failed',
      'probe-succeeded',
      'probe-timed-out',
      'crashed',
      'crash-retry',
      'missing-in-dev',
      'shutdown',
    ]
    const phases: EnginePhase[] = ['unavailable', 'starting', 'ready', 'failed']
    for (const kind of events) {
      for (const phase of phases) {
        const next = reduceEnginePhase(phase, { kind })
        expect(phases, `${kind} from ${phase} -> ${next}`).toContain(next)
      }
    }
  })
})
