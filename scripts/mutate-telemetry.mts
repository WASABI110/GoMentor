/**
 * Mutation harness for the local-only telemetry layer (M5 Stage 2).
 *
 * Telemetry is the one module where "wrong but looks right" failures are
 * policy failures, not bugs: an `uploadToServer` that crept to `true`, a
 * consent gate that stopped gating, an event log that started carrying free
 * text. Each mutation below breaks one such property and requires a specific
 * test in `test/unit/telemetry.test.ts` to notice — per the repo rule, every
 * entry names the test that catches it *before* the harness run, and a mutant
 * whose discriminating case does not exist is an escape in waiting.
 *
 * Same validity gate as every harness in this directory: a baseline that is
 * not green, or green with zero tests, aborts the whole run (an instrument
 * measuring nothing reports `0 escaped`); a mutated run whose test total
 * differs from baseline is INVALID rather than caught; any escape or anchor
 * mismatch exits non-zero — the exit code is the gate, not the summary.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const T = 'apps/desktop/src/main/telemetry.ts'

interface Mutation {
  readonly id: string
  readonly file: string
  readonly what: string
  readonly from: string
  readonly to: string
}

const MUTATIONS: Mutation[] = [
  // The whole transport policy. Discriminated by "starts Electron crash
  // reporting with uploads hard-disabled", which asserts uploadToServer ===
  // false against the injected spy.
  {
    id: 'T1',
    file: T,
    what: 'enable crash uploads (the transport policy, silently reversed)',
    from: '    uploadToServer: false,',
    to: '    uploadToServer: true,',
  },
  // Discriminated by "unconsented: no crash reporter, no files, disabled".
  {
    id: 'T2',
    file: T,
    what: 'ignore the consent gate (collect without permission)',
    from: '  return deps.consented ? createLocalTelemetry(deps) : createNoopTelemetry()',
    to: '  return createLocalTelemetry(deps)',
  },
  // Discriminated by the same consent-gate test: without the early return the
  // factory would still start the reporter for an unconsented user.
  {
    id: 'T3',
    file: T,
    what: 'start the crash reporter before checking consent',
    from: '  return deps.consented ? createLocalTelemetry(deps) : createNoopTelemetry()',
    to: '  return createNoopTelemetry()',
  },
  // Discriminated by "every written line is closed-union scalars plus ts": a
  // free-form context field is the content channel the closed union prevents.
  {
    id: 'T4',
    file: T,
    what: 'append a free-form context blob to each line (the content channel)',
    from: '      const line = `${JSON.stringify({ ...event, ts: deps.now() })}\\n`',
    to: '      const line = `${JSON.stringify({ ...event, ts: deps.now(), context: String(event) })}\\n`',
  },
  // Discriminated by "a small log is appended, not rotated" — an off-by-one
  // rotation would rename on every append and lose the current generation.
  {
    id: 'T5',
    file: T,
    what: 'rotate on every append (comparison removed)',
    from: '        if (size > MAX_LOG_BYTES) {',
    to: '        if (size >= 0) {',
  },
  // Discriminated by "unconsented: ... disabled" / "no way to flip consent":
  // enabled must reflect what actually happened, not optimism.
  {
    id: 'T6',
    file: T,
    what: 'report the noop as enabled (a lie a reader may trust)',
    from: `    // Hardcoded \`false\`. The noop instance exists precisely because nothing is
    // collected; reporting \`true\` would be a lie a future reader might take as
    // evidence the wiring exists.
    enabled: false,`,
    to: `    enabled: true,`,
  },
  // Discriminated by "a write failure is swallowed, not thrown" — telemetry
  // must never take the app down with it.
  {
    id: 'T7',
    file: T,
    what: 'let a telemetry write failure propagate to the caller',
    from: '    } catch (error) {\n      // Telemetry must never take the app down with it: a full disk or a',
    to: '    } catch (error) {\n      throw error\n      // Telemetry must never take the app down with it: a full disk or a',
  },
]

interface SuiteResult {
  total: number
  failed: number
  ok: boolean
}

function runSuite(): SuiteResult {
  let output: string
  let ok: boolean
  try {
    output = execFileSync(
      'pnpm',
      [
        'vitest',
        'run',
        '--project',
        'desktop',
        'test/unit/telemetry',
        '--reporter',
        'basic',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      },
    )
    ok = true
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string }
    output = (shaped.stdout ?? '') + (shaped.stderr ?? '')
    ok = false
  }
  const parsed = parse(output)
  return { total: parsed.total, failed: parsed.failed, ok }
}

function parse(output: string): { total: number; failed: number } {
  const clean = output.replace(ANSI, '')
  const totalMatch =
    /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)/.exec(
      clean,
    )
  if (totalMatch === null) {
    // No summary line at all means collection failed — a syntax error, not a
    // behavioural difference. Reported as total 0 so the gate marks it INVALID.
    return { total: 0, failed: 0 }
  }
  return {
    total: Number(totalMatch[4]),
    failed: Number(totalMatch[1] ?? 0),
  }
}

const baseline = runSuite()
console.log(
  `baseline: ${String(baseline.total)} tests, ${String(baseline.failed)} failed`,
)
// The gate: not green, or measuring nothing — either way every per-mutation
// verdict below would be fiction.
if (!baseline.ok || baseline.failed > 0 || baseline.total <= 0) {
  console.log('BASELINE IS NOT GREEN — aborting, every result would be meaningless')
  process.exit(1)
}

const results: string[] = []
for (const mutation of MUTATIONS) {
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  const occurrences = original.split(mutation.from).length - 1
  if (occurrences !== 1) {
    results.push(
      `${mutation.id}  ANCHOR NOT UNIQUE (${String(occurrences)} matches)  ${mutation.what}`,
    )
    continue
  }

  writeFileSync(path, original.replace(mutation.from, mutation.to), 'utf8')
  try {
    const result = runSuite()
    if (result.total !== baseline.total) {
      // The gate. A mutation that changes the test count broke collection.
      results.push(
        `${mutation.id}  INVALID (${String(result.total)} tests vs ${String(baseline.total)})  ${mutation.what}`,
      )
    } else if (result.failed > 0) {
      results.push(
        `${mutation.id}  caught (${String(result.failed)} failed)  ${mutation.what}`,
      )
    } else {
      results.push(`${mutation.id}  *** ESCAPED ***  ${mutation.what}`)
    }
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  console.log(results[results.length - 1])
}

console.log('\n===== SUMMARY =====')
for (const line of results) console.log(line)
const escaped = results.filter((line) => line.includes('ESCAPED')).length
const invalid = results.filter(
  (line) => line.includes('INVALID') || line.includes('ANCHOR'),
).length
console.log(
  `\n${String(results.length - escaped - invalid)}/${String(results.length)} caught, ${String(escaped)} escaped, ${String(invalid)} invalid`,
)
// An anchor that matched ≠1 site is drift in this harness, not a neutral
// result, and an escaped mutant is the finding the whole run exists for. Either
// fails the gate: the exit code is what CI and the stage checklist consume.
if (escaped > 0 || invalid > 0) {
  console.log('MUTATION GATE FAILED — an instrument reporting itself is not green.')
  process.exit(1)
}
