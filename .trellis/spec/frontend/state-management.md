# State Management

> How state is managed in this project.

---

## Overview

**zustand.** Chosen over Redux (too much ceremony for a desktop app) and Jotai (atom sprawl once imperative code needs to read state).

The deciding property is `getState()` **outside React**. Two places need it and neither is a React component:

1. The **canvas board renderer**, which draws imperatively inside `requestAnimationFrame` and cannot use hooks
2. **IPC event handlers**, which receive main-process events (LLM token deltas, later KataGo analysis ticks) outside any render cycle

zustand supports both natively. This is not a style preference — a hooks-only store would force the canvas layer into awkward ref-mirroring.

---

## State Categories

| Category | Where | Example |
|---|---|---|
| Component-local | `useState` / `useReducer` | input draft text, hover point, panel collapsed |
| Cross-component | zustand store in `state/` | current game, chat messages, settings mirror |
| Owned by main process | zustand store, **mirrored** via IPC | settings, library contents, engine status |
| Derived | selector or computed getter | board position at cursor, weakest categories |

There is no "server state" here — the app is local-first. The main process plays the role a server would: it owns the authoritative copy of settings, the library, and engine state, and the renderer mirrors it.

---

## Stores

Split by **lifecycle**, not by screen. Four stores in M1:

| Store | Owns |
|---|---|
| `gameStore` | current game, cursor position, derived board position |
| `chatStore` | message list, streaming state, active `runId` |
| `settingsStore` | mirror of persisted settings |
| `libraryStore` | game list, import status |

Splitting by screen would put the same game in two stores the moment two panels show it.

---

## When to Use Global State

Promote to a store when **either** holds:

- Two or more components that are not parent/child need it
- Imperative code outside React (canvas renderer, IPC handler) needs to read it

Otherwise keep it local. A store entry that only one component reads is indirection with no payoff.

---

## Mirroring main-process state

State the main process owns is **never** duplicated as a second source of truth. The pattern:

1. Read once on mount via `invoke`
2. Subscribe to the corresponding change event (`settings:changed`, `library:changed`)
3. Write by calling `invoke` — **not** by mutating the store directly, then let the event update it

Writing the store optimistically *and* awaiting the invoke is allowed, but the event remains authoritative. If they disagree, the event wins.

---

## Derived state

Compute in selectors, don't store. The board position at the cursor is derived from `(game, cursor)` — storing it separately creates two things that can disagree.

Use `packages/core` for the actual derivation (`board/position.ts` replays moves). Stores hold inputs; `core` computes outputs.

---

## Common Mistakes

**Storing derived state.** Board position, weakest-category lists, and move counts are all derived. Store the inputs.

**Duplicating main-process state as authoritative.** If the renderer's copy and `settings.json` disagree, the file wins. Treat the store as a cache.

**Subscribing to a whole store in a component.** `useStore()` with no selector re-renders on every unrelated change. Always pass a selector.

**Reaching for a store from inside `packages/core`.** Core is pure and Electron-free; it takes arguments and returns values. A core function that reads a zustand store is untestable headless.

**Putting the LLM streaming buffer in React state.** Token deltas arrive faster than React can usefully re-render. Accumulate in the store (or a ref) and let the UI read at its own cadence — the same coalescing reasoning that applies to KataGo ticks in the main process.
