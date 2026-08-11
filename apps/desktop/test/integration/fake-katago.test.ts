import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@gomentor/shared'
import { parseAnalyzeLine, parseCommandList } from '@gomentor/core/katago/gtp'
import { spawnFakeKataGo, type FakeKataGo } from './fake-katago'

/**
 * Proves the fake engine harness works before M2 depends on it.
 *
 * A harness is a measuring instrument, and this project's standing rule is that an
 * instrument must be shown to fail as well as to pass. So this file does two things
 * that a happy-path suite would not:
 *
 * 1. It asserts the **fault injections actually inject faults**. A `--crash-after`
 *    that quietly did nothing would let an M2 test "verify crash recovery" against a
 *    perfectly healthy engine and pass. That is a worse outcome than no test.
 * 2. It asserts response **framing**, not just content — multi-line bodies, echoed
 *    ids, and an unterminated block that must not be delivered. Those are the cases
 *    a reader gets wrong while passing every content assertion.
 *
 * Everything here parses through the real `gtp.ts`. Nothing in this file frames a
 * response itself.
 */

let engine: FakeKataGo | null = null

function start(...args: string[]): FakeKataGo {
  engine = spawnFakeKataGo({ args })
  return engine
}

afterEach(async () => {
  // Every spawn is closed, including after a failed assertion — an orphaned child
  // holding a pipe open makes the *next* test fail with an unrelated timeout.
  if (engine !== null) {
    await engine.close()
    engine = null
  }
})

describe('the fake engine speaks GTP', () => {
  it('answers a simple command', async () => {
    const gtp = start()
    gtp.send('name')

    const response = await gtp.next()
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.body).toBe('fake-katago')
    expect(response.id).toBeNull()
  })

  it('echoes a request id with no space after the prefix', async () => {
    // The spacing is the assertion. `=12 body` is correct; `= 12 body` makes 12
    // part of the body, and a reader would then attribute the response to no
    // request at all.
    const gtp = start()
    gtp.send('12 protocol_version')

    const raw = await gtp.nextRaw()
    expect(raw.startsWith('=12 ')).toBe(true)

    gtp.send('7 name')
    const response = await gtp.next()
    expect(response.id).toBe(7)
  })

  it('delivers a multi-line body as one block', async () => {
    // The response that catches a reader framing on the first newline. `gtp.ts`
    // frames on a blank line, and this is what proves it end to end over a pipe.
    const gtp = start()
    gtp.send('list_commands')

    const response = await gtp.next()
    expect(response.ok).toBe(true)
    if (!response.ok) return

    const commands = parseCommandList(response.body)
    expect(commands.length).toBeGreaterThan(5)
    expect(commands).toContain('genmove')
    expect(commands).toContain('kata-analyze')
    // Specifically: more than one line survived. A first-newline reader would
    // return exactly one.
    expect(response.body.split('\n').length).toBeGreaterThan(5)
  })

  it('preserves the alignment of a space-padded body', async () => {
    // GTP says one leading space separates prefix from body; further spaces are
    // data. `showboard` is the response where over-trimming becomes visible.
    const gtp = start()
    gtp.send('boardsize 9')
    await gtp.next()
    gtp.send('play black D4')
    await gtp.next()
    gtp.send('showboard')

    const response = await gtp.next()
    expect(response.ok).toBe(true)
    if (!response.ok) return

    const lines = response.body.split('\n')
    expect(lines.length).toBe(11) // header + 9 rows + header
    // A stone was placed and appears where GTP says it should: D4 on a 9×9 is
    // column D (index 3) and row 4, counting from the bottom.
    const row4 = lines.find((line) => line.startsWith(' 4 '))
    expect(row4, `no row 4 in:\n${response.body}`).toBeDefined()
    expect(row4?.split(' ').filter((cell) => cell !== '')[1 + 3]).toBe('X')
  })

  it('reports a failure as `?` rather than throwing', async () => {
    const gtp = start()
    gtp.send('no_such_command')

    const response = await gtp.next()
    // A protocol-level failure is a successful parse of a failed command. The
    // caller decides whether it is fatal — `? unknown command` is how you detect
    // an engine that is not KataGo.
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error).toBe('unknown command')
  })

  it('produces a kata-analyze line the real parser can read', async () => {
    const gtp = start()
    gtp.send('kata-analyze 10')

    const response = await gtp.next()
    expect(response.ok).toBe(true)
    if (!response.ok) return

    const candidates = parseAnalyzeLine(response.body, 19)
    expect(candidates.length).toBe(2)
    expect(candidates[0]?.visits).toBe(100)
    expect(candidates[0]?.winrate).toBeCloseTo(0.5123, 4)
    expect(candidates[1]?.order).toBe(1)
  })

  it('returns pass and resign, not only coordinates', async () => {
    // `decodeMove` treats both as not-a-coordinate. A fake that only ever emitted
    // vertices would leave both branches unexercised in every downstream test.
    const gtp = start()
    const moves: string[] = []
    for (let i = 0; i < 7; i += 1) {
      gtp.send('genmove black')
      const response = await gtp.next()
      if (response.ok) moves.push(response.body)
    }

    expect(moves).toContain('pass')
    expect(moves).toContain('resign')
  })

  it('exits 0 on quit', async () => {
    const gtp = start()
    gtp.send('quit')
    await gtp.next()

    const { code } = await gtp.exit
    expect(code).toBe(0)
  })

  it('exits when stdin closes without quit', async () => {
    const gtp = start()
    gtp.send('name')
    await gtp.next()

    await gtp.close()
    const { code } = await gtp.exit
    expect(code).toBe(0)
  })
})

