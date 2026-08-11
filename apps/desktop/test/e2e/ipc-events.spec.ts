import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { firstPage, launchApp } from './harness'

/**
 * A real record from the corpus, for the one test that needs the library to be
 * non-empty.
 *
 * The shared corpus rather than a hand-written `(;GM[1])`: a minimal string would
 * make the test depend on the parser accepting something no tool produces, and this
 * file is already the parser's own fixture.
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

/**
 * `useIpcEvent` and `useMainProcessEvents`, against the built app.
 *
 * ## Why this is an e2e spec and not a unit test
 *
 * The hook needs `useRef` and `useEffect`, so it needs a DOM — and the choice was
 * between adding jsdom plus a testing library, or testing it here. This repo has
 * no jsdom boundary and adding one to cover a single hook buys a dependency and a
 * second, weaker notion of "rendered": jsdom would let us assert that a *fake*
 * registrar is called and torn down correctly, but the thing most likely to be
 * wrong is the real chain — main emits, `contextBridge` delivers, the ref-held
 * handler runs, the store updates, React repaints. jsdom cannot see any of that.
 * Here the events are emitted from the actual main process.
 *
 * ## The run is started through the UI, and against a `local` provider
 *
 * Two corrections are baked into `startRun` below, both of them failures first.
 *
 * The first draft called `window.gomentor.llm.sendMessage` directly from
 * `page.evaluate` to obtain a runId. Every delta assertion failed, and the failure
 * was correct: `sendMessage` over the bridge does not touch `chatStore`, so
 * `activeRunId` stayed null and `receiveChunk` dropped every chunk exactly as
 * designed. The test had built its own path around the store and then tested that
 * path. Typing into the real composer and clicking the real button is what puts the
 * store into the state the filter reads.
 *
 * The second draft then failed with `activeRunId` still empty, and the reason is
 * worth recording because it constrains every future LLM e2e test: with the default
 * `kind: 'cloud'` and no API key, `send` fails at provider construction with
 * `LLM_NO_KEY` — measured, the panel showed "尚未设置 API 密钥". A CI runner has no
 * key and never will, so a spec that needs a runId cannot use the cloud path at
 * all. Switching `llm.kind` to `local` is the real user path for a local model
 * server, needs no credential, and still issues a runId: `send` returns one before
 * any request is attempted. Nothing here supplies a fake key, and no test-only
 * branch exists in the app.
 *
 * The runId is then read out of the panel's `data-run-id`, because it is issued in
 * main and only the store learns it. The alternative — exposing the store on
 * `window` — would be a test-only backdoor into renderer state; see the comment on
 * that attribute in `TeacherPanel.tsx`.
 *
 * ## The events are emitted from main, not faked in the page
 *
 * `app.evaluate` runs in main, so the send below goes through the same
 * `webContents.send` every real feature uses. A page-side `dispatchEvent` would
 * have tested a listener wired to nothing.
 */

/** Emits an event from the main process, exactly as a real feature would. */
async function emitFromMain(
  app: ElectronApplication,
  event: string,
  payload: unknown,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { event: name, payload: body }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue
        window.webContents.send(name, body)
      }
    },
    { event, payload },
  )
}

/**
 * A local OpenAI-compatible endpoint that accepts the request and then says
 * nothing.
 *
 * ## Why a real server rather than an unreachable address
 *
 * The draft before this one pointed `baseUrl` at `http://127.0.0.1:1/v1`, which
 * refuses the connection instantly. `send` then failed with `LLM_UNREACHABLE`
 * before the assertions ran, `failRun` cleared `activeRunId`, and `data-run-id` was
 * empty — measured, the panel showed "无法连接到 AI 服务". The run had not failed to
 * start; it had started and finished faster than the test could look.
 *
 * A socket that stays open holds the run in `streaming` for as long as the spec
 * needs. `createLocalProvider` uses a 300s timeout and zero retries, so an
 * unanswered request simply waits — the exact behaviour a cold local model relies
 * on, which is why this is a realistic condition rather than a contrived one.
 *
 * Nothing is stubbed inside the app: the provider, the service, and the IPC path
 * are all the shipping ones. What is faked is the *server on the other end*, which
 * is the only piece a CI runner genuinely cannot have.
 */
