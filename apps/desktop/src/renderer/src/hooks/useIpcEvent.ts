import { useEffect, useRef } from 'react'
import type { EventName, EventPayload } from '@gomentor/shared'

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
 * into renderer code. So this hook takes the registrar itself. A caller writes
 * `useIpcEvent(window.gomentor.onLlmDelta, handler)` and the payload type is
 * inferred from the registrar, which keeps the type tie to `EVENTS` in
 * `@gomentor/shared` without this file naming a single channel.
 *
 * ## No `enabled` flag
 *
 * A conditional subscription is expressible by the caller (`subscribe` chosen per
 * branch is not possible; a guard inside the handler is), and every M1 consumer
 * subscribes unconditionally. Adding the flag now would be a parameter with no
 * caller and one more thing to get wrong.
 */
export function useIpcEvent<E extends EventName>(
  subscribe: (listener: (payload: EventPayload<E>) => void) => () => void,
  handler: (payload: EventPayload<E>) => void,
): void {
  // A ref rather than a dep: the subscription must not tear down and rebuild
  // because the caller passed a fresh arrow this render. Events arriving between
  // the two would be dropped, and for `llm:delta` that is a missing token in the
  // middle of a streamed answer.
  const handlerRef = useRef(handler)

  // Assigned during render rather than in an effect. An effect runs *after* paint,
  // so an event delivered between this render and that effect would reach the
  // previous render's handler — which is the stale closure this hook exists to
  // prevent. Writing a ref during render is safe because it is not read during
  // render: nothing here derives rendered output from it.
  handlerRef.current = handler

  useEffect(() => {
    // The listener is stable, so `subscribe`'s teardown is called exactly once per
    // subscription. Under StrictMode's deliberate double-invoke in development,
    // this subscribes, unsubscribes, and resubscribes — which is precisely the
    // sequence that catches a registrar whose teardown does not work.
    return subscribe((payload) => {
      handlerRef.current(payload)
    })
  }, [subscribe])
}
