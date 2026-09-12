import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { firstPage, launchApp, useLocalProvider } from './harness'

/**
 * The M3 agent loop as the user meets it: A1's renderer half end to end, A3's
 * renderer half, and A5's renderer half. The main-process halves of all three
 * (loop mechanics, the wire-level degrade shape, the no-orphan guarantee) live
 * in `test/integration/llm-agent.test.ts` against a scripted provider; this
 * spec proves the same flow through the built app, the real IPC fan-out, and
 * the real components.
 *
 * ## What is real, and what is faked
 *
 * Nothing inside the app is stubbed. The SSE frames are parsed by the shipping
 * `openai-compatible.ts` — including its per-index tool-call fragment
 * accumulation — the capability probe runs before the first turn, the degrade
 * tri-state resolves at the real `send` entry, the loop and tool registry are
 * the real ones, and `get_analysis` reaches a genuinely spawned engine child
 * through the real `analyzeOnce` (`agent:1` independent-query tier). What is
 * faked is the far end of each pipe, which is exactly what a CI runner cannot
 * have: the *model* is a scripted OpenAI-compatible SSE server (the boundary
 * `smoke.spec.ts` draws), and the *engine* is `fake-katago-child.ts`, selected
 * through the production `GOMENTOR_KATAGO_BINARY` override (the boundary
 * `analysis.spec.ts` draws).
 *
 * ## Why the scripted server routes on request bodies
 *
 * Three HTTP requests make up the tool flow — the capability probe, the
 * tool-call turn, and the grounded answer turn — and the server must answer
 * each differently. It routes on content (`report_probe_ok` names the probe; a
 * `role: 'tool'` message names turn three), never on arrival order, so an
 * extra or missing request fails visibly instead of desynchronising the
 * script. The grounded turn quotes the winrate **out of the tool message it
 * was handed** — the same message the renderer's step row displays — because
 * that is what a model that grounds its answer does, and it makes "the cited
 * number is the engine's, not invented" assertable as a digit match between
 * the answer and the step result.
 *
 * ## Why one sequential flow per describe
 *
 * The tool describe is ordered by construction — import, open, wait for the
 * engine (a `get_analysis` before `ready` would answer `ENGINE_UNAVAILABLE`
 * as a tool error, and the grounded turn would have no number to cite), then
 * ask. Later tests read the state earlier ones left, exactly as
 * `analysis.spec.ts` records.
 *
 * ## Reload semantics (A5), recorded as the accepted M3 shape
 *
 * A reload mid-run does **not** leave an incomplete message or a spinner: the
 * store is recreated with the window, so the panel shows its initial empty
 * state — question, steps, and answer all gone from view — while main (which
 * owns the run) finishes it and its events fail the store's `runId` filter on
 * arrival. No re-attachment machinery exists, by design (`chatStore.ts`'s
 * header records the reasoning); the unit suite pins the filter's half, and
 * the reload describe below pins the live half: the reloaded panel stays
 * empty, shows no error, and accepts a new question.
 *
 * ## Locale
 *
 * The app boots in its default locale (zh-CN, with en fallback); assertions
 * therefore match digits, JSON, and testids, never translated label text —
 * the same convention as `analysis.spec.ts`.
 */

const FIXTURE_SGF = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'core',
  'test',
  'fixtures',
  'sgf',
  'gnugo-9x9-1-pass.sgf',
)

/** The fake engine child, addressed through the same env override support uses. */
const FAKE_CHILD = resolve(__dirname, '..', 'integration', 'fake-katago-child.ts')

/**
 * The move the scripted model asks about. Any played move of the fixture
 * works; 5 is real (the fixture has 53), early enough to be unambiguous and
 * inside the `0..moves.length` bound `checkMoveNumber` enforces.
 */
const ASKED_MOVE = 5

// ---------------------------------------------------------------------------
// The scripted model server
// ---------------------------------------------------------------------------

