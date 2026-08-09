import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChannelName,
  ChannelRequest,
  ChannelResponse,
  EventName,
  EventPayload,
  IpcResult,
} from '@gomentor/shared'

/**
 * The ONLY bridge between renderer and main. Thin by design: no business logic,
 * no validation, no error interpretation — main owns all three. This file's job
 * is to expose a typed surface and nothing else.
 *
 * ## Every import here is `import type`, and that is not a style choice
 *
 * The window runs `sandbox: true` (`window.ts`), and a sandboxed preload has no
 * node_modules resolution — only Electron's own module and a small built-in
 * allowlist. Measured in a real sandboxed window: `require('@gomentor/shared')`
 * and `require('zod')` both throw `Error: module not found`.
 *
 * That failure would be a *runtime* one, and it is easy to introduce by accident,
 * because `electron.vite.config.ts` applies `externalizeDepsPlugin()` to the
 * preload target: every entry in the desktop package's `dependencies` — which
 * includes `@gomentor/shared` and `zod` — is left as a runtime `require()` rather
 * than bundled, and the target's alias does not override that. So importing a
 * single *value* from `@gomentor/shared` here (`CHANNEL_NAMES`, a zod schema,
 * `AppError`) emits `require("@gomentor/shared")` into the bundle and the preload
 * dies before `exposeInMainWorld` runs — leaving `window.gomentor` undefined and
 * the app blank, with the real cause only in the preload's own console.
 *
 * Type-only imports erase at compile time, so they cost nothing at runtime while
 * still making a renamed channel a compile error here. Validation is not lost by
 * skipping the schemas: `register.ts` validates every request against the same
 * contract, and it is the side that must not trust the other.
 *
 * ## Errors are returned, never thrown
 *
 * `invoke` hands the `IpcResult` union to the renderer verbatim. The tempting
 * alternative — unwrap here and `throw` on `ok: false`, so call sites read like
 * normal async code — was measured and does not work: `contextBridge` strips an
 * Error's own properties. An `AppError` thrown inside a bridged function arrives
 * in the page as a plain `Error` with `name: 'Error'`, `Object.keys()` empty, and
 * both `code` and `context` `undefined`. Only `message` crosses. Since the
 * renderer's entire error story is `code` → `errors` i18n namespace
 * (`error-handling.md` line 65), that would silently destroy the thing the union
 * was introduced to protect. Returned as data, `code`, `message`, and nested
 * `context` all survive intact.
 *
 * ## Listeners receive the payload only
 *
 * The `on*` registrars deliberately drop `IpcRendererEvent` instead of forwarding
 * it. `contextBridge` does downgrade it — the page sees `event.sender` as a bare
 * object whose prototype carries only `Object.prototype` methods, not `send` or
 * `executeJavaScript` — so forwarding it is not an exploitable escape. But that
 * safety is a property of Electron's serialiser, not of our design, and it hands
 * the page an object with no legitimate use. The payload is the contract
 * (`EVENTS` in `@gomentor/shared`); the transport envelope is not.
 */

/**
 * One channel, one round trip. Generic over `ChannelName` so the request and
 * response types are tied to the channel by the shared contract.
 */
function invoke<C extends ChannelName>(
  channel: C,
  request: ChannelRequest<C>,
): Promise<IpcResult<ChannelResponse<C>>> {
  // `as`: `ipcRenderer.invoke` is typed `Promise<any>`, so this narrows an
  // untyped value rather than overriding a known one. What actually guarantees
  // the shape is `register.ts`, which returns `IpcResult` on every path including
  // its catch — and validates the response against this same channel's schema in
  // dev builds.
  return ipcRenderer.invoke(channel, request) as Promise<IpcResult<ChannelResponse<C>>>
}

/**
 * Subscribes to a main→renderer event; the returned function unsubscribes.
 *
 * Returning the teardown rather than exposing a matching `off*` avoids the classic
 * leak: an `off` API requires the caller to hold the *same* function reference, and
 * a React effect that recreates its handler each render would silently accumulate
 * listeners. Here the closure owns the reference, so the caller cannot get it
 * wrong — and `useEffect`'s cleanup contract is exactly the shape of the returned
 * value. Verified in a sandboxed window that calling it genuinely stops delivery,
 * not merely that it is callable.
 */
