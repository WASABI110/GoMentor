import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  errorEnvelopeSchema,
  gameSummarySchema,
  type ErrorEnvelope,
  type GameSummary,
} from '@gomentor/shared'
import { useLibraryStore } from '../../src/renderer/src/state/libraryStore'

/**
 * `libraryStore` — the event-authoritative mirror of the library.
 *
 * ## Summaries are parsed, not hand-built
 *
 * Every `GameSummary` goes through `gameSummarySchema.parse`, so these tests use
 * the shape the channel actually returns. A literal would be checked at compile
 * time only, and a contract that drifted would still satisfy this file.
 *
 * ## The central assertion is what the store does *not* do
 *
 * `library:import` responds with what it imported, and the tempting move is to
 * append that to `games`. Main also emits `library:changed` for the same import, so
 * appending makes two writers for one list — and any disagreement between them
 * shows up as duplicated or disappearing rows. Several cases below exist only to
 * pin that the response never becomes the list.
 */

function summary(overrides: Record<string, unknown>): GameSummary {
  return gameSummarySchema.parse({
    id: 'g1',
    moveCount: 200,
    boardSize: 19,
    source: 'import',
    ...overrides,
  })
}

const GAMES: GameSummary[] = [
  summary({ id: 'g1', blackName: 'Lee', whiteName: 'AlphaGo' }),
  summary({ id: 'g2', blackName: 'Ke', whiteName: 'Master' }),
]

// Through the schema for the same reason the summaries are: a literal code is
// checked by `tsc` only, so an invented one that no `errors` i18n entry
// translates would still pass here.
const FAILURE: ErrorEnvelope = errorEnvelopeSchema.parse({
  code: 'LIBRARY_FILE_UNREADABLE',
  message: 'the library index could not be read',
})

const FILE_FAILURE: ErrorEnvelope = errorEnvelopeSchema.parse({
  code: 'SGF_NOT_SGF',
  message: 'not an SGF file',
})

interface BridgeCalls {
  list: number
  import: unknown[]
}

function stubBridge(handlers: {
  list?: () => unknown
  import?: (request: unknown) => unknown
}): BridgeCalls {
  const calls: BridgeCalls = { list: 0, import: [] }
  vi.stubGlobal('window', {
    gomentor: {
      library: {
        list: () => {
          calls.list += 1
          return handlers.list === undefined
            ? { ok: true, data: { games: GAMES } }
            : handlers.list()
        },
        import: (request: unknown) => {
          calls.import.push(request)
          return handlers.import === undefined
            ? { ok: true, data: { imported: [], duplicates: 0, failures: [] } }
            : handlers.import(request)
        },
      },
    },
  })
  return calls
}

