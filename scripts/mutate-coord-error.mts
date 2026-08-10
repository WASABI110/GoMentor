/**
 * Mutation harness for `CoordError`'s code and message bounds.
 *
 * Separate from `mutate-diagnostic.mts` because it covers `board/`, not `sgf/`,
 * and runs a different test file — but the shape and the validity gate are the
 * same. Each mutation reintroduces the defect the corresponding test exists to
 * catch; a survivor means the test does not actually pin the property.
 *
 * The defect these guard against was live: `fromSgf` interpolated raw file text
 * into an unbounded message, `props.ts` attached it as `cause`, and
 * `logging-guidelines.md:54` logs `cause` in main. A 4000-character `AB[…]`
 * produced a 4058-character `cause` carrying the file's text verbatim, against
 * line 76's "SGF content or game records" prohibition.
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

interface Mutation {
  id: string
  file: string
  from: string
  to: string
  what: string
  /**
   * A control: a change that *should* leave every test green. Without marking
   * these, a control and a genuine miss both read as "ESCAPED" and the summary
   * has to be interpreted by hand rather than being pass/fail. Inverted here, so
   * a control that gets caught is itself a failure — it means the mutation was
   * not the no-op it claims to be, and the conclusion drawn from its paired
   * mutation does not follow.
   */
  control?: true
}

/**
 * Paths resolve against the repo root and the test run is spawned there, so the
 * harness cannot be made vacuous by the cwd it is invoked from. See
 * `mutate-diagnostic.mts` for the failure this prevents.
 */
const ROOT = resolve(import.meta.dirname, '..')

const C = 'packages/core/src/board/coords.ts'
const Z = 'packages/core/src/board/zobrist.ts'
const P = 'packages/core/src/sgf/props.ts'

const CAP = `  return value.length <= 8
    ? JSON.stringify(value)
    : \`<\${String(value.length)} characters>\``

const mutations: Mutation[] = [
  {
    id: 'C1',
    file: C,
    from: CAP,
    to: '  return JSON.stringify(value)',
    what: 'the cap is removed, so raw file text reaches cause again (the original leak)',
  },
  {
    id: 'C2',
    file: C,
    from: '  return value.length <= 8',
    to: '  return value.length <= 8000',
    what: 'cap raised past any realistic value, so it never engages',
  },
  {
    id: 'C3',
    file: C,
    from: '    : `<${String(value.length)} characters>`',
    to: '    : JSON.stringify(value.slice(0, 8))',
    what: 'truncates to a prefix instead of replacing, which still leaks bytes',
  },
  {
    id: 'C4',
    file: C,
    from: '    ? JSON.stringify(value)',
    to: "    ? '<value>'",
    what: 'a short value is redacted too, so the diagnostic no longer names the point',
  },
  {
    id: 'C5',
    file: C,
    from: "    this.code = 'BOARD_INVALID_COORD'",
    to: "    this.code = 'SGF_INVALID_PROPERTY'",
    what: 'the original mislabel: a board module reports a malformed file',
  },
  {
    id: 'C6',
    file: C,
    from: '      `SGF coordinate must be 2 chars, got ${describeCoordValue(value)}`',
    to: '      `SGF coordinate must be 2 chars, got ${JSON.stringify(value)}`',
    what: 'the length-2 branch quotes the raw value, bypassing the cap',
  },
  {
    id: 'C7',
    file: C,
    from: "    this.code = 'BOARD_INVALID_COORD'",
    to: "    this.code = 'BOARD_INVALID_COORD'\n    void 0",
    // A no-op, to prove C5's kill comes from the code value and not from merely
    // editing that line — the anchor sits inside a constructor a great many
    // tests execute, so an escape here would say the line is load-bearing for
    // reasons unrelated to what C5 claims to test.
    what: 'control: touching the same line without changing the code must escape',
    control: true,
  },
  {
    id: 'P1',
    file: P,
    from: '    if (isAppError(error)) throw error',
    to: '    if (isAppError(error) || error instanceof Error) throw error',
    what: 'props.ts stops converting, so a file-sourced bad coord escapes as BOARD_INVALID_COORD',
  },
  {
    id: 'Z1',
    file: Z,
    from: 'const MAX_SIZE = 19',
    to: 'const MAX_SIZE = 18',
    what: "the key table is too small, making zobrist.ts's 'unreachable' guard reachable",
  },
]

