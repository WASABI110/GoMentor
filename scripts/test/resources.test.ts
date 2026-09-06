import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
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
 * Reads the whole electron-builder.yml once, for tests that inspect the
 * per-platform resource layout (not just the top-level `extraResources:` list).
 */
function readBuilderYml(): string {
  return readFileSync(BUILDER_YML, 'utf8')
}

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

  // Collects `from:` entries in the top-level block only; the loop stops at the
  // next top-level key (`asar:` today). M2 moved the engine entries into nested
  // `win:` / `linux:` blocks, and those are deliberately NOT collected here:
  // their directories are fetch artifacts that do not exist on a fresh clone, so
  // sweeping them for existence would fail CI before any fetch ran. The
  // per-platform engine entries are pinned textually by the dedicated M2
  // describe below. A `from:` is unambiguous (no other key in this file uses
  // it), so matching any indented `from:` inside the block is safe.
  const rest = source
    .slice(start + 1)
    .split('\n')
    .slice(1)
  const out: string[] = []
  for (const line of rest) {
    // Stop only at the next top-level key; the top-level block is flat, so a
    // `from:` always appears before any per-platform section can begin.
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

  it('finds the extraResources entries', () => {
    // Guards the scanner against silently iterating zero times and passing. We
    // assert the *known-essential* directories are present rather than a raw
    // count, because M2 moved the per-platform engine entries into nested
    // `win.extraResources` / `linux.extraResources` blocks while knowledge and
    // weights stayed top-level. Knowledge and weights are platform-independent
    // and must always be there; the engine subdirectories are checked separately
    // below (they exist only after a fetch, which a fresh clone has not done).
    expect(sources).toContain('resources/knowledge')
    expect(sources).toContain('resources/weights')
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

describe('per-platform engine packaging (M2)', () => {
  // The engine is per-platform, so it moved out of the top-level extraResources
  // into win/linux blocks. These tests pin the split so a regression that copies
  // every platform's binary into every installer (tripling the tier) fails here
  // rather than shipping.

  it('does not copy the whole katago tree at the top level', () => {
    const yml = readBuilderYml()
    const top = yml.slice(yml.indexOf('\nextraResources:'))
    // Everything before the first per-platform `win:` block is the top-level
    // scope. The bare `resources/katago` copy-everything entry must not be there.
    const topBlock = top.split('\nwin:')[0] ?? ''
    expect(topBlock).not.toContain('from: resources/katago\n')
  })

  it('ships the engine only for platforms with an official build', () => {
    const yml = readBuilderYml()
    expect(yml).toContain('from: resources/katago/win32-x64')
    expect(yml).toContain('from: resources/katago/linux-x64')
    // No macOS engine: KataGo publishes no macOS binaries (scope decision 6), so
    // there must be no darwin engine entry to copy a nonexistent directory.
    const macBlock = (yml.split('\nmac:')[1] ?? '').split('\nlinux:')[0] ?? ''
    expect(macBlock).not.toContain('resources/katago')
    expect(yml).not.toContain('darwin')
  })

  it('copies each platform payload into the subdirectory locate.ts resolves', () => {
    // The cross-layer half of the packaging contract: in a PACKAGED build,
    // `paths.ts`'s `engineBinariesDir('<platform>-<arch>')` is where the engine
    // is looked for, and electron-builder's copyDir places the CONTENTS of
    // `from` into `to`. So `to` must be `katago/<platform>-<arch>` — a flat
    // `to: katago` would put `katago.exe` one level too high and a packaged
    // launch would report ENGINE_BINARY_MISSING while dev mode (which reads the
    // same `<platform>-<arch>` tree directly) works everywhere. Asserted against
    // the concrete destination strings the main process resolves, not a
    // restatement of the rule.
    const yml = readBuilderYml()
    const destinationFor = (block: string): string | null =>
      /from:\s*resources\/katago\/(\S+)\s*\n\s*to:\s*(\S+)/.exec(block)?.[2] ?? null
    const winBlock = (yml.split('\nwin:')[1] ?? '').split('\nnsis:')[0] ?? ''
    const linuxBlock = (yml.split('\nlinux:')[1] ?? '').split('\npublish:')[0] ?? ''
    expect(destinationFor(winBlock)).toBe('katago/win32-x64')
    expect(destinationFor(linuxBlock)).toBe('katago/linux-x64')
  })

  it('keeps the local fetch cache (verified archive, partials) out of the installer', () => {
    // The fetcher retains the sha256-verified zip and any interrupted *.partial
    // in the platform directory as the resume/re-run cache. electron-builder
    // copies the directory wholesale, so without an explicit filter the archive
    // alone would roughly double the engine tier inside every installer. The
    // cache stays local; only the extracted payload ships.
    const yml = readBuilderYml()
    const winBlock = (yml.split('\nwin:')[1] ?? '').split('\nnsis:')[0] ?? ''
    const linuxBlock = (yml.split('\nlinux:')[1] ?? '').split('\npublish:')[0] ?? ''
    for (const block of [winBlock, linuxBlock]) {
      expect(block).toContain('from: resources/katago/')
      expect(block).toContain('!*.zip')
      expect(block).toContain('!*.partial')
    }
    // The platform-independent weights block has no archive to exclude, but an
    // interrupted fetch can still leave a *.partial next to the net.
    const topBlock =
      yml.slice(yml.indexOf('\nextraResources:')).split('\nwin:')[0] ?? ''
    expect(topBlock).toContain('!*.partial')
    expect(topBlock).not.toContain('!*.zip')
  })
})

describe('extraResources filters, evaluated with the packager’s glob matcher', () => {
  /**
   * The packaging filters are only real if they exclude what they claim to
   * exclude. The trellis-check verifier measured the gap this guards: a `!*.zip`
   * glob does not cross `/`, so it matches a top-level archive but lets a
   * NESTED one (`extracted/nested.zip`) through — and the fetcher today flattens
   * everything, so a nested archive would mean a layout change the shallow
   * filter was silently wrong about. The patterns are evaluated with the same
   * `minimatch` the packager uses underneath (electron-builder's FileMatcher is
   * too coupled to its macro-expansion context to construct in a unit test, and
   * the glob semantics are what actually decides what ships).
   *
   * Scoped to the engine block because that is where the cache lives; the top
   * level weights block has no archive to exclude but still must drop a partial.
   */
  interface EngineResource {
    from: string
    filter: string[]
  }

  const require = createRequire(import.meta.url)

  /** Parses one `- from:/to:/filter:` entry from the packager config. */
  function parseEngineResource(block: string): EngineResource {
    // `from` is captured to the first whitespace, not end-of-line: the block is
    // multi-line (from, to, filter), so the `from:` line ends with a newline
    // rather than `$`.
    const from = /from:\s*(\S+)/.exec(block)?.[1]
    const filterMatch = /filter:\s*\[([^\]]*)\]/.exec(block)?.[1]
    if (from === undefined || filterMatch === undefined) {
      throw new Error(`could not parse engine extraResources entry from:\n${block}`)
    }
    const filter = filterMatch
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, '').replace(/^"|"$/g, ''))
      .filter((entry) => entry !== '')
    return { from, filter }
  }

  function engineResources(): EngineResource[] {
    const yml = readBuilderYml()
    // The two engine blocks are the only ones carrying an archive-exclusion
    // filter; collect every `from: resources/katago/` entry regardless of which
    // platform block holds it. The `[\s\S]*?` between `from` and `filter` spans
    // the optional `to:` line (and any comment) without crossing into the next
    // `- from:` entry.
    const out: EngineResource[] = []
    const fromRe = /from:\s*resources\/katago\/\S+[\s\S]*?filter:\s*\[[^\]]*\]/g
    for (const match of yml.matchAll(fromRe)) {
      out.push(parseEngineResource(match[0]))
    }
    return out
  }

  it('the engine filter excludes nested archives and partials, keeps the payload', () => {
    const minimatch = require('minimatch') as (path: string, pattern: string) => boolean

    const resources = engineResources()
    // Sanity: both platform engine blocks were parsed.
    expect(resources.length).toBeGreaterThanOrEqual(2)

    // The packager decides per file: is it matched by the include and not by
    // any exclude? A `!`-prefixed pattern excludes. `**/*` — the include — does
    // not match dotfiles by default, so `!.*` stays as belt-and-braces.
    const ships = (filter: string[], file: string): boolean => {
      let included = false
      for (const pattern of filter) {
        if (pattern.startsWith('!')) {
          if (minimatch(file, pattern.slice(1))) return false
        } else if (minimatch(file, pattern)) {
          included = true
        }
      }
      return included
    }

    for (const resource of resources) {
      // The production filter answers about files UNDER `from`, so probe with
      // paths relative to it — a nested archive, a nested partial, a top-level
      // partial, and the payload that must survive.
      expect(
        ships(resource.filter, 'katago.exe'),
        `${resource.from}: payload must ship`,
      ).toBe(true)
      expect(
        ships(resource.filter, 'nested/nested.zip'),
        `${resource.from}: nested archive must not ship`,
      ).toBe(false)
      expect(
        ships(resource.filter, 'nested/nested.partial'),
        `${resource.from}: nested partial must not ship`,
      ).toBe(false)
      expect(
        ships(resource.filter, 'cache.zip.partial'),
        `${resource.from}: top-level partial must not ship`,
      ).toBe(false)
    }
  })
})
