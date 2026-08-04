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

**No `window.ipcRenderer`.** The only bridge is `window.gomentor`, exposed as a frozen object by preload. A raw `ipcRenderer` handle in the page is a sandbox escape.

**No raw IPC channel strings.** Import from `packages/shared/src/ipc.ts`. A lint rule enforces this; string literals drift silently when a channel is renamed.

**No business logic in `components/`.** Components render and dispatch. Go rules, SGF handling, and protocol encoding live in `packages/core`.

**No cross-importing between `panels/` files.** If two panels need the same thing, it belongs in `components/`, `hooks/`, or a store.
