# Architecture

How GoMentor is actually built, as of M1.

This is the living document. The planning artifacts under `.trellis/` are frozen at plan time and record _why_ decisions were made; this file records what the code does now, and it is the one to change when the code changes. Where the two disagree, the code is right and this file is stale — say so in the same commit that causes it.

Two related documents: [`ipc-contract.md`](./ipc-contract.md) for the process boundary in detail, and [`adr/`](./adr/) for the decisions that are expensive to revisit.

## What M1 is

A desktop Go study application: open SGF files, step through games, and talk to an LLM teacher about the position. No analysis engine, no database, no accounts.

The engine's absence is a _state_, not a missing feature. `engine:status` reports `unavailable` for the whole of M1, every other feature works while it does, and M2 adds the engine without touching UI control flow. A build that disabled itself for lack of KataGo would pass a badge test and fail the requirement.

## Three processes

```
┌──────────────────────────────────────────────────────────────┐
│ MAIN — the only process with OS authority                    │
│                                                              │
│  index.ts        lifecycle, single-instance lock             │
│  window.ts       BrowserWindow, bounds persistence           │
│  menu.ts         native menu, localised in main              │
│  paths.ts        the single source of truth for every path   │
│  logger.ts       electron-log + redact.ts serializer         │
│  settings.ts     zod-validated document on disk              │
│  safe-storage.ts OS keychain; refuses plaintext fallback     │
│  telemetry.ts    no-op in M1, call sites already stable      │
│  ipc/            register.ts (zod gate) + 4 handler modules  │
│  llm/service.ts  run lifecycle, streams over events          │
│  library/store.ts in-memory Map (no SQLite in M1)            │
│  sgf/adapter.ts  bridges core's parser to the handlers       │
└───────────────▲───────────────────────────┬──────────────────┘
                │ invoke                    │ typed events
┌───────────────┴───────────────────────────▼──────────────────┐
│ PRELOAD — thin, frozen, no business logic                    │
│  contextBridge.exposeInMainWorld('gomentor', api)            │
│  one named function per channel; no generic passthrough      │
└───────────────▲───────────────────────────┬──────────────────┘
                │                           │
┌───────────────┴───────────────────────────▼──────────────────┐
│ RENDERER — React 19, presentation only, no Node APIs         │
│  App.tsx                three-panel shell                    │
│  panels/                Board · Library · Teacher            │
│  hooks/useIpcEvent      one subscription primitive           │
│  hooks/useMainProcessEvents  all four event subscriptions    │
│  state/                 4 zustand stores                     │
│  i18n/                  en + zh-CN                           │
└──────────────────────────────────────────────────────────────┘
```

The window is created with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` ([`window.ts:102`](../apps/desktop/src/main/window.ts#L102)). A leak across that boundary is a sandbox escape, not a bug, which is why the preload has no generic `send`/`on` and the renderer has no `window.ipcRenderer`.

Note one consequence that catches people: a sandboxed preload cannot be an ES module, so electron-vite emits it as CJS `.js` regardless of the rest of the build ([`window.ts:97-100`](../apps/desktop/src/main/window.ts#L97)).

### Direction rules

Renderer → main is **always** `invoke`. Main → renderer is **always** an event. The asymmetry is not stylistic: a token stream has no length at call time, so `invoke` cannot model it, and a notification nobody requested has no call to attach to.

M1 streams LLM token deltas. M2 adds analysis ticks, **coalesced in main to ~20/s** — engines emit far faster than a UI can usefully paint, and flooding IPC is a known Electron performance cliff.

Full channel reference: [`ipc-contract.md`](./ipc-contract.md).

## Packages

| Package            | May depend on                      | Must never depend on                  |
| ------------------ | ---------------------------------- | ------------------------------------- |
| `@gomentor/shared` | `zod` only                         | anything else in the workspace        |
| `@gomentor/core`   | `shared`, `zod`, `openai`          | `electron`, Node APIs beyond `node:*` |
| `apps/desktop`     | `shared`, `core`, `electron`, Node | —                                     |
| `apps/web`         | `shared`, `core`                   | `electron`                            |

Enforced by `no-restricted-imports` in [`eslint.config.js`](../eslint.config.js), per package, with the reason in the message — a lint error that explains itself is the difference between a rule people follow and a rule people disable.

**`shared` is contracts only.** Types, zod schemas, constants, and the IPC contract. No logic, so both other packages can depend on it without a cycle.

**`core` is Electron-free**, which is what makes it unit-testable without spawning Electron and reusable by the website's interactive demos. It holds the SGF parser and serializer, board rules and coordinates, the LLM provider, and the KataGo protocol codecs.

**`core/katago/{gtp,analysis}.ts` exist in M1 with no process management** — pure encoders and decoders. Writing the protocol layer before the process layer confines M2's risk to process lifecycle rather than to protocol correctness, which is the harder thing to debug against a real engine.

## SGF

```
SGF bytes ──parser──► GameTree AST (values kept RAW)
                        │
     ┌──────────────────┼──────────────────┐
     ▼                  ▼                  ▼
