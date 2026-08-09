# Directory Structure

> How frontend code is organized in this project.

---

## Overview

The frontend is the **Electron renderer process** — React 19 + TypeScript, presentation only. It never touches Node APIs. All OS access goes through the preload bridge (`window.gomentor`) to the main process.

Renderer code lives in `apps/desktop/src/renderer/`. Domain logic that is *not* presentation belongs in `packages/core` (pure, Electron-free) or `packages/shared` (contracts) — not here.

---

## Directory Layout

```
apps/desktop/src/renderer/
├── index.html              # entry, carries the strict CSP meta tag
└── src/
    ├── main.tsx            # React root: i18n, theme, error boundary providers
    ├── App.tsx             # three-panel resizable shell
    ├── components/         # reusable presentational components
    │   ├── Board.tsx            # canvas goban (static + dynamic layers)
    │   ├── BoardOverlay.tsx     # heatmap / ownership / candidates
    │   ├── GameList.tsx
    │   ├── TeacherChat.tsx
    │   ├── MoveTree.tsx
    │   ├── WinrateGraph.tsx
    │   ├── EngineStatus.tsx
    │   └── ui/                  # design-system primitives (Button, Panel, …)
    ├── panels/             # top-level panel compositions (LibraryPanel, SettingsPanel, …)
    ├── state/              # zustand stores, one file per store
    ├── hooks/              # custom hooks (useIpcEvent, …)
    ├── i18n/
    │   ├── index.ts
    │   └── locales/<locale>/<namespace>.json
    └── styles/             # theme tokens, global CSS
```

---

## Module Organization

| Kind of code | Goes in | Not in |
|---|---|---|
| Reusable presentational component | `components/` | `panels/` |
| Top-level panel composition | `panels/` | `components/` |
| Generic primitive (Button, Panel) | `components/ui/` | `components/` root |
| Cross-component state | `state/<name>Store.ts` | a component file |
| Reusable stateful logic | `hooks/` | duplicated across components |
| SGF parsing, board rules, coordinate math, LLM protocol | **`packages/core`** | anywhere under `renderer/` |
| IPC channel names, payload schemas, domain types | **`packages/shared`** | redeclared locally |

The last two rows are the ones that erode first. If a renderer file starts implementing Go rules or SGF handling, it is in the wrong package — `packages/core` is Electron-free precisely so that logic is testable without launching an app.

---

## Naming Conventions

- Components: `PascalCase.tsx`, one component per file, filename matches the export
- Stores: `camelCaseStore.ts` (`gameStore.ts`, `chatStore.ts`)
- Hooks: `useThing.ts`
- Everything else: `kebab-case.ts`
- i18n namespaces: `common`, `board`, `analysis`, `teacher`, `settings`, `errors`

---

## Forbidden patterns

**No Node APIs in the renderer.** No `require`, no `process`, no `fs`, no `path`, no `child_process`, no `import … from 'electron'`. `contextIsolation` and `sandbox` are on and `nodeIntegration` is off — these will fail at runtime, and reaching for them means the work belongs in main.

**No `window.ipcRenderer`.** The only bridge is `window.gomentor`, a frozen object. A raw `ipcRenderer` handle in the page is a sandbox escape. Both facts are asserted at runtime against the built app in `apps/desktop/test/e2e/preload-boundary.spec.ts`, not inferred from preload source. Precise about where the freezing comes from, since it affects what you can rely on: `contextBridge` constructs its own frozen mirror of the API in the page's realm, so the object is frozen even though the preload's own `Object.freeze` calls are belt-and-braces (measured — removing them changes nothing observable here). What that does *not* cover is **returned** values: freezing is not deep through call results, so treat anything a bridge method resolves to as ordinary mutable data.

**Never render a raw error `message` as primary UI text.** Bridge calls resolve to an `IpcResult` union, not a throw — a rejected call comes back as `{ ok: false, error: { code, message, context? } }`, and the renderer localises `code` through the `errors` i18n namespace (`../backend/error-handling.md`). This is not merely a convention: `contextBridge` strips an Error's own properties, so if the preload ever unwrapped the envelope into a `throw`, the page would receive a plain `Error` with `code` `undefined` and `message` the only survivor. Branch on `ok`; do not `try`/`catch` for domain failures.

**No raw IPC channel strings — but the enforcement is the type system, not a linter.** Reach channels through the typed wrappers (`window.gomentor.sgf.parse(...)` in the renderer; `ChannelRequest<'sgf:parse'>` where a request type is needed). This originally said a lint rule enforced it; that rule was measured to be both wrong and unnecessary and has been removed — see the comment in `eslint.config.js`. Because every wrapper is generic over `C extends ChannelName`, a mistyped channel is a TS2345 that names all eleven valid channels, which is a louder failure than any lint message: `invoke('sgf:prase', …)` reports *Argument of type '"sgf:prase"' is not assignable to parameter of type '"sgf:parse" | "sgf:serialize" | …'*. So an inline channel literal at a wrapper call site is safe and is the normal style in `src/preload/index.ts`. What no type can express is reaching *past* the wrappers to Electron's primitives — `ipcMain.handle` and `webContents.send` are perfectly well-typed and silently skip validation and error-envelope mapping. That is what the surviving lint rule bans.

**No business logic in `components/`.** Components render and dispatch. Go rules, SGF handling, and protocol encoding live in `packages/core`.

**No cross-importing between `panels/` files.** If two panels need the same thing, it belongs in `components/`, `hooks/`, or a store.
