/**
 * Mutation harness for the SGF diagnostic caps.
 *
 * Each mutation reintroduces the leak the corresponding test was written for.
 * A mutation that survives means the test does not actually pin the property.
 *
 * The validity gate matters more than the catch count: if a mutation changes the
 * *number* of tests collected, it broke collection rather than behaviour, and a
 * "caught" verdict would be meaningless.
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
}

/**
 * Every path is resolved against the repo root rather than the cwd, and the
 * test run is spawned there too. Run from `packages/core`, the previous
 * repo-root-relative filter matched zero test files, vitest exited 0, and every
 * mutation was reported ESCAPED — a measuring instrument that reads "nothing is
 * tested" as "nothing is broken".
 */
const ROOT = resolve(import.meta.dirname, '..')

const D = 'packages/core/src/sgf/diagnostic.ts'
const P = 'packages/core/src/sgf/props.ts'
const R = 'packages/core/src/sgf/parser.ts'

const mutations: Mutation[] = [
  {
    id: 'D1',
    file: D,
    from: '  if (raw.length <= MAX_QUOTED && COORDINATE_SHAPE.test(raw)) return raw',
    to: '  return raw',
    what: 'describeValue does not cap or shape-check at all',
  },
  {
    id: 'D2',
    file: D,
    from: 'const MAX_QUOTED = 6',
    to: 'const MAX_QUOTED = 100_000',
    what: 'cap raised past any real value',
  },
  {
    id: 'D3',
    file: D,
    from: '    : `<${String(raw.length)} characters>`',
    to: '    : raw.slice(0, MAX_QUOTED)',
    what: 'truncates to a prefix instead of replacing (still leaks bytes)',
  },
  {
    id: 'D4',
    file: D,
    from: "  return text.trimStart()[0] ?? '<empty>'",
    to: '  return text.trimStart().slice(0, 32)',
    what: 'non-SGF start quotes 32 chars again (the original leak)',
  },
  {
    id: 'D5',
    file: D,
    from: '    : `<${String(raw.length)} characters>`',
    to: "    : '<omitted>'",
    what: 'drops the length from the over-cap description',
  },
  {
    id: 'D6',
    file: D,
    from: '  if (raw.length <= MAX_QUOTED && COORDINATE_SHAPE.test(raw)) return raw',
    to: '  if (raw.length <= MAX_QUOTED) return raw',
    what: 'the original bug: length only, so a short password is quoted verbatim',
  },
  {
    id: 'D7',
    file: D,
    from: 'const COORDINATE_SHAPE = /^[a-zA-Z]{1,2}(?::[a-zA-Z]{1,2})?$/',
    to: 'const COORDINATE_SHAPE = /[a-zA-Z]/',
    what: 'shape test unanchored, so anything containing a letter is quoted',
  },
  {
    id: 'D8',
    file: D,
    from: "    ? '<not coordinate-shaped>'",
    to: '    ? raw',
    what: 'the short non-coordinate branch returns the value after all',
  },
  {
    id: 'P1',
    file: P,
    from: '      `point ${JSON.stringify(shown)} is not on the board`',
    to: '      `point ${JSON.stringify(raw)} is not on the board`',
    what: 'point message quotes the raw value',
  },
  {
    id: 'P2',
    file: P,
    from: '      { cause: error, context: { value: shown } },',
    to: '      { cause: error, context: { value: raw } },',
    what: 'point context carries the raw value',
  },
  {
    id: 'P3',
    file: P,
    from: '      `move ${JSON.stringify(shown)} is not on the board`',
    to: '      `move ${JSON.stringify(raw)} is not on the board`',
    what: 'move message quotes the raw value',
  },
  {
    id: 'P4',
    file: P,
    from: '        context: { ident: describeValue(property.rawIdent), value: shown },',
    to: '        context: { ident: property.rawIdent, value: raw },',
    what: 'move context carries raw ident and value',
  },
  {
    id: 'P5',
    file: P,
    from: '      `board size ${shown} is not 9, 13, or 19`',
    to: '      `board size ${raw} is not 9, 13, or 19`',
    what: 'board-size message quotes the raw value',
  },
  {
    id: 'P6',
    file: P,
    from: '        context: { size: shown },\n      },\n    )\n  }\n  return parsed.data',
    to: '        context: { size: raw },\n      },\n    )\n  }\n  return parsed.data',
    what: 'board-size context carries the raw value',
  },
  {
    id: 'P7',
    file: D,
    from: "  return Number.isFinite(numeric) ? String(numeric) : '<not a number>'",
    to: '  return raw',
    what: 'describeNumeric returns the raw value instead of describing it',
  },
  {
    id: 'P8',
    file: D,
    from: "  return Number.isFinite(numeric) ? String(numeric) : '<not a number>'",
    to: "  return '<not a number>'",
    what: 'describeNumeric never reports the number, so the diagnostic says nothing',
  },
  {
    id: 'P9',
    file: P,
    from: "      const shown = `${describeNumeric(width ?? '')}:${describeNumeric(height ?? '')}`",
    to: '      const shown = describeValue(raw)',
    what: 'rectangular-board diagnostic goes back to describeValue, which is built for coordinates',
  },
  {
    id: 'R1',
    file: R,
    from: '      context: { firstChar: describeNonSgfStart(text) },',
    to: '      context: { firstChars: text.slice(0, 32) },',
    what: 'non-SGF context quotes 32 chars at the call site',
  },
  {
    id: 'R2',
    file: R,
    from: '        `property ${describeValue(rawIdent)} has no value`',
    to: '        `property ${rawIdent} has no value`',
    what: 'valueless-property message quotes the raw ident',
  },
]

function run(): { total: number; failed: number } {
  try {
    const out = execSync(
      'npx vitest run --project core test/sgf/props.test.ts test/sgf/round-trip.test.ts --reporter=basic',
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
  const totalMatch = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out)
  if (totalMatch === null) return { total: -1, failed: -1 }
  const failed = totalMatch[1] === undefined ? 0 : Number(totalMatch[1])
  const passed = Number(totalMatch[2])
  return { total: failed + passed, failed }
}

const baseline = run()
console.log(
  `baseline: ${String(baseline.total)} tests, ${String(baseline.failed)} failed\n`,
)

// A baseline that did not parse (total -1) or is not green is not a baseline.
// Without this, a filter matching no test files yields -1, every mutation
// compares equal to it, and the summary line still reports a plausible
// "0 escaped" — the vacuous pass this harness exists to detect, in the harness
// itself.
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
  } else if (result.failed > 0) {
    results.push(`${m.id}  caught (${String(result.failed)} failed)  ${m.what}`)
  } else {
    results.push(`${m.id}  ESCAPED  ${m.what}`)
  }
  console.log(results[results.length - 1])
}

const caught = results.filter((r) => r.includes(' caught ')).length
const escaped = results.filter((r) => r.includes(' ESCAPED ')).length
const invalid = results.filter(
  (r) => r.includes('INVALID') || r.includes('ANCHOR-BAD'),
).length
console.log(
  `\n${String(caught)}/${String(mutations.length)} caught, ${String(escaped)} escaped, ${String(invalid)} invalid`,
)
