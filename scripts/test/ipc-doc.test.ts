import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANNEL_NAMES, EVENT_NAMES } from '../../packages/shared/src/ipc'

/**
 * Keeps `docs/ipc-contract.md` honest about *which* channels exist.
 *
 * `implement.md` asks for a channel reference "checked against `ipc.ts`". A
 * document that merely claims to be checked is the exact failure this project
 * keeps finding — a gate that cannot fail. So the claim is enforced here, in
 * both directions: an undocumented channel fails, and a documented channel that
 * no longer exists fails too. One direction alone is not enough. Checking only
 * that every channel is documented lets deleted channels accumulate in the doc
 * forever, and a reader cannot tell a stale entry from a real one.
 *
 * ## Why this lives in `scripts/test/` and must not move back
 *
 * It was written under `packages/shared/test/` — the package whose contract it
 * checks — and that broke `ipc-meta.test.ts`. That meta-test copies
 * `packages/shared` to a temp directory and runs its suite there to prove it is not
 * vacuous; this file reads `docs/ipc-contract.md`, which does not exist in the copy,
 * so all five assertions failed inside the copy and the meta-test reported the
 * package as broken.
 *
 * The lesson is a boundary, not an accident: **a test under `packages/*` may depend
 * only on that package**, because the package is copied and run in isolation. A gate
 * whose subject is a repo-root document belongs with the repo tooling, which is what
 * `scripts/vitest.config.ts` says in its own header.
 *
 * ## What this cannot check
 *
 * Whether the prose is *true*. Nothing here notices that `llm:cancel` grew a
 * second argument or that an event stopped being emitted. This test is a
 * completeness gate on names, in the same sense that key-set comparison was a
 * completeness gate on translations — and that one passed for five entirely
 * untranslated namespaces. Treat a green run here as "no channel is missing
 * from the doc", never as "the doc is correct".
 *
 * The doc deliberately does not restate field lists, which is what keeps that
 * gap small: a copied schema drifts silently, so payload shapes are named and
 * linked rather than reproduced.
 *
 * ## Why headings and not any mention
 *
 * Names are collected from `### ` headings only. Prose all over the document
 * mentions channels inline, so accepting any backticked occurrence would let a
 * passing sentence stand in for an entry — the document would satisfy the test
 * while documenting nothing.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DOC_PATH = join(REPO_ROOT, 'docs', 'ipc-contract.md')

/** `### \`domain:verb\`` and nothing else. */
const HEADING = /^### `([a-z]+:[A-Za-z]+)`\s*$/gm

function documentedNames(): string[] {
  const source = readFileSync(DOC_PATH, 'utf8')
  return [...source.matchAll(HEADING)].map((match) => match[1] ?? '')
}

describe('docs/ipc-contract.md', () => {
  it('is where this test thinks it is', () => {
    // Checked separately so a moved or renamed document reports itself rather
    // than surfacing as "every channel is undocumented", which would send the
    // reader looking at `ipc.ts`.
    expect(() => readFileSync(DOC_PATH, 'utf8'), `not found: ${DOC_PATH}`).not.toThrow()
  })

  it('extracts a non-trivial number of entries', () => {
    // Guards the regex itself. If a formatting change stopped it matching, the
    // "no extra entries" assertion below would pass vacuously.
    expect(documentedNames().length).toBeGreaterThanOrEqual(
      CHANNEL_NAMES.length + EVENT_NAMES.length,
    )
  })

  it('documents every channel and event in the contract', () => {
    const documented = new Set(documentedNames())
    const missing = [...CHANNEL_NAMES, ...EVENT_NAMES].filter(
      (name) => !documented.has(name),
    )

    expect(
      missing,
      `undocumented in docs/ipc-contract.md — add a "### \`name\`" section for each: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('documents nothing the contract does not have', () => {
    const real = new Set<string>([...CHANNEL_NAMES, ...EVENT_NAMES])
    const stale = documentedNames().filter((name) => !real.has(name))

    expect(
      stale,
      `documented but absent from CHANNELS/EVENTS — remove the section or restore the channel: ${stale.join(', ')}`,
    ).toEqual([])
  })

  it('documents each name exactly once', () => {
    // Two sections for one channel means two descriptions to keep in step, and
    // the reader has no way to tell which is current.
    //
    // Spelled out rather than `filter((name) => !seen.add(name))`, which is what
    // this was and which could not fail: `Set.prototype.add` returns the *set*,
    // so the predicate was `!truthy` — always false — and a duplicated section
    // passed. Caught by mutation, not by review.
    const seen = new Set<string>()
    const duplicated = documentedNames().filter((name) => {
      if (seen.has(name)) return true
      seen.add(name)
      return false
    })

    expect(duplicated, `duplicate sections: ${duplicated.join(', ')}`).toEqual([])
  })
})
