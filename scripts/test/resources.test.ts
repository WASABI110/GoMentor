import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, RESOURCES_ROOT, RESOURCE_TARGETS, resourceDir } from '../resources'

/**
 * The `extraResources` directories exist and hold a file the packager will copy.
 *
 * ## The defect this exists to prevent, which already happened
 *
 * `electron-builder.yml` declares three `extraResources` entries and comments that
 * the structure exists in M1 "so M2 is purely additive". It did not exist. And
 * electron-builder **skips a missing `from` silently** — no warning on stdout, no
 * non-zero exit. The last unpacked build's `resources/` directory contained only
 * `app.asar`, and nothing anywhere reported it. The discovery point would have been
 * M2, spawning an engine that is not there.
 *
 * This is the shape of bug a checklist cannot catch, because there is no failure to
 * notice: the build succeeds and produces a plausible artifact.
 *
 * ## Why `existsSync` is not the invariant, measured
 *
 * Two of the three READMEs were untracked, and every assertion here still passed,
 * because they existed in the working tree that wrote them. `.gitignore` excluded
 * `apps/desktop/resources/katago/` — the directory — and git will not re-include a
 * file whose parent directory is excluded, so the README negation below it was
 * unreachable. A fresh clone therefore had no directory at all, CI's `pnpm test`
 * would have failed on it, and `pnpm package` in CI would have reproduced the
 * original silent skip exactly. The fix is a trailing `*` on the directory pattern
 * instead of a trailing slash; the guard is asking git what it tracks rather than
 * asking the filesystem what happens to be here.
 *
 * ## Why the expected list is read from the YAML and not written here
 *
 * Anchoring to an independent authority. If this test hardcoded the three
 * directory names, adding a fourth `extraResources` entry would be uncovered by
 * construction — the test would keep passing while the new directory silently
 * failed to package. So the source of truth is the packager's own config, and
 * `RESOURCE_TARGETS` is checked *against* it rather than trusted as it.
 *
 * ## Why "non-empty" is not enough, and `.gitkeep` specifically
 *
 * electron-builder's default ignore list includes `.gitkeep` — visible in
 * `dist/builder-debug.yml`. A directory containing only a `.gitkeep` is tracked by
 * git and still empty as far as packaging is concerned, which would satisfy a naive
 * existence check while reproducing the original bug exactly. So the assertion is
 * that at least one file survives those filters.
 */

const BUILDER_YML = join(RESOURCES_ROOT, '..', ...['electron-builder.yml'])

/**
 * Names electron-builder ignores by default, as they matter here.
 *
 * Not the full list — only the entries a human might plausibly reach for as a
 * directory placeholder. Copied from `dist/builder-debug.yml`.
 */
const PACKAGER_IGNORES = new Set([
  '.gitkeep',
  '.gitignore',
  '.gitattributes',
  '.npmignore',
  '.DS_Store',
  'thumbs.db',
])

/**
 * The `from:` values under `extraResources:` in the packager config.
 *
 * A targeted scan rather than a YAML parse: pulling in a YAML dependency for one
 * flat list of strings is a bigger surface than the thing being read, and the
 * block's shape is asserted below by count.
 */