/** One `chat.completion.chunk` in the wire shape `openai-compatible.ts` reads. */
function chunkFrame(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): unknown {
  return {
    id: 'chatcmpl-teacher-agent',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** A text delta frame's payload. */
function textDelta(text: string): Record<string, unknown> {
  return { content: text }
}

/**
 * A tool call's opening fragment: the only frame that carries the call's id
 * and name, with empty arguments — the wire shape that makes the provider
 * emit "a call has started" before any argument text exists, which is what the
 * renderer's step row appears on.
 */
function toolCallOpening(
  index: number,
  id: string,
  name: string,
): Record<string, unknown> {
  return {
    tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }],
  }
}

/** A later fragment of the same call: argument text alone, matched by index. */
function toolCallArguments(
  index: number,
  argumentsDelta: string,
): Record<string, unknown> {
  return { tool_calls: [{ index, function: { arguments: argumentsDelta } }] }
}

interface ScriptedReply {
  readonly deltas: readonly Record<string, unknown>[]
  readonly finishReason: string
}

interface ScriptedModelOptions {
  /** How the capability probe is answered — the measurement the tri-state reads. */
  readonly probe: 'tool_call' | 'prose'
  /**
   * The tool call the first chat turn makes. Absent: every chat turn answers
   * in prose, the degraded shape — pair it with `probe: 'prose'`.
   */
  readonly firstCall?: { readonly name: string; readonly arguments: string }
  /**
   * Delay before each chat reply (never the probe), so a spec can catch the
   * run in flight — the reload describe's whole premise.
   */
  readonly replyDelayMs?: number
}

interface ScriptedModel {
  readonly port: number
  /** Request bodies received, in order, so tests can assert on the wire. */
  readonly bodies: readonly string[]
  /** Resolves once `count` requests have been received. */
  waitForRequests(count: number): Promise<void>
  close(): Promise<void>
}

/** Widened read of one wire message; the server inspects, never trusts. */
function messageRoles(body: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const messages = (parsed as { messages?: unknown }).messages
  return Array.isArray(messages) ? messages : []
}

/** Whether the request's history already carries the tool's reply. */
function hasToolMessage(body: string): boolean {
  return messageRoles(body).some(
    (entry) => (entry as { role?: unknown }).role === 'tool',
  )
}

/**
 * The grounded turn's text, built from the tool message the request carried.
 *
 * Reads the same JSON the renderer's step row shows, and cites its number in
 * `String(number)` form — the digits the spec then matches between the answer
 * and the step result. No number, no citation: a missing winrate produces
 * text with nothing digit-shaped to match, and the spec fails honestly
 * rather than passing on an invented constant.
 */
function citeFromToolMessage(body: string): string {
  const toolMessage = messageRoles(body).find(
    (entry) => (entry as { role?: unknown }).role === 'tool',
  ) as { content?: unknown } | undefined
  const content = toolMessage?.content
  if (typeof content !== 'string') return 'the tool said nothing readable'
  let payload: unknown
  try {
    payload = JSON.parse(content)
  } catch {
    return 'the tool replied'
  }
  const winrate = (payload as { winrate?: unknown }).winrate
  if (typeof winrate === 'number') {
    return `the side to move holds a ${String(winrate)} winrate.`
  }
  const matched = (payload as { matched?: unknown }).matched
  if (typeof matched === 'number') {
    // A search reply: cite the count and, when a match came back, the first
    // summary's own outcome — the same quote-from-the-payload honesty as the
    // winrate branch, applied to library summaries (A2). `result` on a
    // summary is the parsed `gameResultSchema` object (winner/score/by), not
    // the raw SGF string, so the fields are quoted as they arrived. An empty
    // library falls through to the count alone.
    const results = (payload as { results?: unknown }).results
    const first = Array.isArray(results)
      ? (results[0] as { result?: unknown } | undefined)
      : undefined
    const outcome = first?.result
    if (
      typeof outcome === 'object' &&
      outcome !== null &&
      typeof (outcome as { winner?: unknown }).winner === 'string' &&
      typeof (outcome as { score?: unknown }).score === 'number'
    ) {
      const { winner, score, by } = outcome as {
        winner: string
        score: number
        by?: string
      }
      return (
        `${String(matched)} games matched; the newest: ${winner} wins by ${String(score)} ${by ?? ''}`.trim() +
        '.'
      )
    }
    return `${String(matched)} games matched.`
  }
  const weaknesses = (payload as { weaknesses?: unknown }).weaknesses
  if (Array.isArray(weaknesses)) {
    // A profile reply (M4): cite the top weakness's score, the same
    // quote-from-the-payload honesty as the winrate branch. The snapshot the
    // tool returned carries at most three; the citation uses the first —
    // the one the panel shows as the headline weakness.
    const first = weaknesses[0] as { score?: unknown } | undefined
    if (typeof first?.score === 'number') {
      return `the profile scores the leading weakness at ${String(first.score)}.`
    }
    return 'the profile found no weakness to cite.'
  }
  return 'the tool replied.'
}

