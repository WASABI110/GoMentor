import { useEffect } from 'react'
import { useIpcEvent } from './useIpcEvent'
import { useChatStore } from '../state/chatStore'
import { useLibraryStore } from '../state/libraryStore'
import { useAnalysisStore } from '../state/analysisStore'
import type { EventPayload } from '@gomentor/shared'

/**
 * Every main→renderer subscription the app holds, in one place.
 *
 * ## Why one hook rather than a subscription in each panel
 *
 * The events are not panel-scoped. `library:changed` must be acted on whether or
 * not the library panel is mounted — a panel that unmounts would unsubscribe and
 * the store would then silently miss an import, which is indistinguishable from a
 * failed import. Same for `llm:delta`: the teacher panel scrolled out of view
 * would drop tokens mid-answer. Subscribing at the shell means the lifetime of
 * every subscription is the lifetime of the app, which is what these events
 * assume.
 *
 * It also makes the set auditable. Every member of `EVENTS` in `@gomentor/shared`
 * is handled here, each writing exactly one store — `analysisStore` owns engine
 * state because Stage 3 gave it two consumers (the badge and the board overlays),
 * and a component-local subscription would have been a second write path to the
 * same state.
 *
 * ## The registrar is passed as a bare property read
 *
 * `window.gomentor.onLibraryChanged` and friends are the whole surface — preload
 * deliberately exposes no generic `on(channel, …)` passthrough, so a channel
 * string cannot appear in renderer code. Passing the property directly, with no
 * `useCallback` around it, rests on a measured fact: `contextBridge` builds its
 * mirror once, so two reads of the same property are `===`. A wrapper would be
 * cargo cult here — and worse, it would suggest to the next reader that the
 * identity is *not* stable, which is the belief that leads someone to memoise the
 * handler too and reintroduce the churn `useIpcEvent` prevents.
 */
export function useMainProcessEvents(): void {
  const refresh = useLibraryStore((state) => state.refresh)
  const receiveChunk = useChatStore((state) => state.receiveChunk)
  const finishRun = useChatStore((state) => state.finishRun)
  const failRun = useChatStore((state) => state.failRun)
  const applyStatus = useAnalysisStore((state) => state.applyStatus)
  const applyResult = useAnalysisStore((state) => state.applyResult)

  useIpcEvent(window.gomentor.onLibraryChanged, () => {
    // The payload's `reason` is deliberately ignored: import, delete and watch
    // all mean the same thing to a renderer whose list is refetched wholesale.
    // Branching on it would be three code paths that must agree.
    void refresh()
  })

  useIpcEvent(window.gomentor.onLlmDelta, (payload) => {
    receiveChunk(payload.runId, payload.chunk)
  })

  useIpcEvent(window.gomentor.onLlmDone, (payload) => {
    finishRun(payload.runId, payload.finishReason)
  })

  useIpcEvent(window.gomentor.onLlmError, (payload) => {
    failRun(payload.runId, payload.error)
  })

  useIpcEvent(window.gomentor.onEngineStatus, (payload) => {
    // The only writer of the engine snapshot. The badge and the board overlays
    // both render it, so the subscription lives here once rather than in each
    // consumer — a component-local subscription would be a second write path to
    // the same state and the two could interleave.
    applyStatus(payload)
  })

  useIpcEvent(window.gomentor.onEngineAnalysis, (payload) => {
    // No filtering beyond the store's own: main already dropped ticks for
    // terminated/superseded query ids before emitting; `applyResult` is the
    // second line of defence (gameId + cursor expectation).
    applyResult(payload)
  })

  useIpcEvent(window.gomentor.onMenuCommand, (payload) => {
    // One implementation of the open flow, reached from both the native menu
    // and the in-app button. Main emits rather than opening the dialog itself
    // precisely so these do not become two paths that drift — see the comment
    // on `menu:command` in `@gomentor/shared`.
    //
    // Dispatched through a table rather than `if (command === 'openSgf')` or a
    // `switch`. `command` is a single-member enum today, so both of those forms
    // are a comparison that is always true, which eslint's
    // `no-unnecessary-condition` rejects — rightly: they read as a guard while
    // guarding nothing. Deleting the check instead would silently run `openSgf`
    // for whatever command is added next. `MENU_COMMANDS` is typed
    // `Record<MenuCommand, …>`, so it compares nothing, and widening the enum in
    // `@gomentor/shared` makes `tsc` name this file for the missing entry.
    MENU_COMMANDS[payload.command]()
  })

  // Seed the engine snapshot for first paint. `engine:status` events emitted
  // before this hook mounted are gone, and the badge would otherwise show the
  // store's `unavailable` default until main next re-emitted — which, on a
  // healthy ready engine, might be never. `engine:info` is the synchronous
  // snapshot channel, so one call closes the gap. Rejection is not handled:
  // `register.ts` resolves every path, failure included, to the union.
  useEffect(() => {
    void window.gomentor.engine.info({}).then((result) => {
      if (result.ok) applyStatus(result.data)
    })
  }, [applyStatus])
}

/**
 * The open-SGF flow: ask main for paths, hand them to the library.
 *
 * Not a `useCallback` inside the hook because it holds no React state — it reads
 * the store imperatively, which is correct for an event handler that may fire
 * when nothing is rendering. A cancelled dialog returns `[]`, and
 * `importFiles([])` returns without an IPC call: expected absence is a state, not
 * an error.
 */
async function openSgf(): Promise<void> {
  const result = await window.gomentor.sgf.openDialog({})
  if (!result.ok) {
    useLibraryStore.setState({ error: result.error })
    return
  }
  await useLibraryStore.getState().importFiles(result.data.filePaths)
}

/**
 * What each menu command does, keyed exhaustively by the contract's own enum.
 *
 * Typed from `EventPayload<'menu:command'>` rather than restating `'openSgf'` here:
 * the key set is then whatever `@gomentor/shared` says it is, and adding a command
 * there is a type error in this file until it is handled.
 */
const MENU_COMMANDS: Record<EventPayload<'menu:command'>['command'], () => void> = {
  openSgf: () => {
    void openSgf()
  },
}
