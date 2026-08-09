import { expect, test, type ElectronApplication } from '@playwright/test'
import { firstPage, launchApp } from './harness'

/**
 * Stage 5's gate, as a test: the preload boundary is a **security boundary**, not
 * a typing concern.
 *
 * ## Why this launches the built app instead of constructing a window
 *
 * A spec that built its own `BrowserWindow` with safe `webPreferences` would
 * prove only that the spec sets safe flags. What must be verified is that
 * `main/window.ts` does, on the window the app actually ships. So this loads
 * `out/main/index.js` and inspects whatever window the app creates.
 *
 * That choice found a real defect the moment it was first run. Every gate through
 * Stage 4 ran typecheck, lint, and vitest — none of which load the built bundle —
 * and the built app did not start at all: `externalizeDepsPlugin()` had left
 * `@gomentor/shared` as a runtime `require()`, Node resolved it to the package's
 * uncompiled ESM `.ts` entry, and the CJS main bundle died with
 * `SyntaxError: Unexpected token 'export'`. A green suite over source that never
 * runs the artifact is exactly the shape of gap this file closes.
 *
 * ## Why every assertion runs inside the page
 *
 * `typeof window.require` read from the test process would describe the test
 * process. These assertions are evaluated in the renderer's own context via
 * `page.evaluate`, which is the only place the question means anything.
 *
 * ## Why the launch details are not here
 *
 * They live in `harness.ts`, each with the measurement that produced it — the
 * `ELECTRON_RUN_AS_NODE` omission, the built-bundle precondition, and the load
 * wait. This spec deliberately does not restate them; Stage 6 adds five more
 * specs, and a launch detail explained in six places is a launch detail that will
 * disagree with itself.
 */

let app: ElectronApplication

test.beforeAll(async () => {
  // No isolated `userDataDir`: nothing here writes settings or secrets, and the
  // default profile is what a user actually runs. A2's restart spec is the one
  // that needs isolation, and it asks for it explicitly.
  app = await launchApp()
})

test.afterAll(async () => {
  // No `app?.` — a failure in `beforeAll` aborts the suite before this runs, so
  // the optional chain would be unreachable and lint rightly rejects it.
  await app.close()
})

test('the shipped window has the security flags set in main, not just in this test', async () => {
  // `getLastWebPreferences()` returns null until the window has actually loaded —
  // it reports the preferences of the *last committed* navigation, not the ones
  // passed to the constructor. `firstPage` awaiting the load is what makes it
  // non-null; without that the assertion fails against `null` and says nothing
  // about the flags.
  await firstPage(app)

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) return null

    /**
     * `getLastWebPreferences` exists at runtime but is absent from
     * `electron.d.ts` — it is undocumented internal API. Declaring the one method
     * being called, rather than casting the whole `webContents` to a permissive
     * type, keeps the fields below type-checked: a typo in `contextIsolation`
     * would still be a compile error, which is the entire reason this project
     * loads Electron's types.
     *
     * The narrow risk is that an Electron upgrade removes it. That surfaces as
     * this test failing loudly, not as a silent pass, because a missing method
     * throws rather than returning a conveniently-empty object.
     *
     * Reading configuration is deliberately *not* the only check — see the
     * behavioural test below, which is the assertion that actually matters. Both
     * are here because they catch different things: with `sandbox: false` but
     * `contextIsolation: true`, the page still cannot reach Node, so the
     * behavioural test passes and only this one fails. Measured, not assumed.
     */
    const internal = win.webContents as typeof win.webContents & {
      getLastWebPreferences: () => Electron.WebPreferences | null
    }
    const p = internal.getLastWebPreferences()
    return p === null
      ? null
      : {
          contextIsolation: p.contextIsolation,
          nodeIntegration: p.nodeIntegration,
          sandbox: p.sandbox,
          webSecurity: p.webSecurity,
          nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
          webviewTag: p.webviewTag,
        }
  })

  // Not `toBeTruthy()` on each field: `undefined` is truthy for none of these but
  // `nodeIntegration: undefined` would *also* satisfy `toBe(false)` under a loose
  // matcher. Reading the whole object at once means a renamed or dropped key
  // fails rather than passing vacuously.
  expect(prefs).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    // Not set explicitly in `window.ts` — asserted because Electron's defaults
    // are what protect these, and a future `webPreferences` edit that flipped a
    // default should fail here.
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
  })
})

test('no Node API is reachable from the page', async () => {
  const page = await firstPage(app)

  const reachable = await page.evaluate(() => ({
    ipcRenderer: typeof (window as unknown as Record<string, unknown>)['ipcRenderer'],
    require: typeof (window as unknown as Record<string, unknown>)['require'],
    process: typeof (window as unknown as Record<string, unknown>)['process'],
    module: typeof (window as unknown as Record<string, unknown>)['module'],
    Buffer: typeof (window as unknown as Record<string, unknown>)['Buffer'],
    electron: typeof (window as unknown as Record<string, unknown>)['electron'],
    globalRequire: typeof (globalThis as unknown as Record<string, unknown>)['require'],
  }))

  expect(reachable).toEqual({
    ipcRenderer: 'undefined',
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    Buffer: 'undefined',
    electron: 'undefined',
    globalRequire: 'undefined',
  })
})

