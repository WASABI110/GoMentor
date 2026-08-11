import { useEffect, useRef } from 'react'

/**
 * Subscribes to a main→renderer event for the lifetime of the component.
 *
 * ## Why a hook at all, when the bridge already returns its own teardown
 *
 * `window.gomentor.onLlmDelta(fn)` returns an unsubscribe function, which is
 * already the shape `useEffect` wants. The value added here is not the
 * subscription — it is making the dependency array impossible to get wrong.
 *
 * Written inline, the natural spelling is:
 *
 *     useEffect(() => window.gomentor.onLlmDelta((p) => setState(p)), [])
 *
 * with `[]` because the handler closes over `setState`. That works until the
 * handler closes over a *prop*, at which point `[]` is a stale-closure bug and the
 * correct fix — adding the handler to the deps — resubscribes on every render,
 * because an inline arrow is a new reference each time. Both spellings are wrong
 * and neither fails visibly: one silently uses old data, the other silently churns
 * listeners. This hook removes the choice, keeping the handler in a ref that is
 * updated every render while the subscription itself depends only on `subscribe`.
 *
 * ## `subscribe` is passed in rather than a channel name
 *
 * The preload exposes named registrars (`onLlmDelta`, `onEngineStatus`, …) rather
 * than a generic `on(channel, fn)`, deliberately — `preload/index.ts` records why a
 * passthrough would let the renderer reach any channel and put raw channel strings
 * into renderer code. So this hook takes the registrar itself:
 * `useIpcEvent(window.gomentor.onLlmDelta, handler)`.
 *
 * That call is safe to write as a bare property read, which is not obvious and was
 * measured rather than assumed: `contextBridge` builds its mirror once, so reading
 * `window.gomentor.onLibraryChanged` twice yields the *same* function reference
 * (`===` is true — see "contextBridge returns a stable reference" in
 * `test/e2e/ipc-events.spec.ts`, which asserts it against the built app). A fresh
 * proxy per read would have made `subscribe` a new value every render and this
 * hook's own dependency array the churn it exists to prevent, forcing every caller
 * into a `useCallback` wrapper.
 *
 * ## Generic over the payload, not over the event name
 *
 * The obvious signature — `<E extends EventName>` with `EventPayload<E>` in the
 * parameter — does not work, and fails in a way worth recording. `EventPayload<E>`
 * is an indexed access, not a naked type parameter, and it sits in a contravariant
 * position inside `subscribe`. TypeScript cannot solve for `E` there, so it infers
 * `never` and every call site reports *Argument of type '(payload: never) => void'
 * is not assignable*, naming a type the caller never wrote.
 *
 * Inferring the payload `P` straight from the registrar is both simpler and no
 * weaker: the registrars come from the preload API, where each one is already typed
 * `(listener: (payload: EventPayload<'library:changed'>) => void) => () => void`.
 * So `P` resolves to exactly the contract's payload, and `handler` is checked
 * against it — the tie to `EVENTS` in `@gomentor/shared` is preserved without this
 * file naming a single channel.
 *
 * ## No `enabled` flag
 *
 * A conditional subscription is expressible by the caller (a guard inside the
 * handler), and every M1 consumer subscribes unconditionally. Adding the flag now
 * would be a parameter with no caller and one more thing to get wrong.
 */
export function useIpcEvent<P>(
  subscribe: (listener: (payload: P) => void) => () => void,
  handler: (payload: P) => void,
): void {
  // A ref rather than a dep: the subscription must not tear down and rebuild
  // because the caller passed a fresh arrow this render. Events arriving between
  // the two would be dropped, and for `llm:delta` that is a missing token in the
  // middle of a streamed answer.
  //
  // Honest about what is proven: removing this indirection entirely — freezing the
  // handler at first render — does not fail any current test, and that is a fact
  // about today's callers rather than about this hook. Every handler in
  // `useMainProcessEvents` closes over nothing but zustand actions, whose
  // identities are fixed for the store's lifetime and which read fresh state
  // through `get()`. So no live call site can currently observe a stale closure.
  // The ref stays because the first handler that closes over a prop or a
  // `useState` value would silently read a stale one, and that failure is
  // invisible at the call site.
  const handlerRef = useRef(handler)

  // Assigned during render rather than in an effect. An effect runs *after* paint,
  // so an event delivered between this render and that effect would reach the
  // previous render's handler — which is the stale closure this hook exists to
  // prevent. Writing a ref during render is safe because it is not read during
  // render: nothing here derives rendered output from it.
  handlerRef.current = handler

  useEffect(() => {
    // The listener is stable, so `subscribe`'s teardown is called exactly once per
    // subscription. Returning it is not optional: React calls it on unmount, and in
    // a dev build StrictMode's deliberate double-invoke makes the
    // subscribe/unsubscribe/resubscribe sequence happen on every mount.
    //
    // Not covered by machine test, and deliberately said out loud: the e2e spec runs
    // the *production* renderer bundle, where StrictMode does not double-invoke, and
    // `App` never unmounts — so discarding this return value passes every test. See
    // the caveat in `test/e2e/ipc-events.spec.ts` under "handled exactly once".
    return subscribe((payload) => {
      handlerRef.current(payload)
    })
  }, [subscribe])
}
