import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Shared view of the SGF fixture corpus.
 *
 * Extracted because two test files were each deciding independently which
 * fixtures count as "real", by two different rules — one an explicit set of
 * filenames, the other a `gnugo-joseki` filename prefix. They agree on today's
 * corpus and would stop agreeing the moment someone adds a `gnugo-joseki-*`
 * file that *is* valid SGF: it would be silently dropped from the accessor
 * round-trip and never covered by anything. Nothing would fail, which is what
 * makes the drift worth removing rather than documenting.
 */
export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'sgf')

export const allFiles = readdirSync(FIXTURES).filter((f) => f.endsWith('.sgf'))

/** Hand-written fixtures, prefixed `_`, as opposed to files from real tools. */
export const syntheticFiles = allFiles.filter((f) => f.startsWith('_'))

/**
 * Two corpus files are GNU Go *program output*, not SGF: they carry ~21 lines
 * of copyright banner before the first `(`. They are kept because they are a
 * genuine real-world artefact, but they are excluded from round-trip and
 * asserted to be rejected instead.
 *
 * Deliberately not "fixed" by skipping leading junk in the parser. Tolerating
 * arbitrary preamble would blunt SGF_NOT_SGF into uselessness — it must still
 * mean "this is not an SGF file".
 *
 * Listed by name rather than matched by prefix so that adding a real SGF file
 * from the same tool does not silently exclude it.
 */
export const NOT_ACTUALLY_SGF = new Set([
  'gnugo-joseki-hoshi-keima-var.sgf',
  'gnugo-joseki-sansan-var.sgf',
])

/** Files that are genuine SGF and produced by a real tool. */
export const realFiles = allFiles.filter(
  (f) => !f.startsWith('_') && !NOT_ACTUALLY_SGF.has(f),
)

export function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}