board/position     library store      (M2: DB rows)
(replay to move N)  (metadata)
     │
     ▼
serializer ──► SGF text (escaping + unknown props intact)
```

Hand-written rather than wrapping a library, for one reason that turned out to be decisive: unknown properties must round-trip **byte-for-byte**, and a library that decodes `\]` to `]` on read has already lost the bytes needed to write it back. So the AST stores values **raw**, and typed accessors in [`sgf/props.ts`](../packages/core/src/sgf/props.ts) decode opt-in per property.

**Unknown-property preservation is a hard contract.** Files in the wild carry editor- and engine-specific properties. Dropping them silently means a user's file degrades a little every time it passes through GoMentor.

Failure modes are typed and distinct — `SGF_TRUNCATED`, `SGF_EMPTY`, `SGF_NOT_SGF`, `SGF_INVALID_PROPERTY`, `SGF_UNSUPPORTED_BOARD_SIZE`, `SGF_TOO_DEEP` — because each has a different remedy to offer the user. The parser must also never hang on malformed input; a hang freezes the import flow with no recovery path.

`SGF_UNSUPPORTED_ENCODING` is the one write-side code: `TextEncoder` emits only UTF-8, so a file that arrived in a legacy codepage cannot be re-encoded back to it.

## Coordinates

Internal `[x, y]`, zero-indexed from the top-left, is canonical. Every conversion is a pure function in [`board/coords.ts`](../packages/core/src/board/coords.ts):

```
internal [x,y] ◄──► SGF letters ("dp")
               ◄──► GTP labels ("D4" — skipping I)
               ◄──► pixel space (DPR-aware)
```

Historically this is where Go software bugs live, the GTP `I`-skip above all. Hence property-based tests asserting round-trip identity across _all_ points at _all_ board sizes, rather than a handful of hand-picked examples that all happen to avoid column I.

`BOARD_INVALID_COORD` is deliberately separate from `SGF_INVALID_PROPERTY`: it is reached from GTP encoding, canvas geometry, and flat-index conversion, none of which involve a file, and the renderer translates codes into user-facing text — so reusing the SGF code would tell a user their file is malformed for a bug that has nothing to do with a file. `sgf/props.ts` converts one to the other when the coordinate did come from a file.

## Board rendering

**Designed, not yet built.** [`panels/BoardPanel.tsx`](../apps/desktop/src/renderer/src/panels/BoardPanel.tsx) is the shell; `components/Board.tsx` does not exist yet. Recorded here so the plan is visible, and marked so nobody reads it as shipped.

Two stacked canvases, both sized to `devicePixelRatio`:

| Layer   | Contents                                                       | Redraws on   |
| ------- | -------------------------------------------------------------- | ------------ |
| Static  | wood, grid, star points, coordinate labels                     | resize only  |
| Dynamic | stones, last-move marker, (M2: heatmap, ownership, candidates) | state change |

Splitting them is what makes M2's per-frame overlays affordable: the expensive static content is painted once per resize, not once per analysis tick.

Animations get a ≤120ms budget via `requestAnimationFrame`, **cancellable and skippable**. Skippability is an accessibility requirement and a practical one — holding the arrow key to scan a game must not queue two hundred animations.

## LLM

```
              ┌──────────────────────────┐
              │ LLMProvider (interface)  │
              │  chat(req, signal)  ──► AsyncIterable<ChatChunk>
              │  listModels() · health() · capabilities
              └────────────▲─────────────┘
              ┌────────────┴─────────────┐
              │ OpenAICompatibleProvider │  ← the only implementation
              └────────────▲─────────────┘
                    ┌──────┴──────┐
                 cloud.ts      local.ts    ← thin factories
                 short timeout  long timeout
                 2 retries      0 retries
