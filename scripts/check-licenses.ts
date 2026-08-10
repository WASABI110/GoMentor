/**
 * Dependency-license gate (R2/R11, D4).
 *
 * ## What it enforces and why the direction matters
 *
 * D4 fixes this project at **GPL-3.0**. GPL-3.0 is a *one-way absorber*: it can
 * take in MIT, ISC, BSD, and Apache-2.0 code, but nothing can take in GPL code
 * except under GPL. So the question this gate answers is not "is this dependency
 * open source" but the narrower and asymmetric "may GPL-3.0 absorb it".
 *
 * The failure this prevents is legal, not technical, and it is invisible until
 * distribution: a copyleft-incompatible transitive dependency makes the built
 * artifact undistributable, and it arrives through a lockfile bump that no test
 * would ever fail on. That is why it belongs in CI rather than in a review
 * checklist.
 *
 * ## Why an allowlist rather than a denylist
 *
 * A denylist of known-bad SPDX ids ("AGPL", "SSPL", "proprietary") passes for
 * every license nobody thought of, including `UNLICENSED`, a bare "SEE LICENSE IN
 * …", and a typo'd id. The default for an unrecognised license must be *stop and
 * make a human look*, so this enumerates what is permitted and fails on
 * everything else. A new permissive license entering the tree costs one reviewed
 * line here; the alternative costs a relicensing.
 *
 * The allowlist and the SPDX `AND`/`OR` evaluation live in `./licenses.ts`, not
 * here: this file is a top-level program, so a test importing it would shell out
 * to pnpm as an import side effect. The decision logic is the part with edge cases
 * worth asserting, so it sits where `test/unit/licenses.test.ts` can reach it.
 *
 * ## Why `pnpm licenses` and not a dedicated checker
 *
 * pnpm reports this natively for the whole resolved tree. Adding a license-scanner
 * dependency to check dependencies has an obvious circularity, and one more
 * package in the tree is one more license to vet.
 */
import { spawnSync } from 'node:child_process'
import { isPermitted } from './licenses'

interface PnpmLicensePackage {
  name?: unknown
  versions?: unknown
}

/**
 * `pnpm` is invoked as a single fixed command string under a shell.
 *
 * Measured, because the obvious spelling earns a warning on every run. Passing an
 * args *array* with `shell: true` triggers DEP0190 ("arguments are not escaped,
 * only concatenated") — a real hazard when any element is interpolated, and Node
 * warns whether or not that is the case. Passing one constant string has nothing
 * to escape and stays silent.
 *
 * A shell is needed at all because `pnpm` is `pnpm.cmd` on Windows, which Node
 * refuses to spawn directly since the CVE-2024-27980 fix. `scripts/check-i18n.ts`
 * dodges this by spawning vitest's `.mjs` with `process.execPath`; pnpm exposes no
 * equivalent path (it is installed globally, and neither `npm_execpath` nor any
 * `PNPM_*` variable points at its JS entry), so a hardcoded path would work on
 * this machine and fail in CI.
 *
 * The command contains no interpolated values, so there is no injection surface.
 */
const result = spawnSync('pnpm licenses list --json', {
  encoding: 'utf8',
  shell: true,
})

if (result.status !== 0) {
  // Distinguished from a license violation on purpose. A gate that reports its
  // subject as broken when it is the gate that failed to start is worse than no
  // gate — that exact confusion is recorded in `scripts/check-i18n.ts`.
  console.error('Could not run `pnpm licenses list --json`.')
  console.error(result.stderr.trim() || `exit status ${String(result.status)}`)
  process.exit(1)
}

let parsed: unknown
try {
  parsed = JSON.parse(result.stdout)
} catch {
  console.error('`pnpm licenses list --json` did not return JSON.')
  process.exit(1)
}

if (typeof parsed !== 'object' || parsed === null) {
  console.error('`pnpm licenses list --json` returned no license map.')
  process.exit(1)
}

const groups = Object.entries(parsed as Record<string, unknown>)

// An empty report means the gate inspected nothing. Silence must not read as
// success: with no dependencies resolved, every check below passes trivially.
if (groups.length === 0) {
  console.error('No licenses reported. Run `pnpm install` first, from the root.')
  process.exit(1)
}

const violations: { license: string; packages: string[] }[] = []
let inspected = 0

for (const [license, value] of groups) {
  const packages = Array.isArray(value) ? (value as PnpmLicensePackage[]) : []
  inspected += packages.length

  if (isPermitted(license)) continue

  violations.push({
    license,
    packages: packages
      .map((pkg) => (typeof pkg.name === 'string' ? pkg.name : '<unnamed>'))
      .sort(),
  })
}

if (violations.length > 0) {
  console.error(
    `Found ${String(violations.length)} license(s) not permitted under D4:\n`,
  )
  for (const { license, packages } of violations) {
    console.error(`  ${license}`)
    for (const name of packages) console.error(`    - ${name}`)
  }
  console.error(
    '\nD4 fixes this project at GPL-3.0, which can absorb permissive licenses but',
  )
  console.error(
    'not copyleft ones with different terms. Either drop the dependency, or',
  )
  console.error(
    '— if the license is permissive and was simply not yet seen — add it to',
  )
  console.error(
    'PERMITTED in `scripts/licenses.ts` with a note on why GPL-3.0 may absorb it.',
  )
  process.exit(1)
}

console.log(
  `Dependency licenses OK: ${String(inspected)} packages across ${String(groups.length)} licenses, all GPL-3.0-compatible.`,
)