/** The scripted reply for one request, routed on its body. */
function scriptFor(body: string, options: ScriptedModelOptions): ScriptedReply {
  // The probe is recognisable by its tool: no user conversation names
  // `report_probe_ok`, and the probe is the only request that does.
  if (body.includes('report_probe_ok')) {
    return options.probe === 'tool_call'
      ? {
          deltas: [
            toolCallOpening(0, 'probe-1', 'report_probe_ok'),
            toolCallArguments(0, '{"value":"ok"}'),
          ],
          finishReason: 'tool_calls',
        }
      : { deltas: [textDelta('ok')], finishReason: 'stop' }
  }

  if (options.firstCall !== undefined && !hasToolMessage(body)) {
    // Turn one: request the tool. The arguments are split across fragments at
    // a fixed cut so only the provider's per-index accumulation can
    // reassemble them — a shortcut format the real parser rejects would test
    // nothing.
    const args = options.firstCall.arguments
    return {
      deltas: [
        toolCallOpening(0, 'call-1', options.firstCall.name),
        toolCallArguments(0, args.slice(0, 10)),
        ...(args.length > 10 ? [toolCallArguments(0, args.slice(10))] : []),
      ],
      finishReason: 'tool_calls',
    }
  }

  if (options.firstCall !== undefined) {
    // Turn two: the history carries the tool's reply; cite it.
    return {
      deltas: [
        textDelta('Grounded on the tool result: '),
        textDelta(citeFromToolMessage(body)),
      ],
      finishReason: 'stop',
    }
  }

  // The degraded shape: one prose answer, no tools ever offered.
  return {
    deltas: [textDelta('A plain '), textDelta('single-shot answer.')],
    finishReason: 'stop',
  }
}