```

`chat()` is an async iterator rather than callbacks or an EventEmitter: streaming becomes a `for await`, cancellation is breaking out of the loop, and `AbortSignal` propagates into the underlying fetch. Callback-based cancellation is materially harder to reason about.

**Local gets zero retries and a long timeout; cloud gets two retries and a short one.** A local GPU loading a large model can legitimately take a minute to first token, and retrying just multiplies the load. A failing cloud API is usually transient.

Two properties that shape every test touching this layer:

- **`LLM_NO_KEY` throws at provider _construction_.** So the cloud path is unusable in any keyless environment, CI included. `kind: 'local'` needs no credential, which is what makes the LLM path testable without secrets.
- **`probeCapabilities` runs on first connect** and records whether tool calls actually work. Tool support in Ollama/LM Studio varies **by model**, not by server, so it cannot be inferred from configuration. Recording it lets M3's agent loop fall back to a no-tools prompt instead of failing at the first dispatch.

The agent loop is deferred to M3 but its boundary is already fixed: it belongs in **main**, because tools need database, engine, and filesystem access, and a renderer reload must not orphan an in-flight multi-step run.

## Settings and secrets

```
settings.json  { …zod-validated…, llm: { …, hasSecret: true }, secretBlob: "<opaque>" }
                                                 ▲
                                   safeStorage.encryptString (OS keychain)
