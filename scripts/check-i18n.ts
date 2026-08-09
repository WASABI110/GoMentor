/**
 * i18n key-completeness gate (R10, A12).
 *
 * ## Why this delegates instead of re-checking
 *
 * R10 asks CI to fail "on keys missing relative to `en`". The assertions that do
 * that live in `apps/desktop/test/renderer/i18n.test.ts`, where they are also
 * mutation-proven. A second implementation here would be a second thing to keep
 * correct, and the two would drift — the failure mode being that the gate passes
 * while the suite fails, or worse, the gate passes because it checks something
 * weaker than the suite does. So this runs those tests and nothing else.
 *
 * ## Why the script exists at all rather than just `pnpm test`
 *
 * Two reasons. `package.json` has referenced `check:i18n` since the scripts were
 * written and the file did not exist, so `pnpm check:i18n` failed with a
 * module-not-found that reads like a broken toolchain rather than a missing
 * feature. And R10 names this as its own gate: CI should be able to fail on
 * translation completeness without running the whole suite, and a human adding a
 * locale should have one command to run.
 *
 * ## What it does not check
 *
 * Whether a translation is *good*. It does now catch a translation that was never
 * made — a `zh-CN` value copied verbatim from `en` fails, because key-set
 * comparison alone was measured to pass for five entirely untranslated namespaces
 * (see R10's Stage 6 amendment). What it still cannot see is a visible string
 * hardcoded in a component instead of looked up: that is the remaining hole in
 * A12, it is not decidable from the catalogues, and it needs the built app —
 * `test/e2e/i18n.spec.ts`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * vitest is invoked as a Node script, not through `npx` and not through a shell.
 *
 * Measured, because the two obvious spellings both fail on Windows and one of
 * them fails *silently*. `spawnSync('npx', …)` is ENOENT — `npx` is `npx.cmd`,
 * which is not an executable Node can exec. `spawnSync('npx.cmd', …)` is EINVAL:
 * since the CVE-2024-27980 fix Node refuses to spawn a `.cmd` without a shell.
 * In both cases `status` is non-zero with no output, so this script printed
 * "i18n key completeness FAILED" while having run no tests at all — a gate that
 * reports a translation defect when the real problem is that it never started.
 *
 * `shell: true` does work, but it earns a DEP0190 deprecation warning on every
 * run. Spawning the resolved `.mjs` entry with `process.execPath` needs neither.
 */
const VITEST = 'node_modules/vitest/vitest.mjs'

if (!existsSync(VITEST)) {
  // Distinguished from a translation failure on purpose: the message below is
  // about the catalogues, and printing it for a missing dependency would send
  // someone looking for a missing key that does not exist. Run from the repo
  // root — `quality-guidelines.md` §Running tests.
  console.error(
    `Cannot find ${VITEST}. Run this from the repository root after install.`,
  )
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [VITEST, 'run', '--project', 'desktop', '--reporter', 'dot', 'i18n'],
  { stdio: 'inherit' },
)

if (result.status !== 0) {
  console.error('\ni18n key completeness FAILED — see the failures above.')
  console.error('A missing key means a user sees a raw key name (A12).')
  process.exit(result.status ?? 1)
}

console.log('\ni18n key completeness OK.')
