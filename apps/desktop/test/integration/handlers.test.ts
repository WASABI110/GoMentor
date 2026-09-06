import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHANNELS,
  CHANNEL_NAMES,
  type ChannelName,
  type IpcResult,
  type Locale,
  type SecretKey,
} from '@gomentor/shared'
// Type-only, so this is erased at compile time and does not load the module
// before `vi.mock` takes effect — the reason the value imports below are dynamic.
import type { SettingsFs } from '../../src/main/settings'

/**
 * IPC handler integration: every channel registered, every response valid
 * against its own contract schema.
 *
 * The Stage 4 gate criterion is "handlers integration test passes; no
 * schema/handler drift". Drift is the interesting half. A per-handler unit test
 * that asserted on a hand-written expected object would keep passing after the
 * contract changed, because the expectation and the schema are two independent
 * copies of the same claim. So responses here are validated against
 * `CHANNELS[channel].response` itself — the same schema `register.ts` uses and
 * the renderer trusts.
 *
 * ## Why `electron` is mocked rather than the handlers being called directly
 *
 * `handle()` registers a closure with `ipcMain` and that closure — not the
 * handler body — is where request validation, dev-only response validation, and
 * throw-to-envelope conversion live. Calling handler functions directly would
 * test the bodies and skip the entire boundary, which is the part with the
 * security-relevant behaviour. So `ipcMain` is captured and the registered
 * closures are invoked exactly as Electron would.
 */

/** Channel → the closure `handle()` registered. Populated by the mock below. */
const registered = new Map<
  string,
  (event: unknown, payload: unknown) => Promise<unknown>
>()

/** What `dialog.showOpenDialog` resolves to; per-test overridable. */
let dialogResult: { canceled: boolean; filePaths: string[] } = {
  canceled: true,
  filePaths: [],
}

/** Payloads pushed via `webContents.send`, so event fan-out is observable. */
const sentEvents: { channel: string; payload: unknown }[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle(
      channel: string,
      listener: (event: unknown, payload: unknown) => Promise<unknown>,
    ) {
      registered.set(channel, listener)
    },
    removeHandler(channel: string) {
      registered.delete(channel)
    },
  },
  dialog: {
    showOpenDialog: () => Promise.resolve(dialogResult),
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send(channel: string, payload: unknown) {
            sentEvents.push({ channel, payload })
          },
        },
      },
    ],
  },
  app: {
    getPath: () => '/virtual/userData',
    isPackaged: false,
    getVersion: () => '0.1.0',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from('unused'),
    decryptString: () => 'unused',
  },
  shell: { openPath: () => Promise.resolve('') },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
}))

// Imported after `vi.mock` so the mocked `electron` is what these modules bind.
const { registerAllHandlers } = await import('../../src/main/ipc/index')
const { createGameStore } = await import('../../src/main/library/store')
const { createSettingsService } = await import('../../src/main/settings')

/** A fixed clock: `importedAt` would otherwise make every expectation a moving target. */
const NOW = '2026-01-01T00:00:00.000Z'

/** Minimal but real SGF. Parsed by the actual core parser, not a stub. */
const SGF =
  '(;GM[1]FF[4]CA[UTF-8]SZ[19]PB[Black]PW[White]KM[6.5]RE[B+R];B[pd];W[dp];B[pp])'

function memoryFs(): SettingsFs {
  const files = new Map<string, string>()
  return {
    read: (path) => files.get(path),
    write: (path, contents) => {
      files.set(path, contents)
    },
    preserve: (path, contents) => {
      files.set(`${path}.corrupt`, contents)
    },
  }
}

/** In-memory secrets service. The real one is covered by `safe-storage.test.ts`. */
function fakeSecrets() {
  const held = new Map<SecretKey, string>()
  return {
    set(key: SecretKey, value: string) {
      held.set(key, value)
    },
    get: (key: SecretKey) => held.get(key),
    has: (key: SecretKey) => held.has(key),
    delete(key: SecretKey) {
      held.delete(key)
    },
    isPersistent: () => true,
  }
}

/** Records what it was asked to do; `send` returns a deterministic id. */
function fakeLlm() {
  const calls: { sent: { content: string }[]; cancelled: string[] } = {
    sent: [],
    cancelled: [],
  }
  return {
    calls,
    send(input: { content: string }) {
      calls.sent.push({ content: input.content })
      return 'run-1'
    },
    cancel(runId: string) {
      calls.cancelled.push(runId)
    },
    health: () => Promise.resolve(true),
    invalidate: () => undefined,
    shutdown: () => undefined,
  }
}