function subscribe<E extends EventName>(
  event: E,
  listener: (payload: EventPayload<E>) => void,
): () => void {
  const wrapped = (_event: unknown, payload: unknown): void => {
    // `as EventPayload<E>`: main validates every payload against `EVENTS[event]`
    // before sending (`ipc/events.ts`), and the preload cannot re-check without
    // importing zod, which the sandbox forbids. The cast records where the trust
    // boundary is — main is the validating side — rather than standing in for a
    // check that nobody performs.
    listener(payload as EventPayload<E>)
  }

  ipcRenderer.on(event, wrapped)
  return () => {
    ipcRenderer.off(event, wrapped)
  }
}

/**
 * The exposed surface.
 *
 * `Object.freeze` here is belt-and-braces, and worth being precise about: it is
 * *not* what stops the page mutating the bridge. Measured with a deliberately
 * unfrozen preload export, the page still sees `Object.isFrozen === true` at the
 * root and on every nested group, and its writes are ignored — `contextBridge`
 * builds a frozen mirror in the page's own realm rather than handing over this
 * object. Removing these calls changes nothing observable from the renderer.
 *
 * They stay because they state the intent at the definition site and because they
 * do cover what `contextBridge` does not: this object inside preload's own scope.
 * Attributing the page-side guarantee to them would be the mistake — that
 * guarantee is Electron's, and `test/e2e/preload-boundary.spec.ts` asserts it
 * directly instead.
 *
 * Note the separate limit that does apply to us: freezing does not extend to
 * *returned* values, which is why nothing here hands back an object the renderer
 * is expected to treat as immutable.
 *
 * Named methods rather than a generic `invoke(channel, payload)` passthrough: a
 * passthrough would let the renderer reach any channel, including ones added later
 * for main-internal use, and would put channel-name strings into renderer code.
 * Enumerating them makes the bridge's surface exactly the M1 contract, readable in
 * one screen, and the e2e spec asserts the key set exactly — an extra key is as
 * much a finding as a missing one.
 */
const api = Object.freeze({
  version: '0.1.0',

  sgf: Object.freeze({
    parse: (request: ChannelRequest<'sgf:parse'>) => invoke('sgf:parse', request),
    serialize: (request: ChannelRequest<'sgf:serialize'>) =>
      invoke('sgf:serialize', request),
    openDialog: (request: ChannelRequest<'sgf:openDialog'>) =>
      invoke('sgf:openDialog', request),
  }),

  library: Object.freeze({
    list: (request: ChannelRequest<'library:list'>) => invoke('library:list', request),
    import: (request: ChannelRequest<'library:import'>) =>
      invoke('library:import', request),
  }),

  llm: Object.freeze({
    sendMessage: (request: ChannelRequest<'llm:sendMessage'>) =>
      invoke('llm:sendMessage', request),
    cancel: (request: ChannelRequest<'llm:cancel'>) => invoke('llm:cancel', request),
  }),

  settings: Object.freeze({
    get: (request: ChannelRequest<'settings:get'>) => invoke('settings:get', request),
    set: (request: ChannelRequest<'settings:set'>) => invoke('settings:set', request),
    setSecret: (request: ChannelRequest<'settings:setSecret'>) =>
      invoke('settings:setSecret', request),
    hasSecret: (request: ChannelRequest<'settings:hasSecret'>) =>
      invoke('settings:hasSecret', request),
  }),

  onLlmDelta: (listener: (payload: EventPayload<'llm:delta'>) => void) =>
    subscribe('llm:delta', listener),
  onLlmDone: (listener: (payload: EventPayload<'llm:done'>) => void) =>
    subscribe('llm:done', listener),
  onLlmError: (listener: (payload: EventPayload<'llm:error'>) => void) =>
    subscribe('llm:error', listener),
  onLibraryChanged: (listener: (payload: EventPayload<'library:changed'>) => void) =>
    subscribe('library:changed', listener),
  onMenuCommand: (listener: (payload: EventPayload<'menu:command'>) => void) =>
    subscribe('menu:command', listener),
  onEngineStatus: (listener: (payload: EventPayload<'engine:status'>) => void) =>
    subscribe('engine:status', listener),
})

export type GoMentorApi = typeof api

contextBridge.exposeInMainWorld('gomentor', api)
