import { describe, expect, it } from 'vitest'
import { PERMITTED, isPermitted } from '../licenses'

/**
 * The SPDX evaluation behind the dependency-license gate (D4, R11).
 *
 * ## Why a license check gets a test at all
 *
 * Its failure mode is legal, invisible until distribution, and arrives through a
 * lockfile bump rather than through code — nothing else in the suite would fail.
 * And the check has one genuinely subtle rule, the `AND`/`OR` asymmetry, where
 * being wrong in *either* direction is a real defect: too strict blocks safe
 * dependencies until someone weakens the gate to unblock CI, too loose admits
 * copyleft into a GPL-3.0-incompatible position.
 *
 * ## Why these cases and not the real dependency tree
 *
 * `check-licenses.ts` already runs against the real tree, and asserting today's
 * 498 packages here would restate the current lockfile as a requirement — a test
 * that fails on every legitimate dependency bump. What is worth pinning is the
 * *decision*, so these are license fields, including ones no current dependency
 * uses. The forbidden cases matter most: the real tree cannot exercise them,
 * because if it could, the build would already be blocked.
 */

describe('licenses GPL-3.0 may absorb', () => {
  for (const field of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']) {
    it(`permits ${field}`, () => {
      expect(isPermitted(field)).toBe(true)
    })
  }
})

describe('licenses it must refuse', () => {
  /**
   * Copyleft with terms GPL-3.0 cannot satisfy, plus the "no license stated"
   * spellings. None appears in the current tree, which is exactly why they are
   * asserted here: the gate's whole value is what it does on first contact.
   */
  const FORBIDDEN = [
    'AGPL-3.0',
    'AGPL-3.0-only',
    'SSPL-1.0',
    'BUSL-1.1',
    'CC-BY-NC-4.0',
    'Elastic-2.0',
    'UNLICENSED',
    'SEE LICENSE IN LICENSE.md',
    'Commercial',
  ]

  for (const field of FORBIDDEN) {
    it(`refuses ${field}`, () => {
      expect(isPermitted(field)).toBe(false)
    })
  }

  it('refuses a license it has never seen rather than defaulting to permitted', () => {
    // The allowlist's reason for being. An unrecognised id must stop the build,
    // not sail through — a denylist would pass this.
    expect(isPermitted('Some-New-License-2.0')).toBe(false)
  })

  it('refuses an empty or whitespace field', () => {
    // A package with no `license` field at all. Absence is not permission.
    expect(isPermitted('')).toBe(false)
    expect(isPermitted('   ')).toBe(false)
    expect(isPermitted('()')).toBe(false)
  })
})

describe('OR is a choice the licensee makes', () => {
  it('permits a disjunction with one permitted term, in either order', () => {
    // Order must not matter — the same pair is written both ways in the wild.
    expect(isPermitted('WTFPL OR ISC')).toBe(true)
    expect(isPermitted('ISC OR WTFPL')).toBe(true)
  })

  it('permits a disjunction wrapped in parentheses', () => {
    // Both spellings occur in the current tree: `(MIT OR CC0-1.0)` for `type-fest`
    // and bare `WTFPL OR ISC` for `sanitize-filename`.
    expect(isPermitted('(MIT OR CC0-1.0)')).toBe(true)
    expect(isPermitted('(WTFPL OR MIT)')).toBe(true)
  })

  it('permits copyleft OR permissive, because the permissive term is available', () => {
    // Not a loophole. `AGPL-3.0 OR MIT` genuinely may be used under MIT, and
    // refusing it would block a safe dependency — the kind of false positive that
    // gets a gate weakened.
    expect(isPermitted('AGPL-3.0 OR MIT')).toBe(true)
  })

  it('refuses a disjunction where no term is permitted', () => {
    expect(isPermitted('AGPL-3.0 OR SSPL-1.0')).toBe(false)
  })
})

describe('AND is conjunctive and must not be rescued by one term', () => {
  it('refuses a conjunction containing a forbidden term', () => {
    // The case where getting the asymmetry backwards admits copyleft. Both terms
    // bind at once, so the MIT half does not help.
    expect(isPermitted('MIT AND AGPL-3.0')).toBe(false)
    expect(isPermitted('AGPL-3.0 AND MIT')).toBe(false)
  })

  it('permits a conjunction whose every term is permitted', () => {
    expect(isPermitted('MIT AND ISC')).toBe(true)
  })

  it('treats AND and OR differently for the same pair', () => {
    // Stated as one assertion because it is the single property this whole block
    // exists for: swapping the operator must change the answer.
    expect(isPermitted('MIT OR AGPL-3.0')).toBe(true)
    expect(isPermitted('MIT AND AGPL-3.0')).toBe(false)
  })
})

describe('the allowlist itself', () => {
  it('contains no copyleft id', () => {
    // A guard on future edits to `PERMITTED`: adding 'GPL-3.0' or 'AGPL-3.0' there
    // would silently make every other assertion in this file vacuous.
    const copyleft = [...PERMITTED].filter((id) =>
      /GPL|SSPL|BUSL|OSL|EUPL|CDDL|MPL|CC-BY-(NC|SA)/i.test(id),
    )
    expect(copyleft).toEqual([])
  })

  it('is small enough to have been read', () => {
    // Every entry is supposed to carry a human decision. A list that grew past
    // this is a list nobody vetted; the number forces the question.
    expect(PERMITTED.size).toBeLessThanOrEqual(20)
  })

  it('has no entry that is itself a disjunction', () => {
    // `PERMITTED` holds single SPDX ids. An entry like 'WTFPL OR ISC' would appear
    // to work while bypassing `isPermitted`'s parsing, so a differently-ordered
    // spelling of the same pair would then fail.
    const compound = [...PERMITTED].filter((id) => /\s(OR|AND)\s/i.test(id))
    expect(compound).toEqual([])
  })
})
