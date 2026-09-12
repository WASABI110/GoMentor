import { describe, expect, it } from 'vitest'
import { isMyGame } from '../../src/main/library/mine'

/**
 * The "my game" predicate (M4 scope decision 2): manual override outranks
 * name matching; name matching is case-insensitive and colour-blind; an empty
 * names list claims nothing.
 *
 * Pure and dependency-free on purpose — Stage 3 relocates it to
 * `packages/core/src/profile/mine.ts`, and the suite must survive the move
 * unchanged.
 */

const NAMES = ['Lee Changho', 'goMe']

describe('isMyGame', () => {
  it('override true wins even with no names configured', () => {
    expect(isMyGame({ blackName: 'Kato' }, [], true)).toBe(true)
  })

  it('override false wins even over a matching name', () => {
    expect(isMyGame({ blackName: 'Lee Changho' }, NAMES, false)).toBe(false)
  })

  it('override true wins even when no name matches', () => {
    expect(isMyGame({ blackName: 'Kato', whiteName: 'Rin' }, NAMES, true)).toBe(true)
  })

  it('unset falls through to name matching', () => {
    expect(isMyGame({ blackName: 'Lee Changho' }, NAMES, undefined)).toBe(true)
  })

  it('matches either colour', () => {
    expect(isMyGame({ blackName: 'Lee Changho' }, NAMES, undefined)).toBe(true)
    expect(isMyGame({ whiteName: 'Lee Changho' }, NAMES, undefined)).toBe(true)
    expect(
      isMyGame({ blackName: 'Kato', whiteName: 'Lee Changho' }, NAMES, undefined),
    ).toBe(true)
  })

  it('matches case-insensitively on both the list and the record', () => {
    expect(isMyGame({ blackName: 'LEE CHANGHO' }, NAMES, undefined)).toBe(true)
    expect(isMyGame({ whiteName: 'LEE CHANGHO' }, NAMES, undefined)).toBe(true)
    // The list side too: the entry is all-caps, the record is not.
    expect(isMyGame({ blackName: 'lee changho' }, ['LEE CHANGHO'], undefined)).toBe(
      true,
    )
  })

  it('matches a name regardless of which list slot holds it', () => {
    expect(isMyGame({ whiteName: 'gome' }, NAMES, undefined)).toBe(true)
  })

  it('no name match → not mine', () => {
    expect(isMyGame({ blackName: 'Kato', whiteName: 'Rin' }, NAMES, undefined)).toBe(
      false,
    )
  })

  it('absent record names never match', () => {
    expect(isMyGame({}, NAMES, undefined)).toBe(false)
    expect(isMyGame({ whiteName: undefined }, NAMES, undefined)).toBe(false)
  })

  it('an empty or all-empty names list claims nothing', () => {
    expect(isMyGame({ blackName: 'Lee Changho' }, [], undefined)).toBe(false)
    expect(isMyGame({ blackName: '' }, [''], undefined)).toBe(false)
  })

  it('an empty player name on the record does not match an empty list entry', () => {
    expect(isMyGame({ blackName: '' }, [''], undefined)).toBe(false)
  })
})
