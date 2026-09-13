import { describe, expect, it } from 'vitest'
import {
  BACKEND_PRIORITY,
  GPU_BACKENDS,
  selectBackend,
} from '../../src/katago/backends'

/**
 * The tier-2 backend ordering policy. Small, but it decides which engine a
 * user with several working backends actually gets — worth pinning rather
 * than re-deriving at the call site.
 */
describe('selectBackend', () => {
  it('orders by best experience: cuda, opencl, eigen', () => {
    expect(selectBackend(['eigen', 'opencl', 'cuda'], null)).toEqual([
      'cuda',
      'opencl',
      'eigen',
    ])
  })

  it('skips what is not available', () => {
    expect(selectBackend(['eigen'], null)).toEqual(['eigen'])
    expect(selectBackend(['opencl', 'eigen'], null)).toEqual(['opencl', 'eigen'])
  })

  it('an explicit preference collapses the list to that one backend', () => {
    // A user who names opencl must get opencl even though cuda is present —
    // the setting is an override, not a hint.
    expect(selectBackend(['eigen', 'opencl', 'cuda'], 'opencl')).toEqual(['opencl'])
  })

  it('a preference for an unavailable backend selects nothing', () => {
    // Empty, not a fallback: the caller decides what "wanted but missing"
    // means (surface it, fall back itself) — silently returning eigen would
    // make a typo in settings indistinguishable from a working choice.
    expect(selectBackend(['eigen'], 'cuda')).toEqual([])
  })

  it('the priority constant agrees with GPU_BACKENDS membership order', () => {
    // The list is the law; this pins the shape future edits must preserve.
    expect(BACKEND_PRIORITY).toEqual(['cuda', 'opencl', 'eigen'])
    expect([...GPU_BACKENDS]).toEqual(['cuda', 'opencl'])
  })
})