function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  // Deliberately never responds: answering — even with an error — would let the
  // provider finish and clear the run. The request object is left untouched rather
  // than destroyed, so the socket stays open and the client keeps waiting.
  const server: Server = createServer(() => {
    // Intentionally empty. See above.
  })

  return new Promise((resolve) => {
    // Port 0 lets the OS choose, so parallel workers cannot collide on a
    // hard-coded port.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      // Narrowed rather than asserted: `address()` is `string | AddressInfo | null`,
      // and only the object form has a port.
      if (address === null || typeof address === 'string') {
        throw new Error('silent server did not bind to a TCP port')
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            // `closeAllConnections` first: the app's request is still open, and
            // `close()` alone waits for it, which would hang the teardown.
            server.closeAllConnections()
            server.close(() => {
              done()
            })
          }),
      })
    })
  })
}

/**
 * Points the app at that server, so `send` needs no API key.
 *
 * Written through `settings:set` rather than into `settings.json` before launch:
 * this is the same path the settings panel will take, and it additionally proves
 * the write reaches the running `LlmService` — `settings.update` calls
 * `invalidate()`, so the next send rebuilds the provider from the new document
 * instead of reusing the cached cloud one that threw.
 */
async function useLocalProvider(page: Page, port: number): Promise<void> {
  const ok = await page.evaluate(async (localPort) => {
    const result = await window.gomentor.settings.set({
      patch: {
        llm: { kind: 'local', baseUrl: `http://127.0.0.1:${String(localPort)}/v1` },
      },
    })
    return result.ok
  }, port)
  // Fail loudly here rather than letting `startRun` time out on an empty
  // `data-run-id`, which would point at the wrong thing.
  expect(ok).toBe(true)
}

/**
 * Sends a message through the UI and returns the runId main issued for it.
 *
 * Switches to the local provider first, because every caller needs that and a
 * caller who forgot would get a timeout on an empty `data-run-id` pointing at the
 * wrong cause.
 *
 * The run is left streaming on purpose. It is never answered and never cancelled:
 * the deltas the tests below assert on are emitted from main, and a run that
 * finished would have cleared `activeRunId` and made `receiveChunk` drop them.
 *
 * `expect(...).not.toHaveAttribute` rather than reading the attribute straight
 * after the click: `send` awaits an IPC round trip before setting `activeRunId`, so
 * the id is not there synchronously. Waiting for a non-empty value is the only
 * honest way to know it arrived, and a timeout here means the send genuinely failed
 * rather than that the test was too quick.
 */
async function startRun(page: Page, port: number): Promise<string> {
  await useLocalProvider(page, port)
  await page.getByTestId('chat-input').fill('probe')
  await page.getByTestId('chat-send').click()

  const panel = page.getByTestId('teacher-panel')
  await expect(panel).not.toHaveAttribute('data-run-id', '')
  const runId = await panel.getAttribute('data-run-id')
  // Narrowed rather than asserted with `!`: `getAttribute` is `string | null`, and
  // the expect above only proves it is not the empty string.
  if (runId === null) throw new Error('teacher panel carried no data-run-id')
  return runId
}

/**
 * The streamed text currently on screen, or '' when the node is absent.
 *
 * Read through the DOM rather than out of the store: what matters is that a delta
 * reaches the *screen*. A store that updated while React never repainted would be
 * the stale-closure bug wearing a disguise, and only the rendered text rules it
 * out.
 */
async function streamingText(page: Page): Promise<string> {
  const node = page.getByTestId('chat-streaming')
  if ((await node.count()) === 0) return ''
  return (await node.innerText()).trim()
}

