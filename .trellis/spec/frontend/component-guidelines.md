# Component Guidelines

> How components are built in the GoMentor renderer.

---

## UI Primitives

Use the primitives in `src/renderer/src/components/ui/` for any interactive
control. They are thin wrappers around native elements that carry the project's
styling; call sites remain free to pass `className`, `disabled`, event handlers,
and native validation attributes.

- `Button` — forwards all `ButtonHTMLAttributes`, defaults `type="button"`.
- `Input` — forwards all `InputHTMLAttributes`.
- `Select` — forwards all `SelectHTMLAttributes`.

### Why not raw elements everywhere

A raw `<button>` and a `<Button>` render the same DOM, but diverging styles
happen silently when both exist. Keeping the primitive layer as the single place
that owns the button class makes a global style change one-line instead of a
grep-and-replace.

### Wrong

```tsx
<button type="button" className="button" onClick={onClick}>
  Save
</button>
```

### Correct

```tsx
<Button type="button" className="button" onClick={onClick}>
  Save
</Button>
```

---

## Forms and Controlled Inputs

### Local draft vs. immediate commit

Settings forms hold local state and only commit on save, because an IPC round
trip per keystroke is too expensive. Fields that can be committed immediately
— such as a `<select>` with no keystroke storm — should read their value from
the authoritative store, not from the local draft. Reading from the draft makes
the control revert if the store updates for any reason the component did not
initiate.

### Wrong

```tsx
const [draft, setDraft] = useState(settings)
// The select reverts to draft on the next render even after update() succeeds.
<select value={draft.ui.locale} onChange={...} />
```

### Correct

```tsx
const settings = useSettingsStore((s) => s.settings)
const [draft, setDraft] = useState(settings)
// Locale commits immediately and stays in sync with the store.
<Select value={settings.ui.locale} onChange={(e) => update({ ui: { locale: e.target.value } })} />
```

### Password / secret inputs

Never store the secret value longer than necessary. After `setSecret` succeeds,
clear the input and show a transient confirmation. Clean up the confirmation
timeout on unmount so a late `setState` does not run on an unmounted component.

```tsx
const [keySaved, setKeySaved] = useState(false)

useEffect(() => {
  if (!keySaved) return undefined
  const timeout = setTimeout(() => setKeySaved(false), 2000)
  return () => clearTimeout(timeout)
}, [keySaved])
```

---

## Drag and Drop

In the sandboxed Electron renderer, HTML5 `drop` events expose `path` on each
`File` object. Import directly in the renderer; do not add a main-process
forwarding event unless you need window-level drag feedback that the page cannot
provide.

### Pattern

```tsx
type FileWithPath = File & { path?: string }

function handleDrop(event: React.DragEvent): void {
  event.preventDefault()
  const files = Array.from(event.dataTransfer.files) as FileWithPath[]
  const paths = files
    .map((file) => file.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  if (paths.length > 0) onDropFiles(paths)
}
```

### Drag highlight stability

Use a depth counter rather than a boolean for `dragOver` state. `dragleave`
fires when the pointer enters a child element, so a boolean flips off while the
user is still dragging inside the target.

---

## Event Handler Types

`React.FormEvent` is deprecated in this codebase and will fail lint. Use
`React.SyntheticEvent<HTMLFormElement>` for form submissions, or the more
specific `React.ChangeEvent` / `React.KeyboardEvent` when applicable.

---

## i18n

Every user-facing string must come from the catalogues in
`src/renderer/src/i18n/locales/`. The renderer i18n test asserts that `zh-CN`
values differ from `en` values where they should; do not copy symbols or words
that should be translated.

When adding a new key, add it to both `en` and `zh-CN` catalogues before
committing. Run `node --experimental-strip-types scripts/check-i18n.ts` and the
renderer i18n test to verify.