describe('the fault injections actually inject faults', () => {
  /**
   * The reason this block exists: an M2 test asserting crash recovery is only
   * meaningful if the crash happened. A silently-inert fault flag turns such a test
   * into a test that the engine did not crash — passing, and backwards.
   */

  it('--crash-after exits non-zero mid-session', async () => {
    const gtp = start('--crash-after=2')
    gtp.send('name')
    await gtp.next()
    gtp.send('version')
    await gtp.next()

    const { code } = await gtp.exit
    expect(code).toBe(3)
  })

  it('--exit-code controls the crash code', async () => {
    // Distinguishes "the flag was read" from "the child happens to exit 3".
    const gtp = start('--crash-after=1', '--exit-code=42')
    gtp.send('name')
    await gtp.next()

    const { code } = await gtp.exit
    expect(code).toBe(42)
  })

  it('--hang-on leaves the process alive and silent', async () => {
    const gtp = start('--hang-on=genmove')
    gtp.send('genmove black')

    // Alive and silent, which is what an `ENGINE_START_TIMEOUT` test needs — a
    // dead child gives a closed pipe instead, and those are different failures
    // reached by different code.
    await expect(gtp.next(400)).rejects.toThrow(/no response within 400ms/)
    expect(gtp.stderr()).not.toContain('exit')

    // Still answering other commands proves it is the injection, not a crash.
    gtp.send('name')
    const response = await gtp.next()
    expect(response.ok).toBe(true)
  })

  it('--garbage-on makes the real parser throw ENGINE_QUERY_FAILED', async () => {
    const gtp = start('--garbage-on=name')
    gtp.send('name')

    // Thrown by `parseResponse`, not by this file. That is the point: the harness
    // reproduces the byte sequence, and production code decides what it means.
    const rejection = await gtp.next().then(
      () => null,
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(AppError)
    if (!(rejection instanceof AppError)) return
    expect(rejection.code).toBe('ENGINE_QUERY_FAILED')
  })

  it('--unterminated-on withholds the block terminator', async () => {
    const gtp = start('--unterminated-on=name')
    gtp.send('name')

    // The bytes are on the wire, but the block never closes, so a correct framer
    // delivers nothing. A reader that split on the first newline would have handed
    // its caller a "complete" response here.
    await expect(gtp.next(400)).rejects.toThrow(/no response within 400ms/)

    // The bytes were buffered, not dropped: the *next* response supplies the
    // blank line, and the two then arrive fused into one block. That fusion is
    // the real-world consequence of a missing terminator, and asserting it is
    // more useful than asserting a bare `ok`.
    gtp.send('version')
    const response = await gtp.next()
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.body).toContain('fake-katago')
    expect(response.body).toContain('0.0.0-fake')
  })

  it('--delay-ms delays the response without losing it', async () => {
    const gtp = start('--delay-ms=250')
    gtp.send('name')

    await expect(gtp.next(80)).rejects.toThrow(/no response within 80ms/)
    // The consumer that timed out was removed from the queue, so this one gets the
    // response rather than waiting behind a dead entry.
    const response = await gtp.next(2_000)
    expect(response.ok).toBe(true)
  })

  it('--stderr-noise goes to stderr and never into the parsed stream', async () => {
    // A reader that merged stderr into stdout would try to parse the banner as a
    // response and fail on a healthy engine.
    const gtp = start('--stderr-noise')
    gtp.send('name')

    const response = await gtp.next()
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.body).toBe('fake-katago')
    expect(gtp.stderr()).toContain('OpenCL')
  })

  it('rejects an unknown fault flag instead of running healthy', async () => {
    // The failure this prevents is a typo'd flag producing a working engine, so a
    // test "verifying" a fault asserts the absence of something never armed.
    const gtp = start('--crash-aftr=2')

    const { code } = await gtp.exit
    expect(code).toBe(2)
    expect(gtp.stderr()).toContain('unknown argument')
  })
})