test('the bridge is immutable from the page and exposes exactly the contract', async () => {
  const page = await firstPage(app)

  /**
   * ## What this test does and does not attribute to our code
   *
   * Removing `Object.freeze` from `src/preload/index.ts` does NOT make this test
   * fail — verified by mutation. That is not a coverage gap; it is a measured fact
   * about `contextBridge`, checked directly with a preload that exposes a
   * deliberately unfrozen object: the page still sees
   * `Object.isFrozen(...) === true` at the root *and* on nested groups, and writes
   * are still ignored. `contextBridge` builds a fresh frozen mirror in the page's
   * realm rather than handing over the preload's object.
   *
   * So the property asserted here is real and load-bearing — a page cannot swap
   * `window.gomentor.settings.setSecret` to intercept an API key — but Electron is
   * what guarantees it, not our `Object.freeze` call. That call is kept because it
   * makes the intent explicit at the definition site and protects the object
   * inside preload's own scope, where `contextBridge` offers nothing; it is
   * documented in the preload as belt-and-braces rather than as the mechanism.
   *
   * The test stays for the same reason a measured guarantee is still worth
   * asserting: it is the check that would catch an Electron upgrade weakening the
   * mirror, or a future preload that exposes a live reference some other way.
   */
  const bridge = await page.evaluate(() => {
    const g = window.gomentor as unknown as Record<string, unknown> | undefined
    if (g === undefined) return null

    // Attempt the substitution a hostile or buggy page would make: swapping a
    // method to intercept everything the app sends. Non-strict page context
    // ignores the write rather than throwing, so the assertion is on the
    // *effect*, not on a thrown error.
    const before = g['version']
    try {
      g['version'] = 'hijacked'
      g['injected'] = () => 'evil'
    } catch {
      // A strict-mode context would throw instead; either outcome is a pass, so
      // long as the checks below hold.
    }

    return {
      frozen: Object.isFrozen(g),
      // The nested groups too. A frozen root with a mutable
      // `g.settings` would leave `setSecret` replaceable, which is the method
      // where interception would matter most.
      nestedFrozen: ['sgf', 'library', 'llm', 'settings'].every((k) =>
        Object.isFrozen(g[k] as object),
      ),
      versionUnchanged: g['version'] === before,
      injectionAbsent: !('injected' in g),
      keys: Object.keys(g).sort(),
    }
  })

  expect(bridge).not.toBeNull()
  expect(bridge?.frozen).toBe(true)
  expect(bridge?.nestedFrozen).toBe(true)
  expect(bridge?.versionUnchanged).toBe(true)
  expect(bridge?.injectionAbsent).toBe(true)

  // The exact surface, not a subset. An extra key is as much a finding as a
  // missing one — the bridge's whole value is that it is only the contract, and
  // something added here would be reachable by any script on the page.
  expect(bridge?.keys).toEqual(
    [
      'version',
      'sgf',
      'library',
      'llm',
      'settings',
      'onLlmDelta',
      'onLlmDone',
      'onLlmError',
      'onLibraryChanged',
      'onMenuCommand',
      'onEngineStatus',
    ].sort(),
  )
})