function extraResourceSources(): string[] {
  const source = readFileSync(BUILDER_YML, 'utf8')
  const start = source.indexOf('\nextraResources:')
  if (start === -1) return []

  // Stops at the next top-level key — a line beginning with a non-space, non-dash
  // character. Anything indented belongs to this block.
  const rest = source
    .slice(start + 1)
    .split('\n')
    .slice(1)
  const out: string[] = []
  for (const line of rest) {
    if (/^[^\s#-]/.test(line)) break
    const match = /^\s*-?\s*from:\s*(\S+)\s*$/.exec(line)
    if (match?.[1] !== undefined) out.push(match[1])
  }
  return out
}

/**
 * The files git tracks under a directory, as repo-relative posix paths.
 *
 * Asking git rather than parsing `.gitignore`: a parse would be a second
 * implementation of git's precedence rules, and the rule that actually caused the
 * defect above — a negation under an excluded directory being unreachable — is one
 * of the subtle ones. Re-implementing it here would mean the test and the bug agree.
 *
 * `split(sep).join('/')` is belt-and-braces, not a fix for an observed failure:
 * `git ls-files` on Windows was measured to accept a backslash pathspec, and
 * removing the conversion keeps all seven tests green. It stays because a pathspec
 * is git's syntax rather than the OS's, and because the *output* really is posix on
 * every platform — see `isPackageable`.
 */
function trackedFiles(absoluteDir: string): string[] {
  const pathspec = relative(REPO_ROOT, absoluteDir).split(sep).join('/')
  const stdout = execFileSync('git', ['ls-files', '-z', '--', pathspec], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return stdout.split('\0').filter((line) => line !== '')
}

/**
 * Whether a tracked path is a file electron-builder will actually copy.
 *
 * Split out to be directly assertable. Inline, the `PACKAGER_IGNORES` lookup only
 * changes an answer when a directory's *only* tracked file is an ignored name — a
 * tracked `.gitkeep`, which is exactly the plausible wrong fix for the missing
 * directory. Everywhere else the check is inert, so a mutation to it survives the
 * directory sweep and is caught only by the assertion below it.
 *
 * Splits on `/` and not `sep`: `git ls-files` prints posix separators on every
 * platform, Windows included.
 */
function isPackageable(repoPath: string): boolean {
  const name = repoPath.split('/').at(-1) ?? repoPath
  return !PACKAGER_IGNORES.has(name)
}

describe('electron-builder extraResources', () => {
  const sources = extraResourceSources()

  it('finds the extraResources block', () => {
    // Guards the scanner. If a reformat broke it, every per-directory assertion
    // below would iterate zero times and pass.
    expect(
      sources.length,
      `no "from:" entries found under extraResources: in ${BUILDER_YML}`,
    ).toBeGreaterThanOrEqual(3)
  })

  it('every declared source directory exists', () => {
    const missing = sources.filter(
      (from) => !existsSync(join(RESOURCES_ROOT, '..', from)),
    )
    expect(
      missing,
      `electron-builder copies nothing (silently) for: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('every declared source holds at least one file the packager will copy', () => {
    const empty: string[] = []

    for (const from of sources) {
      const dir = join(RESOURCES_ROOT, '..', from)
      if (!existsSync(dir)) continue // reported by the assertion above

      const copyable = readdirSync(dir, { withFileTypes: true }).filter(
        (entry) => entry.isFile() && !PACKAGER_IGNORES.has(entry.name),
      )
      if (copyable.length === 0) empty.push(from)
    }

    expect(
      empty,
      `contains no packageable file (a .gitkeep does not count — electron-builder ignores it): ${empty.join(', ')}`,
    ).toEqual([])
  })

  it('every declared source holds a packageable file that git tracks', () => {
    // The assertion above passes on a working tree; this one is about a clone.
    // CI checks out, installs, tests, and packages — a placeholder that only
    // exists here is not there, and the silent skip comes back.
    const untracked = sources.filter(
      (from) => !trackedFiles(join(RESOURCES_ROOT, '..', from)).some(isPackageable),
    )

    expect(
      untracked,
      `no committed file the packager will copy — absent from a fresh clone, so CI packages nothing: ${untracked.join(', ')}`,
    ).toEqual([])
  })

  it('does not count a tracked .gitkeep as a packageable file', () => {
    // The case the sweep above cannot reach while the READMEs are in place, and the
    // one a future "fix" for a missing directory would land on.
    expect(isPackageable('apps/desktop/resources/katago/README.md')).toBe(true)
    expect(isPackageable('apps/desktop/resources/katago/.gitkeep')).toBe(false)
  })

  it('scripts/resources.ts describes every directory the packager copies', () => {
    // Drift guard in the other direction: a new extraResources entry that the
    // fetch tooling knows nothing about.
    const described = new Set(RESOURCE_TARGETS.map((target) => target.dir))
    const undescribed = sources
      .map((from) => from.split('/').at(-1) ?? from)
      .filter((dir) => !described.has(dir))

    expect(
      undescribed,
      `packaged but absent from RESOURCE_TARGETS in scripts/resources.ts: ${undescribed.join(', ')}`,
    ).toEqual([])
  })
})

describe('scripts/resources.ts', () => {
  it('points at directories that exist', () => {
    const missing = RESOURCE_TARGETS.filter(
      (target) => !existsSync(resourceDir(target.dir)),
    )
    expect(missing.map((target) => target.dir)).toEqual([])
  })

  it('each placeholder README explains itself rather than being empty', () => {
    for (const target of RESOURCE_TARGETS) {
      const readme = join(resourceDir(target.dir), 'README.md')
      expect(existsSync(readme), `${target.dir}/README.md is missing`).toBe(true)
      // A size floor, not a content match. The point is to catch a truncation to
      // an empty marker — which would still satisfy the packager but would lose
      // the explanation of why the file may not be deleted.
      expect(
        statSync(readme).size,
        `${target.dir}/README.md looks like an empty placeholder`,
      ).toBeGreaterThan(200)
    }
  })
})