function startScriptedModel(options: ScriptedModelOptions): Promise<ScriptedModel> {
  const bodies: string[] = []
  const waits: { readonly count: number; readonly resolve: () => void }[] = []

  function settleWaits(): void {
    for (const wait of [...waits]) {
      if (bodies.length >= wait.count) {
        wait.resolve()
        waits.splice(waits.indexOf(wait), 1)
      }
    }
  }

  const server: Server = createServer((incoming, response) => {
    // The probe breaks out of its stream on the first tool_call chunk, which
    // destroys the socket from the client side. Writing the remaining frames
    // then surfaces as an 'error' event on the response — without a listener
    // that would kill the spec process and blame whatever the test happened
    // to be awaiting. The same cover applies to the reload describe, where
    // the app is torn down with replies still pending.
    response.on('error', () => undefined)
    incoming.on('error', () => undefined)

    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8')
      bodies.push(bodyText)
      settleWaits()

      const reply = scriptFor(bodyText, options)
      // One `write` per frame plus the `[DONE]` sentinel: what makes this a
      // streaming reply the provider must accumulate rather than one JSON
      // body it could read whole.
      const send = (): void => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        for (const delta of reply.deltas) {
          response.write(`data: ${JSON.stringify(chunkFrame(delta))}\n\n`)
        }
        response.write(
          `data: ${JSON.stringify(chunkFrame({}, reply.finishReason))}\n\n`,
        )
        response.write('data: [DONE]\n\n')
        response.end()
      }

      const delay = options.replyDelayMs
      if (delay === undefined || bodyText.includes('report_probe_ok')) {
        send()
        return
      }
      // `unref` so a pending delayed reply cannot hold the worker's event
      // loop open at teardown; the app is closed first, and the write the
      // timer eventually makes is absorbed by the error listeners above.
      const timer = setTimeout(send, delay)
      timer.unref()
    })
  })

  return new Promise((resolveModel) => {
    // Port 0: the OS picks, so parallel workers cannot collide.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      // Narrowed rather than asserted — `address()` is `string | AddressInfo | null`
      // and only the object form carries a port.
      if (address === null || typeof address === 'string') {
        throw new Error('scripted model server did not bind to a TCP port')
      }
      resolveModel({
        port: address.port,
        get bodies(): readonly string[] {
          return bodies
        },
        waitForRequests: (count: number) =>
          new Promise<void>((resolve) => {
            const wait = { count, resolve }
            waits.push(wait)
            settleWaits()
          }),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => {
              done()
            })
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// A1: the tool loop, renderer half, against the real engine tier
// ---------------------------------------------------------------------------

test.describe('the teacher agent loop against a tool-capable scripted model', () => {
  let app: ElectronApplication
  let page: Page
  let model: ScriptedModel

  test.beforeAll(async () => {
    model = await startScriptedModel({
      probe: 'tool_call',
      firstCall: {
        name: 'get_analysis',
        arguments: `{"moveNumber":${String(ASKED_MOVE)}}`,
      },
    })
    app = await launchApp({
      env: {
        GOMENTOR_KATAGO_BINARY: FAKE_CHILD,
      },
    })
    page = await firstPage(app)
  })

  test.afterAll(async () => {
    // The app first: closing it drops any in-flight request, so the server has
    // nothing left to wait on and `close()` does not hang.
    await app.close()
    await model.close()
  })

  test('a record is open and the engine is ready', async () => {
    // Open over the real user path (`analysis.spec.ts`'s pattern): import, then
    // click the library row, which round-trips through `sgf:serialize` into
    // `gameStore.open` and starts the engine.
    const ok = await page.evaluate(async (filePath) => {
      const result = await window.gomentor.library.import({ filePaths: [filePath] })
      return result.ok && result.data.imported.length === 1
    }, FIXTURE_SGF)
    expect(ok).toBe(true)

    await page.getByTestId('library-list').locator('button.library-row').first().click()
    await expect(page.getByTestId('board-move')).toContainText('53')

    // The gate the tool depends on: `analyzeOnce` answers `ENGINE_UNAVAILABLE`
    // as a tool error unless the phase is `ready`, and the grounded turn would
    // then have no number to cite. Ready means the probe round-tripped through
    // the production parser inside the service.
    await expect(
      page.getByTestId('engine-status').locator('.engine-status__value--ready'),
    ).toBeVisible({ timeout: 15_000 })
  })

  test("the answer cites the engine's number through visible tool steps", async () => {
    await useLocalProvider(page, model.port)

    await page.getByTestId('chat-input').fill(`why is move ${String(ASKED_MOVE)} bad?`)
    await page.getByTestId('chat-send').click()

    // The step row: the tool's own name, and the arguments it was called with.
    // The `data-tool` attribute is set from the chunk's name, so a run that
    // called some other tool — or no tool — fails here regardless of locale.
    const step = page.locator('[data-testid="chat-step"][data-tool="get_analysis"]')
    await expect(step).toBeVisible()
    await expect(step).toContainText('get_analysis')
    await expect(step.getByTestId('chat-step-args')).toContainText('moveNumber')

    // The result filled in, and the preview is bounded: the analysis JSON is
    // far longer than the ~120-character display bound, so the expand control
    // exists and the visible text is a strict prefix of the data behind it —
    // the e2e half of what `tool-steps.test.ts` asserts about the constant.
    const result = step.getByTestId('chat-step-result')
    await expect(result).toBeVisible()
    await expect(step.getByTestId('chat-step-pending')).toHaveCount(0)
    const preview = (await result.innerText()).trim()
    const toggle = step.getByTestId('chat-step-result-toggle')
    await expect(toggle).toBeVisible()
    expect(preview.endsWith('…')).toBe(true)

    await toggle.click()
    const full = (await result.innerText()).trim()
    expect(full.length).toBeGreaterThan(preview.length)

    // The engine's number, read where the step shows it. The fake engine's
    // canned winrate is `(500 + seed % 100) / 1000` — always inside
    // [0.500, 0.599] — so the shape check ties the digit to the canned formula
    // without the spec re-deriving the seed (which would be a second copy of
    // the fake, free to agree with itself).
    const winrate = /"winrate":(0\.\d+)/.exec(full)?.[1]
    if (winrate === undefined) throw new Error(`no winrate in the tool result: ${full}`)
    expect(winrate).toMatch(/^0\.5\d{0,2}$/)

    // The run is over, and the turn is a real transcript entry.
    await expect(page.getByTestId('chat-streaming')).toHaveCount(0)
    await expect(page.getByTestId('teacher-panel')).toHaveAttribute('data-run-id', '')
    // The turns, not the step rows: a turn with tools nests the steps' `<ol>`
    // inside its own `<li>`, so a `listitem` query would count 3 here and the
    // count would say nothing about turns. `chat-turn` is the turn's own class.
    const turns = page.getByTestId('chat-log').locator('li.chat-turn')
    await expect(turns).toHaveCount(2)

    // The steps live under the finished turn, not only while they ran: a row
    // that vanished at `llm:done` would tell the user the tool ran only while
    // it was running.
    await expect(turns.nth(1).locator('[data-testid="chat-step"]')).toHaveCount(1)

    // The answer quotes the same digits the engine produced. The prose is read
    // from the turn's markdown paragraphs only, never the turn's `innerText`:
    // the step rows are nested inside the same turn, so whole-turn text always
    // contains the number through the step's own JSON and the cross-check would
    // pass whatever the model cited — measured by sabotaging the citation to a
    // number the engine never produced and watching the turn-scoped assertion
    // stay green.
    const prose = (await turns.nth(1).locator('.chat-md p').allInnerTexts()).join(' ')
    expect(prose.replace(/\s+/g, ' ')).toContain(winrate)

    // The wire, composed end to end and in order: the probe first (answered
    // tool-capable, which is what armed the loop), then the agent turn
    // offering the registry, then the grounded turn carrying the tool message
    // whose number the answer just matched. A probe that stopped happening,
    // or a grounded turn that never received the tool's reply, fails here.
    // `tool_call_id`, not `"role":"tool"`: the SDK pretty-prints request
    // bodies (`"role": "tool"`, measured in this spec's first run), so only
    // spacing-independent substrings are assertable — and `tool_call_id` is a
    // field only a tool *reply* carries.
    expect(model.bodies).toHaveLength(3)
    expect(model.bodies[0]).toContain('report_probe_ok')
    expect(model.bodies[1]).toContain('"tools"')
    expect(model.bodies[1]).toContain('get_analysis')
    expect(model.bodies[2]).toContain('tool_call_id')
    expect(model.bodies[2]).toContain(winrate)
  })
})

// ---------------------------------------------------------------------------
// A2: the library tool's summaries reach the answer the same way the engine's
// numbers do — cited from the tool message, matched as digits
// ---------------------------------------------------------------------------

test.describe('the teacher cites search_library summaries', () => {
  let app: ElectronApplication
  let page: Page
  let model: ScriptedModel

  test.beforeAll(async () => {
    model = await startScriptedModel({
      probe: 'tool_call',
      firstCall: { name: 'search_library', arguments: '{"date":"2006"}' },
    })
    // Import-only: no record is opened, so nothing ever starts the engine —
    // search_library reads the library, not KataGo. The nonexistent-binary
    // override makes that engine-freedom structural (the board-render.spec
    // lesson) rather than incidental: if an import ever did open a game, the
    // app would degrade to `unavailable` instead of silently spawning a real
    // engine on a machine with fetched resources.
    app = await launchApp({
      env: { GOMENTOR_KATAGO_BINARY: join(__dirname, 'no-such-engine') },
    })
    page = await firstPage(app)
  })

  test.afterAll(async () => {
    await app.close()
    await model.close()
  })

  test('the fixture is in the library', async () => {
    const ok = await page.evaluate(async (filePath) => {
      const result = await window.gomentor.library.import({ filePaths: [filePath] })
      return result.ok && result.data.imported.length === 1
    }, FIXTURE_SGF)
    expect(ok).toBe(true)
  })

  test('the answer cites the summary the search returned', async () => {
    await useLocalProvider(page, model.port)

    await page.getByTestId('chat-input').fill('find my games from 2006')
    await page.getByTestId('chat-send').click()

    // The search step row, by the tool's own name.
    const step = page.locator('[data-testid="chat-step"][data-tool="search_library"]')
    await expect(step).toBeVisible()
    await expect(step.getByTestId('chat-step-args')).toContainText('2006')

    // The run completes into a real transcript turn.
    await expect(page.getByTestId('chat-streaming')).toHaveCount(0)
    await expect(page.getByTestId('teacher-panel')).toHaveAttribute('data-run-id', '')
    const turns = page.getByTestId('chat-log').locator('li.chat-turn')
    await expect(turns).toHaveCount(2)

    // The cited summary fields, read where the step shows it: pick the
    // fixture's parsed `RE[]` outcome out of the summary JSON the tool
    // returned. `DT[2006-01-31]` matched the `{"date":"2006"}` criteria, so
    // matched=1 and the first summary carries the typed result object
    // (winner white, score 11 — `gameResultSchema`'s parse of `RE[W+11.0]`).
    // Unlike A1's long analysis JSON, a one-hit search reply can fit inside
    // the 120-character preview — the expand control exists only when
    // something was cut — so the row is expanded when it can be and read
    // whole when it already is.
    const toggle = step.getByTestId('chat-step-result-toggle')
    if ((await toggle.count()) > 0) await toggle.click()
    const full = (await step.getByTestId('chat-step-result').innerText()).trim()
    const winner = /"winner":"([a-z]+)"/.exec(full)?.[1]
    const score = /"score":([0-9]+)/.exec(full)?.[1]
    if (winner === undefined || score === undefined) {
      throw new Error(`no game outcome in the tool output: ${full}`)
    }
    const citation = `${winner} wins by ${score}`

    // The prose quotes the same summary fields (A1's cross-check shape: the
    // markdown paragraphs only, never the turn's whole `innerText` — the step
    // rows share the turn's DOM and would leak the values through their JSON).
    const prose = (await turns.nth(1).locator('.chat-md p').allInnerTexts()).join(' ')
    const flat = prose.replace(/\s+/g, ' ')
    expect(flat).toContain('1 games matched')
    expect(flat).toContain(citation)

    // Wire order, composed end to end: the probe, then the agent turn
    // offering the registry (search_library among the tools), then the
    // grounded turn carrying the tool reply whose summary the answer matched.
    expect(model.bodies).toHaveLength(3)
    expect(model.bodies[0]).toContain('report_probe_ok')
    expect(model.bodies[1]).toContain('search_library')
    expect(model.bodies[2]).toContain('tool_call_id')
    // The winner rides inside the tool message's `content` string, where the
    // SDK's JSON serialisation escapes every quote — the body literally
    // contains `\"winner\":\"white\"`. `'\\"'` is that escaped quote in a JS
    // string, so this is an exact substring, not a pattern.
    expect(model.bodies[2]).toContain(`\\"winner\\":\\"${winner}`)
  })
})

// ---------------------------------------------------------------------------
// A3, renderer half: a tools-unsupported model degrades invisibly
// ---------------------------------------------------------------------------

test.describe('a tools-unsupported model degrades before the renderer ever sees a tool', () => {
  let app: ElectronApplication
  let page: Page
  let model: ScriptedModel

  test.beforeEach(async () => {
    model = await startScriptedModel({ probe: 'prose' })
    app = await launchApp()
    page = await firstPage(app)
  })

  test.afterEach(async () => {
    await app.close()
    await model.close()
  })

  test('no step rows render; a plain answer streams', async () => {
    await useLocalProvider(page, model.port)

    await page.getByTestId('chat-input').fill('why is move 5 bad?')
    await page.getByTestId('chat-send').click()

    const turns = page.getByTestId('chat-log').getByRole('listitem')
    await expect(turns).toHaveCount(2)
    await expect(turns.nth(1)).toContainText('A plain single-shot answer.')

    // The renderer half of A3: degradation is invisible — no step list, no
    // step row, no pending marker. The panel never learned a tool existed.
    await expect(page.getByTestId('chat-steps')).toHaveCount(0)
    await expect(page.getByTestId('chat-step')).toHaveCount(0)
    await expect(page.getByTestId('chat-step-pending')).toHaveCount(0)

    // And the run closed out like any single-shot reply.
    await expect(page.getByTestId('chat-streaming')).toHaveCount(0)
    await expect(page.getByTestId('teacher-panel')).toHaveAttribute('data-run-id', '')

    // The wire half, as the shipping service actually sent it: the probe
    // measured prose (`no_tool_call`), and the one reply request carried no
    // `tools` key at all — absent, not empty. (The integration and core
    // suites assert the same on the `ChatRequest`; this is the composition.)
    expect(model.bodies).toHaveLength(2)
    expect(model.bodies[0]).toContain('report_probe_ok')
    expect(model.bodies[1]).not.toContain('"tools"')
  })
})

// ---------------------------------------------------------------------------
// A5, renderer half: a reload mid-run loses the answer, not the app
// ---------------------------------------------------------------------------

test.describe('a reload mid-run loses the answer, not the app', () => {
  let app: ElectronApplication
  let page: Page
  let model: ScriptedModel

  test.beforeAll(async () => {
    model = await startScriptedModel({
      probe: 'tool_call',
      // `search_library` needs neither an engine nor an open record, so this
      // describe isolates the reload semantics from both of the other
      // describes' machinery.
      firstCall: { name: 'search_library', arguments: '{}' },
      replyDelayMs: 2_000,
    })
    app = await launchApp()
    page = await firstPage(app)
  })

  test.afterAll(async () => {
    await app.close()
    await model.close()
  })

  test('the reloaded panel shows its initial state while main finishes the run', async () => {
    await useLocalProvider(page, model.port)

    await page.getByTestId('chat-input').fill('find some games')
    await page.getByTestId('chat-send').click()

    const panel = page.getByTestId('teacher-panel')
    await expect(panel).not.toHaveAttribute('data-run-id', '')

    // Reload while the first chat reply is still delayed in flight — the run
    // is live in main, and the window's copy of it is about to die.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    // Main finishes the run on its own: probe + tool turn + grounded turn =
    // three requests, the third being the one whose answer ends the run.
    await model.waitForRequests(3)
    // The terminal event crosses just after the third request is answered.
    // Everything asserted below is an absence, and absence assertions do not
    // retry — so the event gets its crossing time before the look happens.
    await page.waitForTimeout(600)

    // The accepted M3 semantics (see the header): the panel shows its initial
    // state. The question, the steps, and the answer of the lost run are all
    // gone from view — not held as an incomplete message, not spun, and not
    // errored: the events of a run this store never accepted are dropped by
    // the `runId` filter, including the terminal one.
    await expect(page.getByTestId('teacher-empty')).toBeVisible()
    await expect(page.getByTestId('chat-log')).toHaveCount(0)
    await expect(page.getByTestId('chat-streaming')).toHaveCount(0)
    await expect(page.getByTestId('chat-step')).toHaveCount(0)
    await expect(page.getByTestId('error-notice')).toHaveCount(0)
    await expect(panel).toHaveAttribute('data-run-id', '')

    // The old run's answer — which main genuinely produced and emitted —
    // never reached the reloaded page.
    expect(await panel.innerText()).not.toContain('Grounded on the tool result')

    // And the app is not wedged by the lost run: a fresh send starts a fresh
    // run. Main issues runIds per send and never refused the second one; if
    // the reloaded store were stuck busy, this is where it would show.
    await page.getByTestId('chat-input').fill('again')
    await page.getByTestId('chat-send').click()
    await expect(panel).not.toHaveAttribute('data-run-id', '')
  })
})

// ---------------------------------------------------------------------------
// C6: the teacher quotes the student profile's real numbers — the tool result
// carries the derivation the panel would show, and the answer cites it
// ---------------------------------------------------------------------------

test.describe('the teacher reads the student profile (C6)', () => {
  let app: ElectronApplication
  let page: Page
  let model: ScriptedModel
  let profileDir: string

  /**
   * The same generated record the profile spec uses: a named student's game
   * the fake engine analyses through the real batch scheduler, so the
   * profile's numbers are rows the production pipeline wrote — not fixtures
   * this spec invented.
   */
  const STUDENT = 'Student'
  const buildStudentSgf = (): string => {
    const moves = Array.from({ length: 30 }, (_, i) => {
      const letter = (n: number): string => String.fromCharCode(97 + n)
      return `;${i % 2 === 0 ? 'B' : 'W'}[${letter(i % 19)}${letter(Math.floor(i / 19))}]`
    }).join('')
    return `(;GM[1]FF[4]CA[UTF-8]SZ[19]PB[${STUDENT}]PW[Opponent]KM[6.5]${moves})`
  }

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'gomentor-profile-teacher-'))
    writeFileSync(join(profileDir, 'student.sgf'), buildStudentSgf())
    model = await startScriptedModel({
      probe: 'tool_call',
      firstCall: { name: 'get_profile', arguments: '{}' },
    })
    app = await launchApp({
      userDataDir: profileDir,
      env: { GOMENTOR_KATAGO_BINARY: FAKE_CHILD },
    })
    page = await firstPage(app)
  })

  test.afterAll(async () => {
    await app.close()
    await model.close()
  })

  test('the answer cites the profile score the tool returned', async () => {
    // Seed through the app's own paths: import, name the student, run the
    // batch, and read the derived score back.
    const seeded = await page.evaluate(
      async (path) => {
        const imported = await window.gomentor.library.import({ filePaths: [path] })
        if (!imported.ok || imported.data.imported.length !== 1) return 'import'
        const named = await window.gomentor.settings.set({
          patch: { profile: { playerNames: ['Student'] } },
        })
        if (!named.ok) return 'settings'
        const started = await window.gomentor.batch.start({ scope: 'mine' })
        if (!started.ok) return 'batch-start'
        return 'ok'
      },
      join(profileDir, 'student.sgf'),
    )
    expect(seeded).toBe('ok')

    // The run is one game against the fake engine: wait for the terminal
    // snapshot. `profile:get` is the exact read the panel and the tool share.
    const score = await page.evaluate(async () => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const snapshot = await window.gomentor.profile.get({})
        if (snapshot.ok && snapshot.data.weaknesses.length > 0) {
          return snapshot.data.weaknesses[0]?.score
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return undefined
    })
    if (typeof score !== 'number') {
      throw new Error('the batch run produced no weaknesses within the deadline')
    }

    await useLocalProvider(page, model.port)

    await page.getByTestId('chat-input').fill('what are my weaknesses?')
    await page.getByTestId('chat-send').click()

    // The step row proves the tool ran, and its result preview shows the same
    // derivation — the renderer-side half of the cross-check.
    const step = page.locator('[data-testid="chat-step"][data-tool="get_profile"]')
    await expect(step).toBeVisible()

    // The wire: the grounded turn carried the tool message, and the message
    // contained the score the app derived. The citation is honest only if
    // this body holds the same digits the answer shows.
    await model.waitForRequests(3)

    const turns = page.getByTestId('chat-log').locator('li.chat-turn')
    await expect(turns).toHaveCount(2)
    const prose = (await turns.nth(1).locator('.chat-md p').allInnerTexts()).join(' ')
    expect(prose.replace(/\s+/g, ' ')).toContain(`at ${String(score)}.`)

    expect(model.bodies).toHaveLength(3)
    expect(model.bodies[1]).toContain('get_profile')
    expect(model.bodies[2]).toContain('tool_call_id')
    // The tool message carried the derived score. Substring, not
    // `"score":<n>`: the SDK pretty-prints the request body (measured in this
    // spec's first run), and the tool content's quotes arrive escaped — the
    // digits alone are the cross-check, and `prose` already ties them to the
    // citation shape.
    expect(model.bodies[2]).toContain(String(score))
  })
})
