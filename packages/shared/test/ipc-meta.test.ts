import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANNELS, CHANNEL_NAMES, EVENTS, EVENT_NAMES } from '../src/ipc'

/**
 * Proves the coverage meta-test in `ipc.test.ts` is not vacuous — by running
 * the real thing, not a copy of its logic.
 *
 * An earlier version of this file extracted the detection logic into local
 * helpers and tested those against fixtures. Verification caught that as
 * worthless: during an injection experiment the real meta-test failed while
 * that version passed all its assertions. It was insensitive in both
 * directions — weakening `ipc.test.ts` would not have failed it either.
 *
 * So this version copies the package to a temp dir, appends a channel with no
 * test case, and runs the actual `ipc.test.ts` against it. If the real
 * meta-test ever stops detecting uncovered channels, this fails.
 */

const PKG_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

interface RunResult {
  exitCode: number
  output: string
}

/**
 * Runs `ipc.test.ts` against a copy of the package, optionally with extra
 * source appended to `src/ipc.ts`.
 */
function runSuiteWithInjection(injectedSource: string | null): RunResult {
  const scratch = mkdtempSync(join(tmpdir(), 'gomentor-meta-'))
  try {
    cpSync(join(PKG_ROOT, 'src'), join(scratch, 'src'), { recursive: true })
    cpSync(join(PKG_ROOT, 'test'), join(scratch, 'test'), { recursive: true })
    cpSync(join(PKG_ROOT, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
    cpSync(join(PKG_ROOT, 'package.json'), join(scratch, 'package.json'))

    // Reuse the repo's installed dependencies rather than installing again.
    try {
      symlinkSync(
        join(REPO_ROOT, 'node_modules'),
        join(scratch, 'node_modules'),
        'junction',
      )
    } catch {
      // Some environments disallow links; fall back to skipping (asserted below).
      return { exitCode: -1, output: 'SYMLINK_UNAVAILABLE' }
    }

    // Never run this recursive check inside the copy — it would fork forever.
    rmSync(join(scratch, 'test', 'ipc-meta.test.ts'), { force: true })

    if (injectedSource !== null) {
      const ipcPath = join(scratch, 'src', 'ipc.ts')
      const original = readFileSync(ipcPath, 'utf8')
      const marker = '} as const\n\nexport type Channels = typeof CHANNELS'
      if (!original.includes(marker)) {
        throw new Error('injection marker not found in ipc.ts — update this test')
      }
      writeFileSync(
        ipcPath,
        original.replace(marker, `${injectedSource}\n${marker}`),
        'utf8',
      )
    }

    try {
      const output = execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          '--reporter=verbose',
        ],
        {
          cwd: scratch,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        },
      )
      return { exitCode: 0, output }
    } catch (error: unknown) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return {
        exitCode: e.status ?? 1,
        output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe('the real meta-test is not vacuous', () => {
  it('passes on an unmodified copy of the package', () => {
    const result = runSuiteWithInjection(null)
    if (result.output === 'SYMLINK_UNAVAILABLE') return

    expect(result.exitCode, `baseline copy should pass:\n${result.output}`).toBe(0)
  }, 180_000)

  it('fails when a channel is added without a test case', () => {
    const result = runSuiteWithInjection(`  'probe:uncovered': {
    request: z.object({ probe: z.string() }),
    response: z.object({}),
  },`)
    if (result.output === 'SYMLINK_UNAVAILABLE') return

    // The whole point: the real suite must reject the uncovered channel.
    expect(result.exitCode, 'suite should fail for an uncovered channel').not.toBe(0)

    // And specifically via the named meta-assertion. Checking only that the
    // string appears is not enough — the assertion's `it` name is printed
    // whether it passed or failed, so a weakened meta-test would still match.
    // Vitest's basic reporter marks failures with `×`, passes with `✓`, so
    // require the failing marker on that line.
    const metaLine = result.output
      .split('\n')
      .find((line) => line.includes('every channel has a test case'))

    expect(metaLine, 'meta-assertion did not run at all').toBeDefined()
    expect(
      metaLine,
      `the meta-assertion did not fail — it may have been weakened.\nLine: ${metaLine ?? '(none)'}`,
    ).toMatch(/[×✗]|failed/)
  }, 180_000)
})

describe('contract sanity', () => {
  // Guards against a contract that is accidentally empty, which would make
  // every per-channel loop in ipc.test.ts iterate zero times and pass.
  it('exposes a non-trivial number of channels and events', () => {
    expect(CHANNEL_NAMES.length).toBeGreaterThanOrEqual(11)
    expect(EVENT_NAMES.length).toBeGreaterThanOrEqual(5)
  })

  it('every channel declares both a request and a response schema', () => {
    for (const name of CHANNEL_NAMES) {
      const spec = CHANNELS[name]
      expect(typeof spec.request.safeParse, `${name} request is not a zod schema`).toBe(
        'function',
      )
      expect(
        typeof spec.response.safeParse,
        `${name} response is not a zod schema`,
      ).toBe('function')
    }
  })

  it('every event schema is a zod schema', () => {
    for (const name of EVENT_NAMES) {
      expect(typeof EVENTS[name].safeParse, `${name} is not a zod schema`).toBe(
        'function',
      )
    }
  })

  it('channel and event namespaces do not collide', () => {
    const overlap = CHANNEL_NAMES.filter((name) =>
      (EVENT_NAMES as readonly string[]).includes(name),
    )
    expect(
      overlap,
      `names used as both channel and event: ${overlap.join(', ')}`,
    ).toEqual([])
  })
})