/**
 * In-memory engine service. The lifecycle itself is covered by
 * `engine-service.test.ts` against the real fake child; here it only needs to
 * prove the channels route to the service and return what it says. `setGame`
 * and `setCursor` return canned query ids so the routing assertion can tell
 * "the handler returned the service's answer" apart from "the handler made up
 * an answer".
 */
function fakeEngine() {
  const calls: { starts: number; games: unknown[]; cursors: number[] } = {
    starts: 0,
    games: [],
    cursors: [],
  }
  return {
    calls,
    info: () => ({ status: 'unavailable' as const }),
    start: () => {
      calls.starts += 1
      return Promise.resolve({ status: 'ready' as const, backend: 'eigen' as const })
    },
    setGame: (game: unknown) => {
      calls.games.push(game)
      return { focusQueryId: game === null ? null : 'focus:1' }
    },
    setCursor: (moveNumber: number) => {
      calls.cursors.push(moveNumber)
      return { focusQueryId: 'focus:2' }
    },
    notifyStatus: () => undefined,
    shutdown: () => Promise.resolve(),
  }
}

let store: ReturnType<typeof createGameStore>
let secrets: ReturnType<typeof fakeSecrets>
let llm: ReturnType<typeof fakeLlm>
let engine: ReturnType<typeof fakeEngine>

/**
 * Locales the fake `relabelMenu` was called with, most recent last.
 *
 * A recording fake rather than a no-op: main translates the native menu itself
 * from the shared i18n JSON (R10), so a `settings:set` that changes `locale` has
 * to rebuild it. A test that only proved the handler returned the document would
 * pass with that rebuild deleted, and the menu would stay in the old language
 * until the next launch.
 */
const relabelCalls: Locale[] = []

beforeEach(() => {
  registered.clear()
  sentEvents.length = 0
  relabelCalls.length = 0
  dialogResult = { canceled: true, filePaths: [] }
  store = createGameStore()
  secrets = fakeSecrets()
  llm = fakeLlm()
  engine = fakeEngine()
  registerAllHandlers({
    store,
    settings: createSettingsService(memoryFs(), '/virtual/settings.json'),
    secrets,
    llm,
    engine,
    now: () => NOW,
    relabelMenu: (locale) => relabelCalls.push(locale),
  })
})

/**
 * Invokes a channel the way Electron would, and validates the response against
 * the channel's own schema.
 *
 * The schema check is inside the helper rather than per-test so it cannot be
 * forgotten in a new case — that omission is exactly the drift this file exists
 * to catch.
 *
 * `channel: ChannelName` rather than a generic `<C extends ChannelName>`: the
 * return is deliberately `IpcResult<unknown>`, so a type parameter would appear
 * exactly once and link nothing. Tests assert on the envelope, and narrowing the
 * data here would mean trusting the contract this file is meant to be checking.
 */
async function invoke(
  channel: ChannelName,
  payload: unknown,
): Promise<IpcResult<unknown>> {
  const listener = registered.get(channel)
  if (listener === undefined) throw new Error(`no handler registered for ${channel}`)
  const result = (await listener({}, payload)) as IpcResult<unknown>
  if (result.ok) {
    const validation = CHANNELS[channel].response.safeParse(result.data)
    if (!validation.success) {
      throw new Error(
        `${channel} response failed its contract: ${validation.error.issues
          .map((issue) => issue.path.join('.'))
          .join(', ')}`,
      )
    }
  }
  return result
}

/** Puts a game in the store through the real parse path and returns its id. */
async function importOne(): Promise<string> {
  const result = await invoke('sgf:parse', { content: SGF })
  if (!result.ok) throw new Error(`setup failed: ${result.error.code}`)
  return (result.data as { id: string }).id
}

describe('registration covers the contract', () => {
  it('registers a handler for every channel in CHANNELS', () => {
    // The drift guard. A channel added to the contract without a handler shows up
    // here rather than as "no handler registered" in front of a user.
    expect([...registered.keys()].sort()).toEqual([...CHANNEL_NAMES].sort())
  })

  it('registers nothing that is not in the contract', () => {
    for (const channel of registered.keys()) {
      expect(CHANNEL_NAMES, channel).toContain(channel as ChannelName)
    }
  })

  it('is idempotent, so a second registration replaces rather than throws', () => {
    // `ipcMain.handle` throws on a duplicate channel. Re-registration happens on
    // settings-driven rebuilds, and a throw there would kill the app.
    expect(() => {
      registerAllHandlers({
        store,
        settings: createSettingsService(memoryFs(), '/virtual/settings.json'),
        secrets,
        llm,
        engine,
        now: () => NOW,
        relabelMenu: (locale) => relabelCalls.push(locale),
      })
    }).not.toThrow()
    expect(registered.size).toBe(CHANNEL_NAMES.length)
  })
})