test('an error crosses the bridge as data with its code intact', async () => {
  const page = await firstPage(app)

  /**
   * Sending a chat message with no API key configured is the real, reachable
   * failure path: the app has just booted with default settings and no secret.
   *
   * The error arrives on the `llm:error` *event*, not as the invoke result. That
   * is not an accident of this test — `llm:sendMessage` returns a `runId`
   * immediately and the reply streams (`llm/service.ts`: "Issued here, before
   * anything can fail, so an error is always reportable against a run the
   * renderer knows about"). This test was first written asserting `ok: false` on
   * the invoke result and failed with `ok: true`, which is how the actual
   * contract got read instead of assumed.
   *
   * So this covers both halves of the boundary in one pass: the immediate
   * `{ ok: true, data: { runId } }`, and the envelope's `code` surviving the trip
   * out over an event. The second half is the one that matters most — Stage 5
   * measured that a *thrown* `AppError` loses `code`, `context`, and `name`
   * entirely across `contextBridge`, arriving as a bare `Error` with
   * `Object.keys()` empty. Returning envelopes as data is what preserves the
   * renderer's `code` → `errors` i18n chain, and this is the assertion that would
   * catch a regression back to throwing.
   */
  const result = await page.evaluate(async () => {
    const errors: {
      runId: string
      code: string
      hasStack: boolean
      hasCause: boolean
      codeType: string
    }[] = []

    const off = window.gomentor.onLlmError((payload) => {
      errors.push({
        runId: payload.runId,
        code: payload.error.code,
        codeType: typeof payload.error.code,
        hasStack: 'stack' in payload.error,
        hasCause: 'cause' in payload.error,
      })
    })

    const sent = await window.gomentor.llm.sendMessage({
      content: 'hello',
      history: [],
    })

    // Poll rather than a fixed sleep: the provider construction that throws
    // happens on a microtask, so this normally resolves in well under a frame.
    const deadline = Date.now() + 10_000
    while (errors.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    off()

    return {
      sendOk: sent.ok,
      runId: sent.ok ? sent.data.runId : null,
      errors,
    }
  })

  // The handle comes back immediately — streaming cannot be modelled as
  // request/response.
  expect(result.sendOk).toBe(true)
  expect(typeof result.runId).toBe('string')

  expect(result.errors).toHaveLength(1)
  const failure = result.errors[0]
  expect(failure?.codeType).toBe('string')
  expect(failure?.code).toBe('LLM_NO_KEY')
  // Correlated by runId, which is the only thing tying a stream's events to the
  // call that started it.
  expect(failure?.runId).toBe(result.runId)
  // `logging-guidelines.md`: no stack and no cause may reach the renderer. Both
  // are stripped by `AppError.toEnvelope()`; this is the end-to-end check that
  // they really are absent at the far side.
  expect(failure?.hasStack).toBe(false)
  expect(failure?.hasCause).toBe(false)
})

test('a malformed request is rejected at the boundary, naming the field but not its value', async () => {
  const page = await firstPage(app)

  // The renderer is typed, so this shape is a compile error at any honest call
  // site — hence the cast, and hence the value of the test: it proves what
  // happens when the renderer is *wrong*, which types cannot rule out for a
  // renderer bug or a compromised page. This case was not written from the spec;
  // it was found by getting the request shape wrong by accident and watching
  // `IPC_INVALID_REQUEST` come back, which is how it became worth asserting.
  const result = await page.evaluate(async () => {
    const send = window.gomentor.llm.sendMessage as unknown as (
      request: unknown,
    ) => Promise<{
      ok: boolean
      error?: { code: string; message: string; context?: unknown }
    }>
    const r = await send({ runId: 'wrong-shape', messages: [] })
    return {
      ok: r.ok,
      code: r.error?.code,
      message: r.error?.message,
      context: r.error?.context,
    }
  })

  expect(result.ok).toBe(false)
  expect(result.code).toBe('IPC_INVALID_REQUEST')
  // Paths, never values: a rejected `settings:setSecret` request contains the
  // user's API key, and a zod issue would quote it (`register.ts` `issuePaths`).
  // Asserting the shape here is what keeps that decision from being "simplified"
  // into a friendlier message that leaks the payload.
  expect(result.context).toEqual({ issues: ['content'] })
  expect(JSON.stringify(result)).not.toContain('wrong-shape')
})

test('an event subscription delivers the payload, and the returned function stops delivery', async () => {
  const page = await firstPage(app)

  /**
   * Emits `engine:status` from the main process, which is the only side that can.
   * `app.evaluate` runs in main, so this drives the real `webContents.send` path
   * rather than faking an event in the page.
   *
   * `engine:status` is chosen because M1 has no engine: `unavailable` is the only
   * state it ever carries, so re-emitting it changes nothing observable in the
   * app while still being a genuine, schema-validated event.
   */
  const emitStatus = () =>
    app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          win.webContents.send('engine:status', { status: 'unavailable' })
      }
    })

  // Install the listener and hold the unsubscribe on the page, so the two halves
  // can be driven from here with a main-side emit in between.
  const unsubscribeType = await page.evaluate(() => {
    const w = window as unknown as { __seen?: string[]; __off?: () => void }
    w.__seen = []
    w.__off = window.gomentor.onEngineStatus((payload) => {
      w.__seen?.push(payload.status)
    })
    return typeof w.__off
  })
  expect(unsubscribeType).toBe('function')

  await emitStatus()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __seen: string[] }).__seen.length),
    )
    .toBeGreaterThan(0)

  const delivered = await page.evaluate(() =>
    (window as unknown as { __seen: string[] }).__seen.slice(),
  )
  // Not merely "something arrived": the payload itself must cross intact, since
  // the registrars deliberately forward only the payload and drop
  // `IpcRendererEvent`.
  expect(delivered).toContain('unavailable')

  const countBeforeUnsubscribe = delivered.length

  // Now the half that actually matters. A registrar that returned a no-op
  // function would pass every assertion above.
  await page.evaluate(() => {
    ;(window as unknown as { __off: () => void }).__off()
  })
  await emitStatus()
  await emitStatus()

  // Give a delivery that should not happen time to happen. There is no positive
  // signal to wait for here — the assertion is an absence — so a fixed settle is
  // the honest way to test it, and two emits make a single lost message an
  // unlikely explanation for a pass.
  await page.waitForTimeout(300)

  const after = await page.evaluate(
    () => (window as unknown as { __seen: string[] }).__seen.length,
  )
  expect(after).toBe(countBeforeUnsubscribe)
})