test.describe('main→renderer events reach the store and the screen', () => {
  let app: ElectronApplication
  let page: Page
  let server: { port: number; close: () => Promise<void> }

  test.beforeEach(async () => {
    // A fresh app per test: these assert on accumulated stream state, and a shared
    // instance would make each test depend on the previous one's leftovers.
    server = await startSilentServer()
    app = await launchApp()
    page = await firstPage(app)
  })

  test.afterEach(async () => {
    // The app first: closing it drops the pending request, so the server has
    // nothing left to wait on.
    await app.close()
    await server.close()
  })

  test('an llm:delta is rendered, and a second one accumulates', async () => {
    const runId = await startRun(page, server.port)

    await emitFromMain(app, 'llm:delta', {
      runId,
      chunk: { type: 'text', delta: 'first' },
    })
    await expect(page.getByTestId('chat-streaming')).toContainText('first')

    await emitFromMain(app, 'llm:delta', {
      runId,
      chunk: { type: 'text', delta: '-second' },
    })
    // Accumulated, not replaced. A handler frozen at its first render would still
    // show 'first' here — this is the assertion that `useIpcEvent`'s ref exists
    // for, made against the real bridge.
    await expect(page.getByTestId('chat-streaming')).toContainText('first-second')
  })

  test("a foreign runId's delta never reaches the screen", async () => {
    const runId = await startRun(page, server.port)

    await emitFromMain(app, 'llm:delta', {
      runId: `${runId}-not-this-one`,
      chunk: { type: 'text', delta: 'INTERLOPER' },
    })

    // A cancelled run's tokens still arrive; unfiltered they interleave an
    // abandoned answer into a live one and read as the model malfunctioning. The
    // legitimate delta is sent second so there is something to wait for — asserting
    // only the absence would pass against a bridge that delivered nothing at all.
    await emitFromMain(app, 'llm:delta', {
      runId,
      chunk: { type: 'text', delta: 'mine' },
    })
    await expect(page.getByTestId('chat-streaming')).toContainText('mine')
    expect(await streamingText(page)).not.toContain('INTERLOPER')
  })

  test('each delta is handled exactly once', async () => {
    const runId = await startRun(page, server.port)

    await emitFromMain(app, 'llm:delta', {
      runId,
      chunk: { type: 'text', delta: 'xy' },
    })
    await expect(page.getByTestId('chat-streaming')).toContainText('xy')

    // 'xy' once, not twice. Doubling is the signature of a listener registered more
    // than once — the effect re-running without its teardown having removed the
    // previous subscription.
    //
    // A caveat on this test's reach, established by mutation and recorded so nobody
    // reads more into a green run than it earns: discarding `subscribe`'s return
    // value in `useIpcEvent` does *not* fail here. The built renderer is a
    // production React bundle (`react.dev/errors` present, dev warning text absent),
    // where StrictMode does not double-invoke effects, and `App` never remounts
    // during this spec — so nothing asks the teardown to run. What this does prove
    // is that a single mount registers a single listener, which is the property the
    // shipped app depends on. Teardown correctness is exercised by the dev build and
    // remains uncovered by machine test; see the Stage 7 gate report.
    const text = await streamingText(page)
    expect(text.match(/xy/g)?.length ?? 0).toBe(1)
  })

  /**
   * The premise behind passing `window.gomentor.onLlmDelta` as a bare property read.
   *
   * `useIpcEvent` puts `subscribe` in its dependency array, so a `contextBridge` that
   * minted a fresh function per property access would tear down and resubscribe on
   * every render — dropping events in the gap, which for `llm:delta` is a missing
   * token mid-answer — and would force a `useCallback` at every call site. The hook's
   * doc comment asserts the mirror is built once; this is where that is measured,
   * against the real bridge in the built app rather than argued from the docs.
   */
  test('contextBridge returns a stable reference for a repeated property read', async () => {
    const identity = await page.evaluate(() => {
      const first = window.gomentor.onLlmDelta
      const second = window.gomentor.onLlmDelta
      return {
        sameFn: first === second,
        sameGroup: window.gomentor.llm === window.gomentor.llm,
      }
    })
    expect(identity).toEqual({ sameFn: true, sameGroup: true })
  })

  test('a library:changed refreshes a list the renderer never updated itself', async () => {
    // Imported over the bridge, *not* through `LibraryPanel`'s button. That
    // distinction is the whole test: `libraryStore.importFiles` sets the list from
    // the import response, so a UI-driven import would show the game whether or not
    // any event was ever delivered. A bare bridge call leaves the store untouched,
    // and `library:changed` — emitted by `library:import` in main — is then the only
    // path by which the list can learn the game exists.
    const ok = await page.evaluate(async (filePath) => {
      const result = await window.gomentor.library.import({ filePaths: [filePath] })
      return result.ok && result.data.imported.length === 1
    }, FIXTURE_SGF)
    // Checked separately so a broken import reads as a broken import rather than as
    // a missing subscription.
    expect(ok).toBe(true)

    await expect(page.getByTestId('library-count')).toBeVisible()
    await expect(page.getByTestId('library-list').getByRole('listitem')).toHaveCount(1)
  })
})
