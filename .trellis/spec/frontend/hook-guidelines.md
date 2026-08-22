# Hook Guidelines

> How hooks are used in the GoMentor renderer.

---

## Refs Do Not Trigger Effects

A `useRef` object is mutable and its identity is stable across renders, so
adding it to a `useEffect` dependency array does nothing. If an effect needs to
run when the ref's current value changes, mirror that value into state.

### Wrong

```tsx
const dragging = useRef<{ ... } | undefined>(undefined)

useEffect(() => {
  if (dragging.current === undefined) return
  window.addEventListener('mousemove', onMouseMove)
  return () => window.removeEventListener('mousemove', onMouseMove)
}, [dragging]) // This never re-runs when dragging.current changes.
```

### Correct

```tsx
const dragging = useRef<{ ... } | undefined>(undefined)
const [isDragging, setIsDragging] = useState(false)

useEffect(() => {
  if (!isDragging) return
  window.addEventListener('mousemove', onMouseMove)
  return () => window.removeEventListener('mousemove', onMouseMove)
}, [isDragging])

function startDrag() {
  dragging.current = { ... }
  setIsDragging(true)
}

function stopDrag() {
  dragging.current = undefined
  setIsDragging(false)
}
```

---

## Subscriptions Through `useIpcEvent`

Always use `useIpcEvent` for main→renderer subscriptions instead of calling the
preload registrar directly in `useEffect`. The hook keeps the handler in a ref so
the subscription does not tear down and rebuild on every render, and it returns
the teardown function in the shape `useEffect` expects.

### Correct

```tsx
useIpcEvent(window.gomentor.onEngineStatus, (info) => {
  setEngine(info)
})
```

The registrar function (`window.gomentor.onEngineStatus`) is a stable reference
from `contextBridge`, so it is safe to pass directly without `useCallback`.

---

## Event Listener Cleanup

Any listener added inside an effect must be removed in the effect's cleanup. This
includes window-level listeners for mouse move/up during drag operations.
