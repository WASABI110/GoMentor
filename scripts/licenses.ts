/**
 * SPDX evaluation for the dependency-license gate (D4, R11).
 *
 * Split out from `check-licenses.ts` so it can be tested. That script is a
 * top-level program: importing it would shell out to `pnpm licenses list` as an
 * import side effect, so the decision logic — the part with edge cases worth
 * asserting — has to live somewhere a test can reach without running the gate.
 *
 * Pure and dependency-free on purpose: given a license field, is it something
 * GPL-3.0 may absorb.
 */

/**
 * SPDX ids GPL-3.0 may absorb.
 *
 * Every entry is a permissive license whose obligations (attribution, notice
 * retention, and for Apache-2.0 a patent grant) survive intact under GPL-3.0.
 *
 * An allowlist rather than a denylist, because a denylist of known-bad ids passes
 * for every license nobody thought of — `UNLICENSED`, a bare "SEE LICENSE IN …",
 * a typo'd id. The default for an unrecognised license must be *stop and make a
 * human look*. A new permissive license entering the tree costs one reviewed line
 * here; the alternative costs a relicensing.
 */
export const PERMITTED: ReadonlySet<string> = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'Zlib',
  // Documentation/data, not linked code. `caniuse-lite` ships browser tables.
  'CC-BY-4.0',
  // "Do What The F*ck You Want To" — permissive to the point of parody, and
  // GPL-compatible. Enumerated rather than excluded because two real transitive
  // dependencies use it, and pretending otherwise would make this a denylist.
  'WTFPL',
])

/** Strips surrounding parentheses and whitespace from one SPDX term. */
function normalise(term: string): string {
  return term.trim().replace(/^\(+|\)+$/g, '')
}

/**
 * Whether GPL-3.0 may absorb a package's declared license field.
 *
 * Written as a parser rather than as literal strings like `'WTFPL OR ISC'`,
 * because the same pair appears in either order and with or without parentheses —
 * several spellings of one fact, and a missing spelling reads as a forbidden
 * license, failing the build for a dependency that is actually fine.
 *
 * `OR` is a **choice** the licensee makes, so one permitted disjunct suffices —
 * `AGPL-3.0 OR MIT` is usable under MIT. `AND` is **conjunctive**: every term
 * binds simultaneously, so `MIT AND AGPL-3.0` is not rescued by its MIT half.
 * Getting that asymmetry backwards in either direction is a real defect — one way
 * blocks safe dependencies, the other admits copyleft into a GPL-incompatible
 * position — which is why both are asserted in the tests.
 */
export function isPermitted(field: string): boolean {
  const cleaned = normalise(field)
  // Redundant today and kept deliberately: the split below already yields `['']`,
  // which `PERMITTED` does not contain, so an absent license field returns false
  // on its own. Measured — deleting this line leaves all 26 tests green. It stays
  // as an explicit statement that absence is not permission, so that adding `''`
  // or a catch-all to `PERMITTED` cannot quietly turn "no license" into "fine".
  if (cleaned === '') return false

  if (/\bAND\b/i.test(cleaned)) {
    return cleaned.split(/\s+AND\s+/i).every((term) => PERMITTED.has(normalise(term)))
  }

  return cleaned.split(/\s+OR\s+/i).some((term) => PERMITTED.has(normalise(term)))
}
