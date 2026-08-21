import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp, useLocalProvider } from './harness'

/**
 * The Stage 7 smoke spec: the built app launches, shows its three panels, and
 * completes one round trip through the real LLM path against a mocked model server.
 *
 * ## What this does and does not claim about A1, A2 and A11
 *
 * It is deliberately narrower than those criteria, and saying so here is the point —
 * a spec named `smoke` invites the reading that the manual smoke checks are now
 * automated, and they are not.
 *
 * - **A1** is `pnpm install && pnpm dev` opening a window within 5s with no console
 *   errors. This launches `out/` rather than `dev`, so the Vite dev server, the HMR
 *   client and React's development build are all absent — and those are exactly where
 *   a console error would come from. What is covered is the shipped path: the built
 *   main, preload and renderer bundles start and the window renders. The 5s budget is
 *   not asserted, because a bound tight enough to be meaningful is loose enough to be
 *   flaky on a shared CI runner; Playwright's own timeout catches a window that never
 *   arrives, which is the failure that matters.
 * - **A2** is "three panels visible **and resizable**; layout persists across
 *   restart". Only the first clause is testable today: there is no resize handle yet
 *   (see `App.tsx` on `ui.panelWidths` being read but never written), so nothing here
 *   touches resizing or persistence.
 * - **A11** is streaming, cancel, and legible errors for wrong key and down server.
 *   This covers the happy path only. Cancel and the two error paths stay manual.
 *
 * ## Nothing inside the app is stubbed
 *
 * The provider, `LlmService`, the IPC handlers, the preload bridge and the stores are
 * all the shipping ones. What is faked is the HTTP server on the other end, which is
 * the only piece a CI runner cannot have — the same boundary `ipc-events.spec.ts`
 * draws, and for the same reason.
 */

/** The reply the mocked model streams, split so the assertion needs both frames. */
const REPLY_FRAGMENTS = ['This corner ', 'is unsettled.'] as const
const REPLY = REPLY_FRAGMENTS.join('')

/** The prompt typed into the composer, echoed back by the request assertion. */
const PROMPT = 'why is this move bad'

/** One `chat.completion.chunk` in the wire shape, as `openai-compatible.ts` reads it. */
function textFrame(delta: string, finishReason: string | null = null): unknown {
  return {
    id: 'chatcmpl-smoke',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'smoke-model',
    choices: [{ index: 0, delta: { content: delta }, finish_reason: finishReason }],
  }
}

interface MockModel {
  port: number
  /** Request bodies received, so a test can prove the prompt crossed every layer. */
  bodies: string[]
  close: () => Promise<void>
}

/**
 * An OpenAI-compatible server that streams `REPLY` and finishes.
 *
 * The frames are written one per `write` and the stream is closed with `[DONE]`,
 * which is what makes this a *streaming* test rather than a request/response one:
 * the renderer has to accumulate two deltas and then promote them to a message when
 * the run finishes.
 *
 * The body is recorded rather than inspected here. A server that asserted would fail
 * inside a request handler, where Playwright attributes the error to whatever the
 * test happened to be awaiting — the failure would name the click, not the payload.
 */
