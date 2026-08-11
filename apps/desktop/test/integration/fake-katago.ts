import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import {
  parseResponse,
  splitResponseBlocks,
  type GtpResponse,
} from '@gomentor/core/katago/gtp'

/**
 * Spawns the fake KataGo child and frames its output with the **real** parser.
 *
 * `design.md` specifies a real spawned child rather than a mock, because what
 * breaks in engine integration is pipes, framing, and exit handling — none of
 * which a mock object touches. M2 builds `main/katago/process.ts` against this;
 * the harness lands now so that when M2 starts, the protocol side is already
 * known-good and the remaining risk is process lifecycle alone.
 *
 * ## The framing comes from `gtp.ts`, not from here
 *
 * `splitResponseBlocks` and `parseResponse` are imported from `@gomentor/core`.
 * That is load-bearing and not a convenience: a harness that framed responses with
 * its own `indexOf('\n\n')` would be a second implementation of the thing under
 * test, and the two would agree with each other while both being wrong. This
 * project has already paid for that lesson once — a 44-fixture sweep built its own
 * copy of the SGF adapter, and gutting the real one left 784 tests green.
 *
 * So `next()` returns whatever the production parser makes of the child's bytes. If
 * `gtp.ts` regresses, every test using this harness notices.
 *
 * ## Child, not in-process
 *
 * The child is a separate file (`fake-katago-child.ts`) rather than this one behind
 * an `import.meta.url === argv[1]` guard. The guard would work, but the cost of
 * getting it wrong is a test process that blocks forever reading its own stdin, and
 * module-scope side effects have burned this suite before — a `makeUserDataDir()`
 * call in a describe body ran during Playwright's collection pass, where no hook
 * exists to clean up after it. Two files have no such failure mode.
 */

const CHILD = join(import.meta.dirname, 'fake-katago-child.ts')

export interface FakeKataGoOptions {
  /**
   * Fault flags passed to the child. See `fake-katago-child.ts` for the list —
   * `--crash-after=N`, `--hang-on=CMD`, `--garbage-on=CMD`,
   * `--unterminated-on=CMD`, `--delay-ms=N`, `--stderr-noise`.
   */
  readonly args?: readonly string[]
}

export interface FakeKataGo {
  readonly pid: number | undefined
  /** Writes a command line, appending the newline GTP requires. */
  send: (command: string) => void
  /**
   * Resolves with the next complete response block, parsed by `gtp.ts`.
   *
   * Rejects on timeout rather than hanging: a hung `await` in a test reports as
   * the whole file timing out with no indication of which call was waiting.
   */
  next: (timeoutMs?: number) => Promise<GtpResponse>
  /** The next complete block, unparsed. For asserting on bytes and framing. */
  nextRaw: (timeoutMs?: number) => Promise<string>
  /** Everything the child has written to stderr so far. */
  stderr: () => string
  /** Resolves when the child exits. Never rejects. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Kills the child if it is still running, then waits for exit. */
  close: () => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 5_000

export function spawnFakeKataGo(options: FakeKataGoOptions = {}): FakeKataGo {
  /**
   * `process.execPath` with tsx as a loader — never `tsx` or `npx` directly.
   *
   * Measured on Windows, and both obvious spellings fail: `spawn('npx', …)` is
   * ENOENT because `npx` is `npx.cmd`, which is not something `exec` can run, and
   * `spawn('npx.cmd', …)` is EINVAL since Node's CVE-2024-27980 fix refused to
   * spawn `.cmd` without a shell. Both fail with a non-zero status and no output,
   * so a harness spawned that way reports its subject as broken when it never
   * started. `shell: true` works but earns a DEP0190 warning on every call.
   */
  // Annotated, not asserted: all three stdio slots are `'pipe'`, so TypeScript
  // already infers non-null streams. An `as` here would have been a claim rather
  // than a check, and would keep compiling if the stdio config ever changed.
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD, ...(options.args ?? [])],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )

  /** Complete blocks the child has emitted but nobody has consumed yet. */
  const pending: string[] = []
  /** Consumers waiting on a block that has not arrived. */
  const waiting: ((block: string) => void)[] = []
  let remainder = ''
  let stderrText = ''
  let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    // Framed by the production splitter, on an accumulating buffer: a chunk
    // boundary landing mid-response is the normal case over a pipe, not an edge
    // case, and `remainder` is what makes it work.
    const { blocks, remainder: rest } = splitResponseBlocks(remainder + chunk)
    remainder = rest
    for (const block of blocks) {
      const consumer = waiting.shift()
      if (consumer === undefined) pending.push(block)
      else consumer(block)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => {
        closed = { code, signal }
        resolve({ code, signal })
      })
    },
  )

  function nextRaw(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const buffered = pending.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove the consumer, or a later response would satisfy a call that has
        // already rejected and the queue would be off by one for the rest of the
        // test.
        const index = waiting.indexOf(consumer)
        if (index !== -1) waiting.splice(index, 1)
        reject(
          new Error(
            `fake-katago: no response within ${String(timeoutMs)}ms. ` +
              `exited=${closed === null ? 'no' : JSON.stringify(closed)} ` +
              `stderr=${JSON.stringify(stderrText.slice(0, 200))}`,
          ),
        )
      }, timeoutMs)

      const consumer = (block: string): void => {
        clearTimeout(timer)
        resolve(block)
      }
      waiting.push(consumer)
    })
  }

  return {
    pid: child.pid,
    send: (command: string) => {
      child.stdin.write(`${command}\n`)
    },
    next: async (timeoutMs?: number) => parseResponse(await nextRaw(timeoutMs)),
    nextRaw,
    stderr: () => stderrText,
    exit,
    close: async () => {
      if (closed === null) {
        // `stdin.end()` first: the child exits on stdin close, which is a clean
        // exit and lets an assertion on the exit code mean something. `kill` is
        // the fallback for a child armed with `--hang-on`.
        child.stdin.end()
        const raced = await Promise.race([
          exit,
          new Promise<'timeout'>((resolve) => {
            setTimeout(() => {
              resolve('timeout')
            }, 1_000)
          }),
        ])
        if (raced === 'timeout') child.kill('SIGKILL')
      }
      await exit
    },
  }
}
