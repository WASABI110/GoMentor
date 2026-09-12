import { describe, expect, it } from 'vitest'
import { isMyGame, isProfessionalRank } from '../../src/profile/mine'

/**
 * The "my game" predicate (M4 scope decision 2 + C4): manual override outranks
 * the professional exclusion, which outranks name matching; name matching is
 * case-insensitive and colour-blind; an empty names list claims nothing.
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

describe('the professional exclusion (C4)', () => {
  it('keeps a professional game out of the profile by default', () => {
    expect(
      isMyGame({ blackName: 'Lee Changho', blackRank: '9p' }, NAMES, undefined),
    ).toBe(false)
    expect(
      isMyGame({ whiteName: 'Lee Changho', whiteRank: '9 dan pro' }, NAMES, undefined),
    ).toBe(false)
    expect(
      isMyGame(
        { blackName: 'Lee Changho', blackRank: 'professional 9 dan' },
        NAMES,
        undefined,
      ),
    ).toBe(false)
  })

  it('reads either side’s rank, and never a match in the middle of a word', () => {
    // The conventional notation, either colour.
    expect(isProfessionalRank('9p')).toBe(true)
    expect(isProfessionalRank('9 p')).toBe(true)
    // The explicit word, including inside a longer rank string.
    expect(isProfessionalRank('pro')).toBe(true)
    expect(isProfessionalRank('7 dan (pro)')).toBe(true)
    // Amateur ranks and non-rank words must not trip it.
    expect(isProfessionalRank('7d')).toBe(false)
    expect(isProfessionalRank('5 kyu')).toBe(false)
    expect(isProfessionalRank('proud amateur')).toBe(false)
    expect(isProfessionalRank('champion')).toBe(false)
  })

  it('absent ranks never read as professional', () => {
    expect(isMyGame({ blackName: 'Lee Changho' }, NAMES, undefined)).toBe(true)
    expect(
      isMyGame({ blackName: 'Lee Changho', blackRank: undefined }, NAMES, undefined),
    ).toBe(true)
  })

  it('the override outranks the professional exclusion in both directions', () => {
    // A claimed demonstration game is study material — the user decided.
    expect(isMyGame({ blackRank: '9p' }, [], true)).toBe(true)
    expect(isMyGame({ blackName: 'Lee Changho', blackRank: '9p' }, NAMES, true)).toBe(
      true,
    )
    // And "not mine" still wins over everything.
    expect(isMyGame({ blackName: 'Lee Changho' }, NAMES, false)).toBe(false)
  })

  it('a professional game with no configured names is excluded, not matched', () => {
    // The rank rule fires before the empty-list short-circuit: otherwise an
    // unconfigured library would silently include pro games the day names are
    // first added... no — the point is the exclusion is unconditional without
    // an override, whatever the names list holds.
    expect(isMyGame({ blackRank: '9p' }, [], undefined)).toBe(false)
  })
})