```

The `hasSecret` boolean is plaintext and does cross to the renderer — the UI must show whether a key is configured. **The key itself never leaves main.** There is no `settings:getSecret` channel at all; a boolean is the entire renderer-visible surface of every secret.

If `safeStorage.isEncryptionAvailable()` is false — real on some Linux desktop configurations — the app **refuses to persist**, holds the key in memory for the session, and warns in the UI. Writing plaintext as a fallback would be a silent security downgrade the user never agreed to.

[`redact.ts`](../apps/desktop/src/main/redact.ts) is a logger serializer keyed on field name and on key-shaped values. It is a **backstop, not permission**: the rule is that secrets are never passed to a log call in the first place.

### What must never be logged, at any level

API keys or any secret, including redacted-looking prefixes. SGF content or game records. Chat text, prompts, or LLM completions. A `baseUrl` with credentials — log the host, never userinfo or query params. Stack traces sent to the renderer.

The reason is the subject matter: this tool handles a user's private study material and their LLM keys.

**Error messages are log payloads.** A message interpolating a value from a file, a prompt, or a network response must bound that value where the message is built — see the 40-character head in [`gtp.ts`](../packages/core/src/katago/gtp.ts). And when logging zod issues, log **paths only, never values**.

## Renderer state

Four zustand stores, split by **lifecycle** rather than by screen:

| Store                                                                      | Owns                                         |
| -------------------------------------------------------------------------- | -------------------------------------------- |
| [`gameStore`](../apps/desktop/src/renderer/src/state/gameStore.ts)         | current game, cursor, derived board position |
| [`chatStore`](../apps/desktop/src/renderer/src/state/chatStore.ts)         | messages, streaming state, active `runId`    |
| [`settingsStore`](../apps/desktop/src/renderer/src/state/settingsStore.ts) | mirror of persisted settings                 |
| [`libraryStore`](../apps/desktop/src/renderer/src/state/libraryStore.ts)   | game list, import status                     |

zustand over Redux (too much ceremony at this size) and over Jotai (atom sprawl once imperative code reads state). The deciding factor: the canvas renderer and the IPC event handlers both need `getState()` from **outside React**, which zustand does natively.

All four main→renderer subscriptions live in one place, [`useMainProcessEvents.ts`](../apps/desktop/src/renderer/src/hooks/useMainProcessEvents.ts), on top of a single [`useIpcEvent`](../apps/desktop/src/renderer/src/hooks/useIpcEvent.ts) primitive.

Two facts about that hook worth knowing before you change it, both established by measurement rather than argument:

- **`contextBridge` returns a stable reference** for a repeated property read, so the exposed function is safe to use in a dependency array. Asserted against the built app in `test/e2e/ipc-events.spec.ts`.
- **The built renderer is a production React bundle, so StrictMode is inert there.** Effects are never double-invoked and `App` never remounts, which means _no e2e test can reach the subscription teardown path_. Discarding `subscribe`'s return value passes the entire suite. The hook is still correct; its correctness is simply not machine-verified, and the code says so at the line.

## Errors

Every error crossing a boundary carries a domain-prefixed `code` ([`types/errors.ts`](../packages/shared/src/types/errors.ts)). No bare throws, no `Error` without a code.

The wire form is `{ code, message, context? }` — **no `cause`, no stack**. Stacks carry filesystem paths and argument values, so they stay in main. The renderer translates `code` through the `errors` i18n namespace and **never renders `message` as primary UI text**.

There is a mechanical reason this is data rather than a throw: `contextBridge` copies structurally, and a thrown `Error` arrives on the renderer side with **only `message`** — `code` and `context` are gone. So every handler returns `IpcResult<T>`, and `register.ts` maps throws into it.

**Expected absence is a state, not an exception.** A cancelled dialog returns `[]`. A missing engine reports `unavailable`. An empty library returns `games: []`. None is `ok: false`.

## Operational

- **Single-instance lock** in [`index.ts:52`](../apps/desktop/src/main/index.ts#L52). Two instances would fight over settings, the log file, and later SQLite and the GPU.
- **`paths.ts` is the single source of truth** for userData, resources, logs, and library roots. Scattered `path.join(app.getPath(...))` calls are how cross-platform path bugs get in.
- **Window bounds** are persisted and restored with an on-screen validity check, so a window never restores off-screen after a monitor change.
- **Logging** is `electron-log`, file plus console with rotation, wrapped to enforce `{ level, ts, scope, msg, ...fields }`. Renderer logs forward to main. A "Reveal logs" menu item ships in M1 — it is the highest-value support affordance there is.
- **Telemetry** is opt-in, default off, and a **no-op until consented** — no network call whatsoever before consent. When enabled: crashes only, never gameplay content, SGF, chat text, or prompts. The wiring lands in M5; [`telemetry.ts`](../apps/desktop/src/main/telemetry.ts) exists now so call sites are stable.
- **No SQLite in M1**, deliberately. The library is an in-memory `Map` ([`library/store.ts:47`](../apps/desktop/src/main/library/store.ts#L47)), which keeps `better-sqlite3`'s native-rebuild variable out of an already-risky toolchain bring-up. M2 adds it when there is analysis data worth persisting.
- **Rollback** is reinstall: M1 has no persistent schema. The one migration-shaped concern is settings forward-compatibility, and it is tested — unknown keys must survive a load→save cycle, so a user who runs a newer build and rolls back does not lose settings.

## Packaging

electron-builder, configured in [`electron-builder.yml`](../apps/desktop/electron-builder.yml). Windows NSIS, macOS dmg, Linux AppImage.

`electronVersion` is **pinned exactly**, and the comment in that file explains why at length. Short version: `.npmrc` sets `node-linker=hoisted`, so Electron resolves at the repository root while electron-builder looks under `apps/desktop`, and a caret range leaves it nothing to fall back on. Keep it in step with the `electron` devDependency.

KataGo binaries and weights ship **outside the asar** via `extraResources`, so the engine can be spawned as a child process and so update blockmaps stay effective at 120MB+. The directories are empty in M1 — the structure exists now so M2 is purely additive. `scripts/fetch-katago.ts` and `scripts/fetch-weights.ts` are the stubs that will fill them.

## Testing

The technique per layer is chosen against a specific failure mode, not by habit.

| Layer          | Technique                                                       | Why this one                                                                                       |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SGF round-trip | Fixture corpus of real-world files                              | Real malformation is not something you invent; it has to come from actual files                    |
| Coordinates    | Property-based (`fast-check`)                                   | The bug space is all points × all sizes; examples miss the `I`-skip                                |
| Board rules    | Hand-built positions                                            | Capture, suicide, ko, multi-group capture are specific known-hard cases                            |
| LLM provider   | Real HTTP server (`node:http`)                                  | Must assert chunk _assembly order_ and mid-stream abort, which a mocked SDK object cannot exercise |
| IPC schemas    | Table-driven + meta-test                                        | The meta-test is what stops an untested channel being added later                                  |
| KataGo process | **Real spawned child** speaking GTP                             | Exercises actual pipes, framing, and exit handling. Mocks would test the mock                      |
| Handlers       | Stubbed `ipcMain`, invoke each channel, validate against schema | Catches handler/schema drift without a UI                                                          |
| Settings       | Write → restart-simulate → read, plus unknown-key survival      | Forward-compat is a correctness property                                                           |
| App shell      | Playwright `_electron` against `out/` + a manual checklist      | Some of it — visual board correctness, key absence from logs — is genuinely human-verified         |

Run tests from the **repository root**, never by `cd`-ing into a package.

### Rules this suite has learned the hard way

Each of these is here because it already happened, and each cost real time to find.

- **A test that cannot fail is not a test.** Before trusting a new assertion, break the thing it watches and confirm it goes red.
- **A test must not reimplement its subject.** A 44-fixture sweep once built its own copy of the adapter; gutting the real one left 784 tests green.
- **Key completeness is not translation.** Five fully untranslated namespaces passed the i18n gate. Assert values _differ_, not just that keys exist.
- **Generated cases can delete their own coverage.** Looping over the array under test means a deletion removes the case that would have caught it. Anchor to an independent authority.
- **Mutation testing does not check fixtures.** 1017 green tests and 23 killed mutants still hid two invented error codes. Parse fixtures through their schema.
- **An e2e launch must isolate its profile.** `electron.launch()` with no `--user-data-dir` uses `%APPDATA%/Electron`, shared with every other spec, every run, and every unpackaged Electron app on the machine — the same directory that holds secrets and imported games. The harness now allocates one per launch.
- **Playwright loads each spec file twice.** `--list` runs zero tests and still executes describe-body side effects, which have no hooks behind them. Put setup in `beforeAll`.
- **On Windows, do not spawn `npx`/`.cmd` without a shell.** `npx` is ENOENT (not executable by `exec`), `npx.cmd` is EINVAL since the CVE-2024-27980 fix, and both fail _silently_ with a non-zero status and no output — so a gate reports its subject as broken when it never started. Spawn `process.execPath` with the resolved `.mjs` entry.

### CI gates beyond the suite

Lockfile drift, dependency-license compatibility with GPL-3.0, i18n key completeness against `en`, and the Trellis-immutability guard. The license gate exists because one incompatible transitive dependency is a legal problem, and commit time is the cheapest place to discover it.

## Coexistence with Trellis

Six paths are off-limits to app code, build scripts, and CI: `.trellis/`, `.claude/`, `.codex/`, `.qoder/`, `.agents/`, `AGENTS.md`. Nothing in `apps/`, `packages/`, `scripts/`, or `.github/` may read from or write to them.

Enforced at three layers, because one layer is one point of failure:

1. **Graph exclusion** — `tsconfig.base.json` `exclude` and `eslint.config.js` `ignores` list all six, so a stray file can never enter a compile or a lint pass.
2. **CI guard** — after a full install/build/package, `git diff --exit-code` over all six must be clean. `pnpm check:trellis` runs it locally. If a build step ever mutates workflow state, CI fails loudly instead of corrupting it silently.
3. **Convention** — `AGENTS.md` edits go strictly after the `TRELLIS:END` marker; app `.gitattributes` rules append below the existing Trellis block.

This document links to no file under those paths, deliberately: `docs/` has to stand on its own for a reader who does not have them.

## Licence

GPL-3.0. Any derivation from lizzieyzy-next makes it mandatory, and relicensing later would need every contributor's consent. See [`adr/0001-license.md`](./adr/0001-license.md).