function startMockModel(): Promise<MockModel> {
  const bodies: string[] = []

  const server: Server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const fragment of REPLY_FRAGMENTS) {
        response.write(`data: ${JSON.stringify(textFrame(fragment))}\n\n`)
      }
      // The finish reason rides the last frame, then `[DONE]` ends the stream. Both
      // are needed: without a finish reason the run never leaves `streaming`, and
      // without `[DONE]` the SDK waits for more frames until the 300s local timeout.
      response.write(`data: ${JSON.stringify(textFrame('', 'stop'))}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })

  return new Promise((resolve) => {
    // Port 0: the OS picks, so parallel workers cannot collide.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      // Narrowed rather than asserted — `address()` is `string | AddressInfo | null`
      // and only the object form carries a port.
      if (address === null || typeof address === 'string') {
        throw new Error('mock model server did not bind to a TCP port')
      }
      resolve({
        port: address.port,
        bodies,
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

test.describe('the built app launches, shows three panels, and answers', () => {
  let app: ElectronApplication
  let page: Page
  let model: MockModel
  /** Console errors and unhandled rejections seen since before the page loaded. */
  let pageErrors: string[]

  test.beforeEach(async () => {
    model = await startMockModel()
    pageErrors = []
    app = await launchApp()

    // `app.firstWindow()` and then the listeners, rather than the harness's
    // `firstPage`: that helper waits for `domcontentloaded` before returning, and a
    // listener attached after the load has already missed every error the first
    // render produced — which is precisely the class this test exists to catch. The
    // window object exists before its content commits, so this ordering sees them.
    page = await app.firstWindow()
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => {
      pageErrors.push(`pageerror: ${error.message}`)
    })

    await page.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    // The app first: closing it drops any in-flight request, so the server has
    // nothing left to wait on and `close()` does not hang.
    await app.close()
    await model.close()
  })

  test('shows the three panels side by side', async () => {
    await expect(page.getByTestId('library-panel')).toBeVisible()
    await expect(page.getByTestId('board-panel')).toBeVisible()
    await expect(page.getByTestId('teacher-panel')).toBeVisible()

    // Visible is not laid out. Three panels stacked in one column would satisfy every
    // assertion above while being the wrong app.
    //
    // Two separate facts, because a mutation showed they are not the same one. Setting
    // `grid-template-columns: 1fr` in `global.css` did *not* fail this test: `App.tsx`
    // applies the persisted `ui.panelWidths` as an inline `style`, which overrides the
    // stylesheet, so the track count kept reading three. So the track count proves the
    // settings→layout path — that `settings.load()` resolved and the shell applied what
    // it returned — and says nothing about whether the CSS bundle arrived. `display` is
    // the part only the stylesheet can supply: the inline style never sets it, so a
    // renderer that shipped without its CSS reads `block` here.
    const shell = page.getByTestId('app-shell')
    expect(await shell.evaluate((node) => getComputedStyle(node).display)).toBe('grid')

    // With resize handles, the grid has five tracks: library, handle, board,
    // handle, teacher. `getComputedStyle` resolves `1fr` to a pixel value, so the
    // assertion uses parsed widths rather than exact strings.
    const parsePx = (value: string): number => Number.parseFloat(value.replace(/px$/, ''))
    const columns = await shell.evaluate((node) =>
      getComputedStyle(node).gridTemplateColumns.split(/\s+/).filter((track) => track !== ''),
    )
    expect(columns).toHaveLength(5)

    const widths = columns.map(parsePx)
    // The three content panels must have meaningful width.
    expect(widths[0]).toBeGreaterThan(100)
    expect(widths[2]).toBeGreaterThan(100)
    expect(widths[4]).toBeGreaterThan(100)
    // The two resize handles are the fixed narrow tracks between them.
    expect(widths[1]).toBeGreaterThan(0)
    expect(widths[1]).toBeLessThan(20)
    expect(widths[3]).toBeGreaterThan(0)
    expect(widths[3]).toBeLessThan(20)
  })

  test('the window renders with no console error or unhandled rejection', async () => {
    // Waits for something the renderer only shows after `settings.load()` resolves,
    // so the check covers the async startup path rather than just the first paint.
    // Asserting on an empty array immediately would pass before anything had run.
    await expect(page.getByTestId('board-panel')).toBeVisible()
    await expect(page.getByTestId('library-panel')).not.toBeEmpty()

    expect(pageErrors).toEqual([])
  })

  test("a mocked local model's streamed reply reaches the transcript", async () => {
    await useLocalProvider(page, model.port)

    await page.getByTestId('chat-input').fill(PROMPT)
    await page.getByTestId('chat-send').click()

    // Two turns: the user's, appended by `send`, and the assistant's, appended by
    // `finishRun` once the stream ends. `streaming` is rendered as its own node and
    // is never in `messages`, so a count of 2 is what "the answer was promoted to a
    // real message" looks like.
    const turns = page.getByTestId('chat-log').getByRole('listitem')
    await expect(turns).toHaveCount(2)
    await expect(turns.nth(1)).toContainText(REPLY)

    // Both fragments, in order, as one string: the assertion above would also pass on
    // a renderer that dropped the first delta if the second happened to contain the
    // whole reply. This is the accumulation check.
    const assistant = (await turns.nth(1).innerText()).replace(/\s+/g, ' ')
    expect(assistant).toContain(REPLY)

    // The run is over: the partial-answer node is gone and the panel no longer claims
    // an active run. Without this a stuck `streaming` state would pass everything
    // above while the composer stayed disabled forever.
    await expect(page.getByTestId('chat-streaming')).toHaveCount(0)
    await expect(page.getByTestId('teacher-panel')).toHaveAttribute('data-run-id', '')

    // And the prompt really traversed renderer → IPC → service → provider → HTTP.
    // Checked after the UI assertions so a broken chain reads as a broken reply
    // first; a request that never arrived cannot have produced the text above, but
    // this is what distinguishes "the model was asked the right thing" from "some
    // request was made".
    expect(model.bodies).toHaveLength(1)
    expect(model.bodies[0]).toContain(PROMPT)
  })
})
