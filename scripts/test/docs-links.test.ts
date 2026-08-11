import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every relative link in `docs/` points at something that exists.
 *
 * The documents in `docs/` are mostly valuable for their pointers — "the reason
 * is at `window.ts:97`" is the whole content of a sentence. A link to a moved
 * file is therefore worse than no link at all: it reads as a citation and sends
 * the reader somewhere that no longer says what the sentence claims. And this
 * rots on its own, without anybody editing the document, the moment a file is
 * renamed.
 *
 * ## What is and is not checked
 *
 * - **Relative paths:** checked. `../apps/desktop/src/main/window.ts` must exist.
 * - **Line fragments** (`#L102`): the *path* is checked, the line number is not.
 *   Checking it would mean asserting a file's length, which fails on every
 *   unrelated edit above that line and would train people to delete the check.
 * - **Heading anchors** (`#llmdelta`): not checked. GitHub derives them from
 *   heading text by a slugging rule, and reimplementing that rule here would be
 *   its own bug surface with its own false failures.
 * - **URLs:** not checked. A test that fails when a network is unavailable is a
 *   test that gets skipped.
 *
 * So this is a link-target existence gate and nothing more. It does not know
 * whether a document is *correct*.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DOCS = join(REPO_ROOT, 'docs')

/** `](./x)` or `](../x)`, stopping at `#`, `)`, or whitespace. */
const RELATIVE_LINK = /\]\((\.\.?\/[^)#\s]*)/g

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...markdownFiles(full))
      continue
    }
    if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

describe('docs/ relative links', () => {
  const files = markdownFiles(DOCS)

  it('finds markdown files to check', () => {
    // Without this, an empty or moved `docs/` makes every per-file assertion
    // below iterate zero times and the suite reports success for a check that
    // examined nothing.
    expect(files.length, `no .md files under ${DOCS}`).toBeGreaterThanOrEqual(6)
  })

  it('finds relative links to check', () => {
    // Same guard, one level down: if the link regex stopped matching, every
    // resolution assertion would pass vacuously.
    const total = files.reduce(
      (sum, file) =>
        sum + [...readFileSync(file, 'utf8').matchAll(RELATIVE_LINK)].length,
      0,
    )
    expect(total, 'no relative links matched — check RELATIVE_LINK').toBeGreaterThan(10)
  })

  for (const file of files) {
    const relative = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')

    it(`${relative} resolves every relative link`, () => {
      const source = readFileSync(file, 'utf8')
      const dir = resolve(file, '..')
      const broken: string[] = []

      for (const match of source.matchAll(RELATIVE_LINK)) {
        const target = match[1]
        if (target === undefined || target === '') continue
        // `existsSync`, not a read: some targets are directories (`./adr/`), and
        // `readFileSync` on a directory throws EISDIR — which would report a
        // correct link as broken.
        const abs = resolve(dir, target)
        if (!existsSync(abs)) broken.push(target)
      }

      expect(
        broken,
        `${relative} links to missing paths: ${broken.join(', ')}`,
      ).toEqual([])
    })
  }
})

describe('docs/ does not reach into agent-workflow directories', () => {
  /**
   * R2 draws a hard boundary around six paths. `docs/` is not app code, so it is
   * not literally covered by the rule against *reading* them — but a link from
   * `docs/` into `.trellis/` is a dangling reference for anyone who cloned the
   * app without the workflow state, which is the intended consumer of `docs/`.
   * Prose may name them; a link must not depend on them.
   */
  const PROTECTED = ['.trellis', '.claude', '.codex', '.qoder', '.agents']

  it('links to none of them', () => {
    const offenders: string[] = []

    for (const file of markdownFiles(DOCS)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(RELATIVE_LINK)) {
        const target = match[1]
        if (target === undefined) continue
        const abs = resolve(file, '..', target)
        const rel = abs.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')
        if (PROTECTED.some((p) => rel === p || rel.startsWith(`${p}/`))) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)} -> ${target}`)
        }
      }
    }

    expect(offenders, `docs/ must stand alone:\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('the docs directory holds what the plan says it holds', () => {
  /**
   * A named-file check, because both of these were listed as deliverables and
   * missing for the whole of Stage 7 without anything noticing. A missing
   * document produces no error anywhere — it is simply absent, which is exactly
   * the class of gap a checklist is bad at catching and a test is good at.
   */
  it.each(['architecture.md', 'ipc-contract.md'])(
    '%s exists and is not a stub',
    (name) => {
      const path = join(DOCS, name)
      expect(existsSync(path), `${name} is missing`).toBe(true)
      // A size floor rather than a content assertion: it catches the empty
      // placeholder that satisfies a checklist, without pretending to judge prose.
      expect(statSync(path).size, `${name} looks like a placeholder`).toBeGreaterThan(
        2000,
      )
    },
  )
})
