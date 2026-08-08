/**
 * Mutation harness for the SGF encoding-detection and text-decoding rules.
 *
 * Every mutation here restores a bug that was live and green until the Stage 3
 * verification pass found it. The A5 round-trip suite passed with all six
 * legacy-encoded corpus files being silently rewritten, because its baseline
 * was decoded with the parser's *own* choice of decoder — so a wrong decoder
 * made the expectation wrong in the same direction. These mutations exist to
 * prove the replacement assertions do not share that flaw.
 *
 * The validity gate matters more than the catch count: a mutation that changes
 * the number of tests collected broke collection, not behaviour, and "caught"
 * would be meaningless.
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

const PARSER = 'packages/core/src/sgf/parser.ts'
const PROPS = 'packages/core/src/sgf/props.ts'
const SER = 'packages/core/src/sgf/serializer.ts'

const mutations: Mutation[] = [
  {
    id: 'E1',
    file: PARSER,
    from: '          encoding = UNKNOWN_ENCODING\n          text = provisional',
    to: "          encoding = 'utf-8'\n          text = decode(body, 'utf-8')",
    what: 'the original bug: no-CA falls through to utf-8 and rewrites 6 files',
  },
  {
    id: 'E2',
    file: PARSER,
    from: "  return isValidUtf8(bytes) ? 'utf-8' : null",
    to: "  return 'utf-8'",
    what: 'sniff always claims utf-8 without checking validity',
  },
  {
    id: 'E3',
    file: PARSER,
    from: "  return isValidUtf8(bytes) ? 'utf-8' : null",
    to: "  return isValidUtf8(bytes) ? 'gbk' : null",
    what: 'valid utf-8 decoded as gbk',
  },
  {
    id: 'E4',
    file: PARSER,
    from: "    new TextDecoder('utf-8', { fatal: true }).decode(bytes)\n    return true",
    to: "    new TextDecoder('utf-8', { fatal: false }).decode(bytes)\n    return true",
    what: 'utf-8 validity check is non-fatal, so everything looks valid',
  },
  {
    id: 'E5',
    file: PARSER,
    from: '  return isDecoderLabel(label) ? label : UNKNOWN_ENCODING',
    to: '  return label',
    what: 'an unknown CA label passes through and breaks TextDecoder downstream',
  },
  {
    id: 'E6',
    file: SER,
    from: '  if (encoding === UNKNOWN_ENCODING) {',
    to: '  if (false as boolean) {',
    what: 'serialiser no longer refuses an undetermined encoding',
  },
  {
    id: 'E7',
    file: PARSER,
    from: "  if (encoding === UNKNOWN_ENCODING) {\n    return new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes)\n  }",
    to: '',
    what: 'decode() no longer special-cases the sentinel',
  },
  {
    id: 'T1',
    file: PROPS,
    from: "      out += /\\s/.test(next) ? ' ' : next",
    to: '      out += next',
    what: 'escaped whitespace inserted verbatim, violating FF[4] 3.2',
  },
  {
    id: 'T2',
    file: PROPS,
    from: "      out += /\\s/.test(next) ? ' ' : next",
    to: "      out += /\\s/.test(next) ? '' : next",
    what: 'escaped whitespace dropped instead of folded to a space',
  },
  {
    id: 'T3',
    file: PROPS,
    from: "    out += char === undefined ? '' : /\\s/.test(char) ? ' ' : char",
    to: "    out += char === undefined ? '' : char",
    what: 'unescaped whitespace no longer folded',
  },
  {
    id: 'T4',
    file: PROPS,
    from: "      out += kind === 'text' ? '\\n' : ' '",
    to: "      out += '\\n'",
    what: 'SimpleText keeps a hard newline instead of folding to a space',
  },
  {
    id: 'D1',
    file: PARSER,
    from: 'const MAX_TREE_DEPTH = 512',
    to: 'const MAX_TREE_DEPTH = 4',
    what: 'depth limit low enough to reject real corpus files',
  },
]

function run(): { total: number; failed: number } {
  try {
    const out = execSync('npx vitest run --project core test/sgf --reporter=basic', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