beforeEach(() => {
  useLibraryStore.setState({
    games: [],
    loading: false,
    importing: false,
    error: null,
    lastImport: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refresh', () => {
  it('replaces the list from the response', async () => {
    stubBridge({})
    await useLibraryStore.getState().refresh()

    expect(useLibraryStore.getState().games).toEqual(GAMES)
    expect(useLibraryStore.getState().loading).toBe(false)
    expect(useLibraryStore.getState().error).toBeNull()
  })

  it('is loading while the list is in flight', async () => {
    let release: ((value: unknown) => void) | undefined
    stubBridge({
      list: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })

    const pending = useLibraryStore.getState().refresh()
    // Distinct from "the library is empty": both show no rows, and only one should
    // say so to the user.
    expect(useLibraryStore.getState().loading).toBe(true)

    if (release === undefined) throw new Error('bridge was not called')
    release({ ok: true, data: { games: GAMES } })
    await pending
    expect(useLibraryStore.getState().loading).toBe(false)
  })

  it('keeps the previous list when a refresh fails', async () => {
    stubBridge({})
    await useLibraryStore.getState().refresh()

    vi.unstubAllGlobals()
    stubBridge({ list: () => ({ ok: false, error: FAILURE }) })
    await useLibraryStore.getState().refresh()

    // An emptied list is indistinguishable from an empty library, and would invite
    // the user to re-import everything they already have.
    expect(useLibraryStore.getState().games).toEqual(GAMES)
    expect(useLibraryStore.getState().error).toEqual(FAILURE)
    expect(useLibraryStore.getState().loading).toBe(false)
  })

  it('does not throw on a refused list', async () => {
    stubBridge({ list: () => ({ ok: false, error: FAILURE }) })
    await expect(useLibraryStore.getState().refresh()).resolves.toBeUndefined()
  })

  it('clears a previous error on a successful refresh', async () => {
    stubBridge({ list: () => ({ ok: false, error: FAILURE }) })
    await useLibraryStore.getState().refresh()
    expect(useLibraryStore.getState().error).not.toBeNull()

    vi.unstubAllGlobals()
    stubBridge({})
    await useLibraryStore.getState().refresh()
    expect(useLibraryStore.getState().error).toBeNull()
  })

  it('accepts an empty library as a valid answer', async () => {
    stubBridge({ list: () => ({ ok: true, data: { games: [] } }) })
    await useLibraryStore.getState().refresh()

    // Expected absence is a state, not an exception.
    expect(useLibraryStore.getState().games).toEqual([])
    expect(useLibraryStore.getState().error).toBeNull()
  })
})

describe('the import response never becomes the list', () => {
  it('does not append imported games to games', async () => {
    stubBridge({
      import: () => ({
        ok: true,
        data: { imported: GAMES, duplicates: 0, failures: [] },
      }),
    })
    await useLibraryStore.getState().importFiles(['/tmp/a.sgf'])

    // `library:changed` follows and `refresh` is the single writer. Appending here
    // makes two writers for one list, and they show up as duplicated rows.
    expect(useLibraryStore.getState().games).toEqual([])
    expect(useLibraryStore.getState().lastImport?.imported).toBe(2)
  })

  it('leaves an existing list untouched', async () => {
    stubBridge({})
    await useLibraryStore.getState().refresh()

    vi.unstubAllGlobals()
    stubBridge({
      import: () => ({
        ok: true,
        data: {
          imported: [summary({ id: 'g3' })],
          duplicates: 0,
          failures: [],
        },
      }),
    })
    await useLibraryStore.getState().importFiles(['/tmp/c.sgf'])

    expect(useLibraryStore.getState().games).toEqual(GAMES)
  })
})

describe('importFiles', () => {
  it('sends the paths', async () => {
    const calls = stubBridge({})
    await useLibraryStore.getState().importFiles(['/tmp/a.sgf', '/tmp/b.sgf'])
    expect(calls.import).toEqual([{ filePaths: ['/tmp/a.sgf', '/tmp/b.sgf'] }])
  })

  it('does not call the bridge for an empty selection', async () => {
    const calls = stubBridge({})
    await useLibraryStore.getState().importFiles([])

    // An empty array is `sgf:openDialog`'s cancel signal, and the channel requires
    // `.min(1)` — sending it would show a validation error to someone who simply
    // closed the dialog.
    expect(calls.import).toEqual([])
    expect(useLibraryStore.getState().error).toBeNull()
  })

  it('is importing while the request is in flight', async () => {
    let release: ((value: unknown) => void) | undefined
    stubBridge({
      import: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })

    const pending = useLibraryStore.getState().importFiles(['/tmp/a.sgf'])
    expect(useLibraryStore.getState().importing).toBe(true)

    if (release === undefined) throw new Error('bridge was not called')
    release({ ok: true, data: { imported: [], duplicates: 0, failures: [] } })
    await pending
    expect(useLibraryStore.getState().importing).toBe(false)
  })

  it('clears importing when the import fails', async () => {
    stubBridge({ import: () => ({ ok: false, error: FAILURE }) })
    await useLibraryStore.getState().importFiles(['/tmp/a.sgf'])

    // A stuck flag leaves the import button disabled with no way to retry.
    expect(useLibraryStore.getState().importing).toBe(false)
    expect(useLibraryStore.getState().error).toEqual(FAILURE)
  })

  it('does not throw on a refused import', async () => {
    stubBridge({ import: () => ({ ok: false, error: FAILURE }) })
    await expect(
      useLibraryStore.getState().importFiles(['/tmp/a.sgf']),
    ).resolves.toBeUndefined()
  })
})

describe('partial success is data, not an error', () => {
  it('records per-file failures without setting error', async () => {
    stubBridge({
      import: () => ({
        ok: true,
        data: {
          imported: [summary({ id: 'g9' })],
          duplicates: 3,
          failures: [{ filePath: '/tmp/bad.sgf', error: FILE_FAILURE }],
        },
      }),
    })
    await useLibraryStore.getState().importFiles(['/tmp/a.sgf', '/tmp/bad.sgf'])

    const state = useLibraryStore.getState()
    // The *operation* succeeded. Setting `error` here would hide "14 imported" behind
    // a failure banner because one file in a folder was unreadable.
    expect(state.error).toBeNull()
    expect(state.lastImport).toEqual({
      imported: 1,
      duplicates: 3,
      failures: [{ filePath: '/tmp/bad.sgf', error: FILE_FAILURE }],
    })
  })

  it('keeps duplicates distinct from failures', async () => {
    stubBridge({
      import: () => ({
        ok: true,
        data: { imported: [], duplicates: 5, failures: [] },
      }),
    })
    await useLibraryStore.getState().importFiles(['/tmp/a.sgf'])

    // A duplicate is not a failure: re-importing a folder is normal and must not
    // report five errors.
    expect(useLibraryStore.getState().lastImport?.duplicates).toBe(5)
    expect(useLibraryStore.getState().lastImport?.failures).toEqual([])
    expect(useLibraryStore.getState().error).toBeNull()
  })

  it('reports an import where every file failed', async () => {
    stubBridge({
      import: () => ({
        ok: true,
        data: {
          imported: [],
          duplicates: 0,
          failures: [
            { filePath: '/tmp/a.sgf', error: FILE_FAILURE },
            { filePath: '/tmp/b.sgf', error: FILE_FAILURE },
          ],
        },
      }),
    })
    await useLibraryStore.getState().importFiles(['/tmp/a.sgf', '/tmp/b.sgf'])

    // Still not a store-level error — the channel answered. The UI has everything
    // it needs to say both files failed and why.
    expect(useLibraryStore.getState().lastImport?.imported).toBe(0)
    expect(useLibraryStore.getState().lastImport?.failures).toHaveLength(2)
    expect(useLibraryStore.getState().error).toBeNull()
  })
})