/**
 * Deliberately not a mutation: swapping `zobrist.ts`'s `new CoordError` back to
 * `new Error`. That throw sits in provably dead code — `toIndex` rejects any
 * coord whose flat index could exceed the table — so no test can reach it and
 * every such mutation escapes by construction. Listing it would have inflated
 * the denominator with a check the suite cannot make, which is the same
 * false-confidence this harness exists to prevent. `Z1` covers the part that is
 * real: that the table is in fact large enough for every reachable index, which
 * is what makes the branch dead in the first place. The `CoordError` choice
 * there is enforced by review, not by tests, and should be described as such.
 */

function run(): { total: number; failed: number } {
  try {
    const out = execSync(
      'npx vitest run --project core test/board test/sgf --reporter=basic',
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return parse(out)
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string }
    return parse((e.stdout ?? '') + (e.stderr ?? ''))
  }
}

function parse(raw: string): { total: number; failed: number } {
  const out = raw.replace(ANSI, '')
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out)
  if (m === null) return { total: -1, failed: -1 }
  const failed = m[1] === undefined ? 0 : Number(m[1])
  return { total: failed + Number(m[2]), failed }
}

const baseline = run()
console.log(
  `baseline: ${String(baseline.total)} tests, ${String(baseline.failed)} failed\n`,
)
// A baseline that did not parse (total -1) or is not green is not a baseline.
// Without this, a filter matching no test files yields -1, every mutation
// compares equal to it, and the summary still reports a plausible "0 escaped".
if (baseline.total <= 0 || baseline.failed > 0) {
  console.error('baseline is not a green test run; refusing to report mutation results')
  process.exit(1)
}

const results: string[] = []
for (const m of mutations) {
  const original = readFileSync(join(ROOT, m.file), 'utf8')
  const occurrences = original.split(m.from).length - 1
  if (occurrences !== 1) {
    // Logged, not just recorded: an anchor that matches nothing is the failure
    // mode that looks like success, because the mutation never ran and the
    // summary line still says "0 escaped".
    results.push(`${m.id}  ANCHOR-BAD (${String(occurrences)} matches)  ${m.what}`)
    console.log(results[results.length - 1])
    continue
  }
  writeFileSync(join(ROOT, m.file), original.replace(m.from, m.to))
  const result = run()
  writeFileSync(join(ROOT, m.file), original)

  if (result.total !== baseline.total) {
    results.push(
      `${m.id}  INVALID (${String(result.total)} tests vs ${String(baseline.total)})  ${m.what}`,
    )
  } else if (m.control === true) {
    // Inverted for controls: green is the expected outcome, and a failure means
    // the "no-op" was not one.
    results.push(
      result.failed > 0
        ? `${m.id}  CONTROL-BROKEN (${String(result.failed)} failed)  ${m.what}`
        : `${m.id}  control ok  ${m.what}`,
    )
  } else if (result.failed > 0) {
    results.push(`${m.id}  caught (${String(result.failed)} failed)  ${m.what}`)
  } else {
    results.push(`${m.id}  ESCAPED  ${m.what}`)
  }
  console.log(results[results.length - 1])
}

/**
 * Statuses are matched as a leading field rather than by substring. A previous
 * version used `r.includes('INVALID')`, which matched the *description* of the
 * `BOARD_INVALID_COORD` mutation and reported "1 invalid" on a clean run — a
 * summary line that disagreed with every row above it.
 */
function status(row: string): string {
  const field = row.split('  ')[1] ?? ''
  // `split` always yields at least one element, so `[0]` is only optional to the
  // type checker. `?? ''` states the same thing the `!` would, without the `!`.
  return field.split(' (')[0] ?? ''
}

const controls = mutations.filter((m) => m.control === true).length
const real = mutations.length - controls
const caught = results.filter((r) => status(r) === 'caught').length
const escaped = results.filter((r) => status(r) === 'ESCAPED').length
const controlOk = results.filter((r) => status(r) === 'control ok').length
const invalid = results.filter((r) =>
  ['INVALID', 'ANCHOR-BAD', 'CONTROL-BROKEN'].includes(status(r)),
).length
console.log(
  `\n${String(caught)}/${String(real)} caught, ${String(escaped)} escaped, ` +
    `${String(controlOk)}/${String(controls)} controls ok, ${String(invalid)} invalid`,
)