describe('the boundary rejects bad requests', () => {
  it('returns IPC_INVALID_REQUEST rather than throwing', async () => {
    const result = await invoke('sgf:parse', { content: 42 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('IPC_INVALID_REQUEST')
  })

  it('rejects a missing payload on every channel', async () => {
    // Every channel, not a sampled one: an unvalidated channel is a `TypeError`
    // deep in a handler instead of a typed error at the boundary.
    for (const channel of CHANNEL_NAMES) {
      const result = await invoke(channel, undefined)
      if (result.ok) {
        // Legitimate only where the request schema accepts no input at all.
        expect(CHANNELS[channel].request.safeParse(undefined).success, channel).toBe(
          true,
        )
        continue
      }
      expect(result.error.code, channel).toBe('IPC_INVALID_REQUEST')
    }
  })

  it('does not echo the rejected value back to the renderer', async () => {
    // The leak that would matter: a `settings:setSecret` request contains the
    // key, and a zod issue quotes the offending input. Paths only.
    const result = await invoke('settings:setSecret', {
      key: 'llmApiKey',
      value: { nested: 'sk-live-4eC39HqLyjWDarjtT1zdp7dc' },
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('sk-live')
  })

  it('names a root-level rejection instead of reporting an empty path', async () => {
    // `issue.path` is empty when the payload itself is the wrong shape, and
    // `join('.')` turned that into `""` — a path list of empty strings reads like
    // a field name was lost, which sends the reader looking for the wrong bug.
    const result = await invoke('settings:hasSecret', 'not-an-object')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.context?.issues).toEqual(['(root)'])
  })

  it('maps an unexpected throw to a generic envelope', async () => {
    // A non-AppError must not cross with its own message: the renderer switches
    // on `code` against a closed enum, and its message must never be primary UI
    // text (`error-handling.md`).
    const exploding = {
      ...fakeSecrets(),
      has: () => {
        throw new Error('internal detail with /Users/james/secret/path')
      },
    }
    registerAllHandlers({
      store,
      settings: createSettingsService(memoryFs(), '/virtual/settings.json'),
      secrets: exploding,
      llm,
      engine,
      now: () => NOW,
      relabelMenu: (locale) => relabelCalls.push(locale),
    })
    const result = await invoke('settings:hasSecret', { key: 'llmApiKey' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('IPC_HANDLER_FAILED')
    expect(JSON.stringify(result)).not.toContain('/Users/james')
  })

  it('carries an AppError code through instead of flattening it', async () => {
    const result = await invoke('sgf:serialize', { gameId: 'does-not-exist' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // Not IPC_HANDLER_FAILED: the renderer needs the specific code to say
    // something useful.
    expect(result.error.code).toBe('LIBRARY_NOT_FOUND')
  })

  it('never lets an envelope carry a stack or a cause', async () => {
    // `logging-guidelines.md`: stack traces are logged in main; the renderer gets
    // a code. Asserted on the wire value, not on `toEnvelope` in isolation.
    const result = await invoke('sgf:serialize', { gameId: 'nope' })
    const wire = JSON.stringify(result)
    expect(wire).not.toContain('stack')
    expect(wire).not.toContain('cause')
    expect(wire).not.toContain('.ts:')
  })
})

describe('sgf channels', () => {
  it('parses and returns a game matching the contract', async () => {
    const result = await invoke('sgf:parse', { content: SGF })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const game = result.data as { moves: unknown[]; meta: { boardSize: number } }
    expect(game.moves).toHaveLength(3)
    expect(game.meta.boardSize).toBe(19)
  })

  it('round-trips through serialize from the AST', async () => {
    // From the AST, never from `Game.moves` — the projection drops variations, so
    // serialising from it would silently lose the user's tree (A5).
    const id = await importOne()
    const result = await invoke('sgf:serialize', { gameId: id })
    if (!result.ok) throw new Error('unreachable')
    const { content } = result.data as { content: string }
    expect(content).toContain('B[pd]')
    // Re-parsing the output must yield the same move count, which is the actual
    // round-trip property; string equality would fail on legal formatting
    // differences.
    const reparsed = await invoke('sgf:parse', { content })
    if (!reparsed.ok) throw new Error('unreachable')
    expect((reparsed.data as { moves: unknown[] }).moves).toHaveLength(3)
  })

  it('reports a cancelled dialog as an empty list, not an error', async () => {
    // A user changing their mind is not a failure; modelling it as one puts an
    // error dialog in front of them for doing nothing wrong.
    dialogResult = { canceled: true, filePaths: ['/should/be/ignored.sgf'] }
    const result = await invoke('sgf:openDialog', {})
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as { filePaths: string[] }).filePaths).toEqual([])
  })

  it('returns the chosen paths when the dialog is not cancelled', async () => {
    dialogResult = { canceled: false, filePaths: ['/a.sgf', '/b.sgf'] }
    const result = await invoke('sgf:openDialog', {})
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as { filePaths: string[] }).filePaths).toEqual([
      '/a.sgf',
      '/b.sgf',
    ])
  })

  // Asymmetric variations on purpose: child 0 continues two more moves (the
  // first-child mainline = 5 moves), child 1 is a single move (3 moves total).
  // The asymmetry is what makes a store overwrite observable in the library.
  const VAR_SGF = '(;GM[1]SZ[9];B[fd];W[ff](;B[ee];W[ef];B[de])(;B[df]))'

  it('parses a variation line when variationPath is given', async () => {
    const mainline = await invoke('sgf:parse', { content: VAR_SGF })
    if (!mainline.ok) throw new Error('unreachable')
    expect((mainline.data as { moves: unknown[] }).moves).toHaveLength(5)

    const variation = await invoke('sgf:parse', {
      content: VAR_SGF,
      variationPath: [1],
    })
    expect(variation.ok).toBe(true)
    if (!variation.ok) throw new Error('unreachable')
    const game = variation.data as {
      moves: { player: string; coord: { x: number; y: number } }[]
      branches: unknown[]
    }
    expect(game.moves).toHaveLength(3)
    // Move 3 is the variation's first move, B[df] — proof the path was followed.
    expect(game.moves[2]).toMatchObject({ player: 'black', coord: { x: 3, y: 5 } })
  })

  it('a branch re-parse does not rewrite the stored game', async () => {
    // The read-only branch view shares the store row with the imported game
    // (same content hash). The library row must keep the FIRST projection's
    // move count — the list showing 3 for a game the user imported as 5 is
    // the drift this guards — while the AST (and so sgf:serialize) keeps the
    // whole tree.
    const first = await invoke('sgf:parse', { content: VAR_SGF })
    if (!first.ok) throw new Error('unreachable')
    const id = (first.data as { id: string }).id

    const branch = await invoke('sgf:parse', { content: VAR_SGF, variationPath: [1] })
    if (!branch.ok) throw new Error('unreachable')
    expect((branch.data as { moves: unknown[] }).moves).toHaveLength(3)

    const list = await invoke('library:list', {})
    if (!list.ok) throw new Error('unreachable')
    const games = (list.data as { games: { id: string; moveCount: number }[] }).games
    expect(games.find((game) => game.id === id)?.moveCount).toBe(5)

    const serialized = await invoke('sgf:serialize', { gameId: id })
    if (!serialized.ok) throw new Error('unreachable')
    expect((serialized.data as { content: string }).content).toContain('B[df]')
  })

  it('rejects an out-of-range variationPath as IPC_INVALID_REQUEST', async () => {
    const result = await invoke('sgf:parse', { content: VAR_SGF, variationPath: [5] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('IPC_INVALID_REQUEST')
  })
})

describe('library channels', () => {
  it('lists what has been stored', async () => {
    await importOne()
    const result = await invoke('library:list', {})
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as { games: unknown[] }).games).toHaveLength(1)
  })

  it('reports a per-file failure as data rather than failing the batch', async () => {
    // The load-bearing behaviour: someone importing 300 games with a few
    // truncated files must still get the 297. A throw would lose them.
    const result = await invoke('library:import', {
      filePaths: ['/definitely/missing/one.sgf', '/definitely/missing/two.sgf'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as {
      imported: unknown[]
      failures: { filePath: string }[]
    }
    expect(data.failures).toHaveLength(2)
    expect(data.imported).toHaveLength(0)
  })

  it('does not put file contents in the failure envelope', async () => {
    const result = await invoke('library:import', { filePaths: ['/missing.sgf'] })
    if (!result.ok) throw new Error('unreachable')
    // The path is needed to act on the failure; contents are the user's study
    // material and must not ride along.
    expect(JSON.stringify(result.data)).toContain('/missing.sgf')
    expect(JSON.stringify(result.data)).not.toContain('ENOENT')
  })

  it('emits library:changed only when something was actually imported', async () => {
    await invoke('library:import', { filePaths: ['/missing.sgf'] })
    expect(
      sentEvents.filter((entry) => entry.channel === 'library:changed'),
    ).toHaveLength(0)
  })
})

describe('settings channels', () => {
  it('returns a document that validates against the contract', async () => {
    const result = await invoke('settings:get', {})
    expect(result.ok).toBe(true)
  })

  it('recomputes hasKey from the secrets service rather than the document', async () => {
    // A stored boolean would drift the moment a keychain became unavailable, and
    // the UI would offer to use a key that cannot be read.
    const before = await invoke('settings:get', {})
    if (!before.ok) throw new Error('unreachable')
    expect((before.data as { llm: { hasKey: boolean } }).llm.hasKey).toBe(false)

    await invoke('settings:setSecret', {
      key: 'llmApiKey',
      value: 'sk-live-abcdefghijklmnop',
    })

    const after = await invoke('settings:get', {})
    if (!after.ok) throw new Error('unreachable')
    expect((after.data as { llm: { hasKey: boolean } }).llm.hasKey).toBe(true)
  })

  it('never returns a secret value, only its presence', async () => {
    const secret = 'sk-live-4eC39HqLyjWDarjtT1zdp7dc'
    await invoke('settings:setSecret', { key: 'llmApiKey', value: secret })

    // There is deliberately no `settings:getSecret`. This asserts the absence is
    // real rather than merely undocumented.
    expect(CHANNEL_NAMES).not.toContain('settings:getSecret' as ChannelName)

    const result = await invoke('settings:get', {})
    expect(JSON.stringify(result)).not.toContain(secret)

    const presence = await invoke('settings:hasSecret', { key: 'llmApiKey' })
    if (!presence.ok) throw new Error('unreachable')
    expect(presence.data).toEqual({ present: true })
  })

  it('treats an empty value as clearing the secret', async () => {
    await invoke('settings:setSecret', {
      key: 'llmApiKey',
      value: 'sk-live-abcdefghijklmnop',
    })
    await invoke('settings:setSecret', { key: 'llmApiKey', value: '' })
    // Cleared rather than stored as an empty secret, so `hasKey` goes false and
    // the UI stops claiming a key is configured.
    expect(secrets.has('llmApiKey')).toBe(false)
  })

  it('applies a patch and rejects an out-of-range value at the boundary', async () => {
    const ok = await invoke('settings:set', { patch: { ui: { theme: 'light' } } })
    if (!ok.ok) throw new Error('unreachable')
    expect((ok.data as { ui: { theme: string } }).ui.theme).toBe('light')

    const bad = await invoke('settings:set', { patch: { llm: { temperature: 99 } } })
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('unreachable')
    // `IPC_INVALID_REQUEST`, not `SETTINGS_INVALID`. `settingsSchema.partial()`
    // makes only *root* keys optional — nested values are still validated in
    // full — so an out-of-range value is caught by request validation and never
    // reaches `settings.update`. Measured, not assumed: the first version of this
    // test asserted `SETTINGS_INVALID` and failed.
    //
    // `SETTINGS_INVALID` is therefore unreachable from IPC and is defence for
    // main-side callers. That is worth keeping rather than deleting: it is the
    // guard that survives someone loosening the request schema.
    expect(bad.error.code).toBe('IPC_INVALID_REQUEST')
  })

  it('preserves sibling fields when a patch names only one', async () => {
    // The deep-partial contract invites a one-field patch, so the merge must be
    // deep on the *stored* document rather than a section-level assign. Worth
    // pinning because zod fills defaults for every field of `llm` on the way
    // through, and a merge ordered the other way round would write those defaults
    // over the user's values.
    await invoke('settings:set', { patch: { llm: { temperature: 1.2 } } })
    const result = await invoke('settings:set', { patch: { llm: { model: 'gpt-5' } } })
    if (!result.ok) throw new Error('unreachable')
    const llm = (result.data as { llm: { temperature: number; model: string } }).llm
    expect(llm.model).toBe('gpt-5')
    expect(llm.temperature).toBe(1.2)
  })

  it('does not let a patch reach the secrets field', async () => {
    await invoke('settings:set', { patch: { secretBlobs: { llmApiKey: 'attacker' } } })
    const result = await invoke('settings:get', {})
    expect(JSON.stringify(result)).not.toContain('attacker')
  })

  it('rebuilds the native menu when the patch changes locale', async () => {
    // Main translates the menu from the same i18n JSON the renderer uses (R10),
    // so nothing else in the system will notice a locale change. Without this the
    // menu bar keeps the old language until the next launch.
    await invoke('settings:set', { patch: { ui: { locale: 'en' } } })
    expect(relabelCalls).toEqual(['en'])
  })

  it('does not rebuild the menu for a patch that leaves locale alone', async () => {
    await invoke('settings:set', { patch: { ui: { theme: 'light' } } })
    expect(relabelCalls).toEqual([])
  })

  it('does not rebuild the menu when locale is set to the value it already had', async () => {
    // The comparison is against the pre-update document, not "is `locale` present
    // in the patch". A settings panel that submits the whole form sends `locale`
    // on every save, and rebuilding the menu each time would be wasted work.
    //
    // `'zh-CN'` written out rather than read back from `settings:get`: it is the
    // authoring locale and the schema default, so hardcoding it makes this fail if
    // that default ever changes — which is exactly when someone should re-read this
    // test rather than have it quietly keep passing against a moving value.
    await invoke('settings:set', { patch: { ui: { locale: 'zh-CN' } } })
    expect(relabelCalls).toEqual([])
  })
})

describe('llm channels', () => {
  it('returns a runId immediately rather than the reply', async () => {
    const result = await invoke('llm:sendMessage', {
      content: 'why was move 47 bad?',
      history: [],
    })
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toEqual({ runId: 'run-1' })
    expect(llm.calls.sent).toHaveLength(1)
  })

  it('accepts a cancel for an unknown run without erroring', async () => {
    // The run may have finished microseconds earlier. Reporting that as a failed
    // cancel gives the renderer a distinction it cannot act on.
    const result = await invoke('llm:cancel', { runId: 'never-existed' })
    expect(result.ok).toBe(true)
    expect(llm.calls.cancelled).toEqual(['never-existed'])
  })
})

describe('engine channels', () => {
  it('engine:info returns the service snapshot', async () => {
    const result = await invoke('engine:info', {})
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toEqual({ status: 'unavailable' })
    // The handler asks, not tells: no start was requested by a snapshot read.
    expect(engine.calls.starts).toBe(0)
  })

  it('engine:start delegates to the service', async () => {
    const result = await invoke('engine:start', {})
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toEqual({ status: 'ready', backend: 'eigen' })
    expect(engine.calls.starts).toBe(1)
  })

  it('engine:setGame routes the record and returns the named query id', async () => {
    const game = {
      gameId: 'g1',
      boardSize: 19,
      komi: 6.5,
      rules: 'japanese',
      setup: { black: [], white: [] },
      moves: [{ player: 'black', coord: { x: 3, y: 3 } }],
    }
    const result = await invoke('engine:setGame', { game, atMove: 1 })
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toEqual({ focusQueryId: 'focus:1' })
    expect(engine.calls.games).toEqual([game])
  })

  it('engine:setGame passes a null record through as clearing', async () => {
    const result = await invoke('engine:setGame', { game: null, atMove: 0 })
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toEqual({ focusQueryId: null })
    expect(engine.calls.games).toEqual([null])
  })

  it('engine:setCursor routes the cursor and returns the named query id', async () => {
    const result = await invoke('engine:setCursor', { moveNumber: 42 })
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toEqual({ focusQueryId: 'focus:2' })
    expect(engine.calls.cursors).toEqual([42])
  })
})

describe('every channel is exercised', () => {
  it('leaves no channel untested', () => {
    // A9's spirit applied here: a coverage claim that is not itself checked
    // decays silently as channels are added. This list is the explicit ledger,
    // and the equality assertion is what makes forgetting one a failure.
    const exercised: ChannelName[] = [
      'sgf:parse',
      'sgf:serialize',
      'sgf:openDialog',
      'library:list',
      'library:import',
      'settings:get',
      'settings:set',
      'settings:setSecret',
      'settings:hasSecret',
      'llm:sendMessage',
      'llm:cancel',
      'engine:info',
      'engine:start',
      'engine:setGame',
      'engine:setCursor',
    ]
    expect([...exercised].sort()).toEqual([...CHANNEL_NAMES].sort())
  })
})
