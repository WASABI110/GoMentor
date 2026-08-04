# Directory Structure

> How backend code is organized in this project.

---

## Overview

"Backend" here means the **Electron main process** plus the two shared packages. There is no server — this is a local-first desktop app, and the main process plays the role a backend would: it is the sole holder of OS authority.

Main owns: filesystem, secrets, all outbound network, child processes (KataGo, readboard), the database, logging, and the LLM agent loop. The renderer has none of these and reaches them only through the preload bridge.

**Workspace dependency rules** — these are enforced by lint, not convention:

| Package | May depend on | Must never depend on |
|---|---|---|
| `@gomentor/shared` | `zod` only | anything else in the workspace |
| `@gomentor/core` | `shared`, `@sabaki/sgf`, `openai` | `electron`, Node-only APIs beyond `node:*` primitives |
| `apps/desktop` | `shared`, `core`, `electron`, Node | — |
| `apps/web` | `shared`, `core` | `electron` |

`packages/core` staying Electron-free is what makes it unit-testable without spawning Electron, and reusable by the website's interactive demos.

---

## Directory Layout

```
apps/desktop/src/main/
├── index.ts                # entry: single-instance lock, lifecycle, IPC registration
├── window.ts               # BrowserWindow factory, hardened webPreferences, bounds persistence
├── menu.ts                 # native menu, i18n-aware, "Reveal logs" item
├── paths.ts                # SINGLE source of truth for every path
├── logger.ts               # electron-log setup, structured fields, secret redaction
├── settings.ts             # zod-validated persistence, migration-safe defaults
├── safe-storage.ts         # encrypted secrets; refuses plaintext fallback
├── telemetry.ts            # opt-in, no-op until consented
├── updater.ts              # electron-updater wiring
├── ipc/
│   ├── register.ts         # handle() wrapper: schema validation + error mapping
│   └── <domain>.handlers.ts
├── katago/
│   ├── process.ts          # spawn/kill/restart, stdio framing, health
│   ├── engine-manager.ts   # engine pool, one active per analysis session
│   ├── backend-detect.ts   # probe TensorRT → CUDA → OpenCL → Eigen
│   └── config-writer.ts
├── llm/
│   ├── service.ts          # owns provider, runId issuance, stream fan-out
│   ├── agent-loop.ts       # bounded ReAct: step budget, cancellation
│   └── tools/              # tool implementations
├── db/
│   ├── index.ts            # better-sqlite3 connection, WAL, pragmas
│   ├── migrations/         # 0001_init.sql, numbered, applied in a transaction
│   └── repositories/       # one per aggregate
├── library/
│   ├── import.ts           # drag-drop + folder scan → DB
│   └── watcher.ts          # chokidar, debounced
└── integrations/
    ├── fox/                # 野狐 sync — inherently fragile, isolated
    └── readboard/          # physical board bridge, out-of-process

packages/shared/src/        # contracts only, zero logic
├── ipc.ts                  # THE contract: channels + zod schemas
├── types/                  # game, analysis, chat, settings
└── constants.ts

packages/core/src/          # pure domain logic, Electron-free
├── sgf/                    # ast, parser, serializer, props
├── board/                  # position, rules, coords, zobrist
├── katago/                 # gtp, analysis, commands — protocol only, no processes
├── llm/                    # provider, openai-compatible, cloud, local, prompts
├── kb/                     # index, search, schema
└── profile/                # model, weakness, plan
```

---

## Module Organization

**Protocol is separate from process.** `packages/core/src/katago/` encodes and decodes GTP and analysis-mode JSON with no knowledge of child processes. `main/katago/process.ts` handles spawning and lifecycle around it. This split means protocol correctness is testable headless, and process risk is confined to one file.

The same split applies to LLM: `core/llm/` is the provider abstraction and wire protocol; `main/llm/service.ts` owns the instance and bridges to IPC.

**One handler file per IPC domain**, named `<domain>.handlers.ts`, registered centrally in `ipc/register.ts`. Handlers are thin — they validate (via the wrapper), delegate to a service or repository, and return. Business logic in a handler is a smell.

**Integrations are isolated and allowed to be defensive.** `integrations/fox/` scrapes an API we do not own; it will break without warning. It gets its own rate limiter, its own error handling, and recorded-fixture tests. No core flow may depend on it succeeding.

---

## Naming Conventions

- Files: `kebab-case.ts` (`safe-storage.ts`, `backend-detect.ts`)
- IPC handler files: `<domain>.handlers.ts`
- Migrations: `NNNN_description.sql`, zero-padded, never renumbered
- Repositories: `<aggregate>.ts` under `db/repositories/`
- IPC channels: `domain:verb` (`sgf:parse`, `llm:sendMessage`)

---

## Forbidden patterns

**No path construction outside `paths.ts`.** Scattered `path.join(app.getPath(...))` calls are how cross-platform path bugs enter. `paths.ts` is the single source of truth — this is what makes the Windows-first, cross-platform-clean stance actually hold.

**No `electron` import in `packages/core`.** Lint-enforced. Core must run under plain Node in tests.

**No raw IPC channel strings outside `packages/shared/src/ipc.ts`.** Lint-enforced.

**No `ipcMain.handle` called directly.** Always go through `ipc/register.ts`'s `handle()` wrapper, so every channel gets schema validation and consistent error mapping.

**No secrets crossing to the renderer.** Only the plaintext `hasSecret` boolean does. The key itself never leaves main.

**No app code touching Trellis paths.** `.trellis/`, `.claude/`, `.codex/`, `.qoder/`, `.agents/`, and `AGENTS.md` are off-limits to application code, build scripts, and CI. A CI guard asserts they stay unmodified after a full build.
