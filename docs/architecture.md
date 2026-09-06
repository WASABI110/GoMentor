# Architecture

How GoMentor is actually built, as of M2.

This is the living document. The planning artifacts under `.trellis/` are frozen at plan time and record _why_ decisions were made; this file records what the code does now, and it is the one to change when the code changes. Where the two disagree, the code is right and this file is stale — say so in the same commit that causes it.

Two related documents: [`ipc-contract.md`](./ipc-contract.md) for the process boundary in detail, and [`adr/`](./adr/) for the decisions that are expensive to revisit.

## What M2 is

A desktop Go study application: open SGF files, step through games, read live KataGo analysis of the position — winrate, candidate moves with principal variations, per-point ownership, a whole-record winrate graph — and talk to an LLM teacher about it. No database, no accounts.

The engine is real now: a bundled KataGo (Eigen CPU build, one small net) is fetched at build time, packaged outside the asar, and spawned lazily by main when the first game opens. Absence survives as a _state_ regardless, because it still happens — macOS (no official KataGo binary is published for it), a dev checkout that has not run `pnpm fetch:katago`, and an engine past its restart budget all report `unavailable` or `failed`, and every other feature works in each. That is the M1 invariant, kept rather than retired: a build that disabled itself for lack of KataGo would pass a badge test and fail the requirement.

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
│  telemetry.ts    no-op until consent, call sites stable      │
│  ipc/            register.ts (zod gate) + 5 handler modules  │
│  katago/         engine lifecycle: locate, probe, recover    │
│  llm/service.ts  run lifecycle, streams over events          │
│  library/store.ts in-memory Map (no SQLite yet)              │
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
│  hooks/useMainProcessEvents  all seven event subscriptions   │
│  state/                 5 zustand stores                     │
│  i18n/                  en + zh-CN                           │
└──────────────────────────────────────────────────────────────┘

MAIN also spawns one child process of its own — KataGo, reached by stdin/stdout
newline-JSON, whose exit events main handles:

┌──────────────────────────────────────────────────────────────┐
│ KATAGO — child process, bundled outside the asar             │
│  Eigen CPU build + one small net, win32-x64 and linux-x64    │
│  only. macOS has nothing bundled and main reports            │
│  `unavailable` there by construction.                        │
└──────────────────────────────────────────────────────────────┘
```

The window is created with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` ([`window.ts:102`](../apps/desktop/src/main/window.ts#L102)). A leak across that boundary is a sandbox escape, not a bug, which is why the preload has no generic `send`/`on` and the renderer has no `window.ipcRenderer`.

Note one consequence that catches people: a sandboxed preload cannot be an ES module, so electron-vite emits it as CJS `.js` regardless of the rest of the build ([`window.ts:97-100`](../apps/desktop/src/main/window.ts#L97)).

### Direction rules

Renderer → main is **always** `invoke`. Main → renderer is **always** an event. The asymmetry is not stylistic: a token stream has no length at call time, so `invoke` cannot model it, and a notification nobody requested has no call to attach to.

Two things stream today: LLM token deltas and analysis ticks. The ticks are **coalesced in main to ≤20/s per query** ([`katago/coalesce.ts`](../apps/desktop/src/main/katago/coalesce.ts)) — the engine emits partial results far faster than a UI can usefully paint, and flooding IPC is a known Electron performance cliff. Latest-wins is the correct drop policy there: each tick is a snapshot of the same search, so the only one worth its IPC cost is the newest. A `complete` tick bypasses the window, because it is the settled verdict rather than a snapshot.

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

**`core/katago/{gtp,analysis}.ts` are pure encoders and decoders, and still know nothing of processes.** The protocol layer was written before any process existed to speak it, which is what confined the engine work to lifecycle — spawn, framing, recovery — rather than to protocol correctness, the harder thing to debug against a real engine. [`main/katago/`](../apps/desktop/src/main/katago/service.ts) consumes these codecs and adds everything with a pid.

## SGF

```
SGF bytes ──parser──► GameTree AST (values kept RAW)
                        │
     ┌──────────────────┼──────────────────┐
     ▼                  ▼                  ▼
board/position     library store      (M4: DB rows)
(replay to move N)  (metadata)
     │
     ▼
serializer ──► SGF text (escaping + unknown props intact)
```

Hand-written rather than wrapping a library, for one reason that turned out to be decisive: unknown properties must round-trip **byte-for-byte**, and a library that decodes `\]` to `]` on read has already lost the bytes needed to write it back. So the AST stores values **raw**, and typed accessors in [`sgf/props.ts`](../packages/core/src/sgf/props.ts) decode opt-in per property.

**Unknown-property preservation is a hard contract.** Files in the wild carry editor- and engine-specific properties. Dropping them silently means a user's file degrades a little every time it passes through GoMentor.

Failure modes are typed and distinct — `SGF_TRUNCATED`, `SGF_EMPTY`, `SGF_NOT_SGF`, `SGF_INVALID_PROPERTY`, `SGF_UNSUPPORTED_BOARD_SIZE`, `SGF_TOO_DEEP` — because each has a different remedy to offer the user. The parser must also never hang on malformed input; a hang freezes the import flow with no recovery path.

`SGF_UNSUPPORTED_ENCODING` is the one write-side code: `TextEncoder` emits only UTF-8, so a file that arrived in a legacy codepage cannot be re-encoded back to it.

**The renderer sees a projection; the AST stays in main.** `sgf:parse` follows one line through the tree — the mainline, or a chosen branch via the optional `variationPath` — and reports, per mainline move, what the alternatives are ([`Game.branches`](../apps/desktop/src/main/sgf/adapter.ts)). Navigating a variation re-parses with a new path rather than shipping a second tree structure to the renderer, so the invariant that exactly one thing produces a `Game` survived M2's branch navigation instead of being paid for it.

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

[`panels/BoardPanel.tsx`](../apps/desktop/src/renderer/src/panels/BoardPanel.tsx) is the shell; [`components/Board.tsx`](../apps/desktop/src/renderer/src/components/Board.tsx) renders it: two stacked canvases, both sized to `devicePixelRatio`.

| Layer   | Contents                                                                     | Redraws on   |
| ------- | ---------------------------------------------------------------------------- | ------------ |
| Static  | wood, grid, star points, coordinate labels                                   | resize only  |
| Dynamic | stones, last-move marker, hover ghost, capture animations, analysis overlays | state change |

Splitting them is what makes the per-tick analysis overlays affordable: the expensive static content is painted once per resize, not once per analysis tick.

The dynamic layer's **draw order is load-bearing**: ownership fill under the stones (a tinted stone is still a stone), then stones, last-move marker, candidate letters, PV ghost stones, hover ghost on top. Candidates drawn beneath the stones would vanish on occupied points — which is where most candidates are, late in a game.

M1 planned a third DOM/SVG overlay layer for the analysis marks. They landed on the dynamic canvas instead, and [`BoardOverlay.tsx`](../apps/desktop/src/renderer/src/components/BoardOverlay.tsx) remains the empty scaffold it was: per-point ownership tints and ghost stones are canvas pixels like everything else on that layer, and a second coordinate system would have been a second place to drift. The winrate graph is the exception, and is SVG ([`WinrateGraph.tsx`](../apps/desktop/src/renderer/src/components/WinrateGraph.tsx)) — a few hundred nodes updating about once per completed position is nowhere near the per-frame load that ruled SVG out for the board, and SVG buys click-to-seek and testable geometry. Its unanalysed region renders as a hatch rather than a 50% flatline, because "the engine says even" is a result and "no data yet" is not.

Animations get a ≤120ms budget via `requestAnimationFrame`, **cancellable and skippable**. Skippability is an accessibility requirement and a practical one — holding the arrow key to scan a game must not queue two hundred animations.

## KataGo engine

The engine is a child process owned by main, speaking KataGo's **analysis protocol** — newline-JSON on stdio — not GTP. Analysis mode answers one query with winrate, score lead, ranked candidate moves with principal variations, and the per-point ownership array in a single id-correlated response, which is the whole readout the review UI needs. GTP stays in [`core/katago/gtp.ts`](../packages/core/src/katago/gtp.ts), exercised by the test fakes, for third-party engines and a future play-vs-engine mode; no product code path issues a GTP command today.

[`main/katago/`](../apps/desktop/src/main/katago/service.ts) is split the same way `core` is — decisions pure, side effects thin:

| Module                                                                                                                                                                                                   | Owns                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`locate.ts`](../apps/desktop/src/main/katago/locate.ts)                                                                                                                                                 | binary/weights resolution: `GOMENTOR_KATAGO_BINARY` override, packaged layout, dev layout |
| [`config.ts`](../apps/desktop/src/main/katago/config.ts)                                                                                                                                                 | the analysis config string, rewritten under userData at each start                        |
| [`process.ts`](../apps/desktop/src/main/katago/process.ts)                                                                                                                                               | spawn, stdio framing (the production `splitJsonLines`), stderr capture, shutdown          |
| [`session.ts`](../apps/desktop/src/main/katago/session.ts)                                                                                                                                               | query mechanics: ids, in-flight routing, terminate-on-supersede, the sweep driver         |
| [`sweep.ts`](../apps/desktop/src/main/katago/sweep.ts)                                                                                                                                                   | the whole-record ledger: what completed, what to query next                               |
| [`coalesce.ts`](../apps/desktop/src/main/katago/coalesce.ts)                                                                                                                                             | the ≤20/s latest-wins ceiling on `engine:analysis`                                        |
| [`perspective.ts`](../apps/desktop/src/main/katago/perspective.ts)                                                                                                                                       | the one place KataGo's values are adapted onto the shared contract                        |
| [`backoff.ts`](../apps/desktop/src/main/katago/backoff.ts) / [`state-machine.ts`](../apps/desktop/src/main/katago/state-machine.ts) / [`ring-buffer.ts`](../apps/desktop/src/main/katago/ring-buffer.ts) | restart arithmetic, the transition table, the bounded stderr tail                         |
| [`service.ts`](../apps/desktop/src/main/katago/service.ts)                                                                                                                                               | the lifecycle owner: status, readiness probe, recovery, IPC answers                       |

The pure modules in that table are unit-tested and mutation-covered (`scripts/mutate-katago.mts`), because pure is the shape that can be proven and lifecycle is not.

**Readiness is proven, not declared.** Analysis mode has no handshake, so `engine:start` answers `ready` only after a `maxVisits: 1` probe has round-tripped through the production parser inside a deadline; a stderr banner is not a protocol. Startup is lazy — nothing runs at app launch, `engine:start` fires on the first game open, and a user who only talks to the teacher never pays for a resident engine. `backend` reports `eigen` because that is what is bundled, not a measurement, and `visitsPerSecond` is left unpopulated rather than invented — tier-2's probe-each-backend benchmark machinery is deferred, and a measured number waits for it.

**Missing is two different states, deliberately.** In a packaged build a missing binary is a packaging defect → `failed` with `ENGINE_BINARY_MISSING`; a build promising zero-config must not degrade silently. In dev the same fact means `pnpm fetch:katago` has not been run → `unavailable`, with a log line naming the command. On macOS there is no official KataGo binary to bundle, so there is no darwin entry in the manifest and `unavailable` is the honest state by construction.

**Perspective is pinned, not inherited.** KataGo's reported perspective is config-dependent, while the shared contract wants `winrate` side-to-move and `scoreLead`/ownership positive-favours-black. `config.ts` pins `reportAnalysisWinratesAs = SIDETOMOVE` with no parameter to change it, and `perspective.ts` negates scoreLead and ownership when White is to move — `winrate` is spelled out as an explicit identity there, because "no flip needed" is itself a decision someone could wrongly optimise away. Left to defaults this is a silent sign error rendering plausible wrong numbers, the exact class of bug a green suite does not catch.

### Two tiers of query

| Tier  | Trigger                               | Feeds                                                                   |
| ----- | ------------------------------------- | ----------------------------------------------------------------------- |
| Focus | `engine:setGame` / `engine:setCursor` | candidates, PV hover, ownership overlay, the current readout            |
| Sweep | `engine:setGame`, once per record     | the winrate graph, one settled point per position, filled progressively |

They run **concurrently** — KataGo time-slices threads between them — because a strict queue freezes the graph exactly when the user lingers on a position, which is the common case. Query ids are namespaced `focus:<n>` and `sweep:<move>`, and the renderer routes on the prefix. A new focus query terminates the in-flight one, and cursor streams are debounced ~50ms latest-wins, so holding an arrow key cannot queue two hundred engine queries. Sweep queries carry no ownership and only their final `complete` tick feeds the graph: an ownership tensor per move would roughly double sweep cost for pixels nobody renders.

### Crash recovery

While queries are in flight, stdout silence beyond a 30s watchdog trips terminate-all → grace → `SIGKILL`, and that exit feeds the same path as any unexpected death. That path respawns with 1s/2s/4s backoff; three crashes inside 60s exhaust the breaker and land on `failed(ENGINE_CRASHED)` — restarting forever against a broken machine burns the user's CPU. The breaker does not latch: a user-issued `engine:start` clears the window and retries. The sweep ledger lives in the service and outlives the process, so a respawned engine resumes at the first move that never completed, and the focus query for the current cursor is re-issued. The renderer takes no part in recovery beyond rendering status. On app quit the child gets terminate → grace → `SIGKILL`, plus a synchronous kill in `process.on('exit')` — a spawned engine must never outlive the app.

### How the renderer consumes it

[`analysisStore`](../apps/desktop/src/renderer/src/state/analysisStore.ts) holds the engine snapshot, the newest focus result, and the sweep map; everything the board shows is derived from those at render. It applies its own stale-result filters beside the ones main already applies — query-id prefix, and a `gameId` + cursor expectation that `gameStore` sets on every open and step — so a late tick from a since-closed game or a superseded cursor position never paints. [`gameStore`](../apps/desktop/src/renderer/src/state/gameStore.ts) drives the engine imperatively (`open` → `engine:start` + `setGame`, seek/step → `setCursor`, close → `setGame(null)`) and never waits for it: a slow or absent engine must not block opening a file.

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

Five zustand stores, split by **lifecycle** rather than by screen:

| Store                                                                      | Owns                                         |
| -------------------------------------------------------------------------- | -------------------------------------------- |
| [`gameStore`](../apps/desktop/src/renderer/src/state/gameStore.ts)         | current game, cursor, derived board position |
| [`chatStore`](../apps/desktop/src/renderer/src/state/chatStore.ts)         | messages, streaming state, active `runId`    |
| [`analysisStore`](../apps/desktop/src/renderer/src/state/analysisStore.ts) | engine status, focus result, sweep results   |
| [`settingsStore`](../apps/desktop/src/renderer/src/state/settingsStore.ts) | mirror of persisted settings                 |
| [`libraryStore`](../apps/desktop/src/renderer/src/state/libraryStore.ts)   | game list, import status                     |

zustand over Redux (too much ceremony at this size) and over Jotai (atom sprawl once imperative code reads state). The deciding factor: the canvas renderer and the IPC event handlers both need `getState()` from **outside React**, which zustand does natively.

All seven main→renderer subscriptions live in one place, [`useMainProcessEvents.ts`](../apps/desktop/src/renderer/src/hooks/useMainProcessEvents.ts), on top of a single [`useIpcEvent`](../apps/desktop/src/renderer/src/hooks/useIpcEvent.ts) primitive.

Two facts about that hook worth knowing before you change it, both established by measurement rather than argument:

- **`contextBridge` returns a stable reference** for a repeated property read, so the exposed function is safe to use in a dependency array. Asserted against the built app in `test/e2e/ipc-events.spec.ts`.
- **The built renderer is a production React bundle, so StrictMode is inert there.** Effects are never double-invoked and `App` never remounts, which means _no e2e test can reach the subscription teardown path_. Discarding `subscribe`'s return value passes the entire suite. The hook is still correct; its correctness is simply not machine-verified, and the code says so at the line.

## Errors

Every error crossing a boundary carries a domain-prefixed `code` ([`types/errors.ts`](../packages/shared/src/types/errors.ts)). No bare throws, no `Error` without a code.

The wire form is `{ code, message, context? }` — **no `cause`, no stack**. Stacks carry filesystem paths and argument values, so they stay in main. The renderer translates `code` through the `errors` i18n namespace and **never renders `message` as primary UI text**.

There is a mechanical reason this is data rather than a throw: `contextBridge` copies structurally, and a thrown `Error` arrives on the renderer side with **only `message`** — `code` and `context` are gone. So every handler returns `IpcResult<T>`, and `register.ts` maps throws into it.

**Expected absence is a state, not an exception.** A cancelled dialog returns `[]`. A missing engine reports `unavailable`. An empty library returns `games: []`. None is `ok: false`.

## Operational

- **Single-instance lock** in [`index.ts:54`](../apps/desktop/src/main/index.ts#L54). Two instances would fight over settings, the log file, the engine's CPU threads, and later SQLite.
- **`paths.ts` is the single source of truth** for userData, resources, logs, library roots, and the engine's binary, weights, and generated config paths. Scattered `path.join(app.getPath(...))` calls are how cross-platform path bugs get in.
- **Window bounds** are persisted and restored with an on-screen validity check, so a window never restores off-screen after a monitor change.
- **Logging** is `electron-log`, file plus console with rotation, wrapped to enforce `{ level, ts, scope, msg, ...fields }`. Renderer logs forward to main. A "Reveal logs" menu item ships from M1 — it is the highest-value support affordance there is. Engine stderr is chatty enough to drown everything, so it is throttled through a bounded ring buffer ([`katago/ring-buffer.ts`](../apps/desktop/src/main/katago/ring-buffer.ts)) at debug; when the process dies unexpectedly the whole tail is dumped at warn, so a `failed` status carries the engine's own last words.
- **Telemetry** is opt-in, default off, and a **no-op until consented** — no network call whatsoever before consent. When enabled: crashes only, never gameplay content, SGF, chat text, or prompts. The wiring lands in M5; [`telemetry.ts`](../apps/desktop/src/main/telemetry.ts) exists now so call sites are stable.
- **Still no SQLite** — deliberately, twice over. The library is an in-memory `Map` ([`library/store.ts:47`](../apps/desktop/src/main/library/store.ts#L47)), which keeps `better-sqlite3`'s native-rebuild variable out of an already-risky toolchain bring-up, and M2's analysis results are session-memory too: re-analysing a position is seconds on the CPU tier, which does not yet justify a native dependency. M4's batch analysis is what actually forces persistence.
- **Rollback** is reinstall: M2 still has no persistent schema. The one migration-shaped concern is settings forward-compatibility, and it is tested — unknown keys must survive a load→save cycle, so a user who runs a newer build and rolls back does not lose settings.

## Packaging

electron-builder, configured in [`electron-builder.yml`](../apps/desktop/electron-builder.yml). Windows NSIS, macOS dmg, Linux AppImage.

`electronVersion` is **pinned exactly**, and the comment in that file explains why at length. Short version: `.npmrc` sets `node-linker=hoisted`, so Electron resolves at the repository root while electron-builder looks under `apps/desktop`, and a caret range leaves it nothing to fall back on. Keep it in step with the `electron` devDependency.

KataGo binaries and weights ship **outside the asar** via `extraResources`, so the engine can be spawned as a child process and so update blockmaps stay effective at 120MB+. They are filled by `pnpm fetch:katago` / `pnpm fetch:weights` — real fetchers now, governed by [`scripts/katago-manifest.ts`](../scripts/katago-manifest.ts), the single pinned source: engine v1.18.1 (the latest KataGo release with Eigen CPU builds) and the kata1-b6c96 net, CC0, 5.0MB — benchmark-swapped down from the originally recommended b10c128, whose 500-visit reads measured at ~8s on the reference CPU against b6c96's ~3.4s (the recorded stronger-but-slower alternative stays in the manifest). Three facts about that pipeline are worth knowing before touching it:

- **Checksums are trust-on-first-use, and the sidecar is committed.** Neither KataGo releases nor katagotraining.org publish hashes, so the first completed download records the observed sha256 into [`scripts/katago-checksums.json`](../scripts/katago-checksums.json) and every fetch after that verifies against it — a truncated or substituted payload fails loudly instead of shipping.
- **The engine directory is per-platform, and so is the `extraResources` entry.** `win.extraResources` copies `resources/katago/win32-x64/` and `linux.extraResources` copies `linux-x64/`; knowledge and weights are platform-independent and ride in the top-level block. There is deliberately no engine entry under `mac` (no macOS binaries are published), and copying every platform into every installer would triple the tier silently. The fetch cache (`*.zip`, `*.partial`) is excluded by filter — the archive alone roughly doubles the tier, and an interrupted partial is resume state, not payload.
- **Two extraction quirks are load-bearing.** The Windows build dynamically links the MSVC runtime, so the fetcher flattens the archive — engine and DLLs side by side, no installer prerequisite. The official Linux build is an AppImage _inside_ the release zip, so it is extracted twice (zip, then `--appimage-extract`) down to a plain ELF — a nested AppImage has no FUSE in the packaged context and would not run.

[`NOTICE`](../NOTICE) names both bundled payloads, and [`katago-provenance.test.ts`](../scripts/test/katago-provenance.test.ts) anchors that assertion to the manifest: they are not npm packages, so `check:licenses` never sees them, and the largest binaries in the installer would otherwise be the only shipped code with no provenance record. The same test probes every manifest URL live (`Range: 0-0`, skipped offline) — no URL ships on inference.

## Testing

The technique per layer is chosen against a specific failure mode, not by habit.

| Layer                  | Technique                                                                     | Why this one                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| SGF round-trip         | Fixture corpus of real-world files                                            | Real malformation is not something you invent; it has to come from actual files                                             |
| Coordinates            | Property-based (`fast-check`)                                                 | The bug space is all points × all sizes; examples miss the `I`-skip                                                         |
| Board rules            | Hand-built positions                                                          | Capture, suicide, ko, multi-group capture are specific known-hard cases                                                     |
| LLM provider           | Real HTTP server (`node:http`)                                                | Must assert chunk _assembly order_ and mid-stream abort, which a mocked SDK object cannot exercise                          |
| IPC schemas            | Table-driven + meta-test                                                      | The meta-test is what stops an untested channel being added later                                                           |
| KataGo process         | **Real spawned child** speaking GTP and the analysis protocol                 | Exercises actual pipes, framing, and exit handling. Mocks would test the mock                                               |
| Engine lifecycle       | The same fake with fault flags (`--crash-after`, `--hang-on`, `--garbage-on`) | Recovery is only real against a child that can die, hang, or emit garbage on cue                                            |
| Engine decision cores  | Unit + mutation harness (`scripts/mutate-katago.mts`)                         | Coalescer, sweep ledger, backoff, state machine, perspective flip — the sign-and-bound class a green suite otherwise misses |
| Live analysis pipeline | e2e against `out/` with the fake selected via `GOMENTOR_KATAGO_BINARY`        | The whole pipe — spawn, probe, query, render — with no real engine, which a CI runner cannot have                           |
| Handlers               | Stubbed `ipcMain`, invoke each channel, validate against schema               | Catches handler/schema drift without a UI                                                                                   |
| Settings               | Write → restart-simulate → read, plus unknown-key survival                    | Forward-compat is a correctness property                                                                                    |
| App shell              | Playwright `_electron` against `out/` + a manual checklist                    | Some of it — visual board correctness, key absence from logs — is genuinely human-verified                                  |

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

Since M2 the matrix also fetches the KataGo engine and net, cached under a key derived from the manifest's own hash — content-addressed, so bumping the pinned version invalidates the cache while an unrelated commit reuses it. macOS's fetch is a documented no-op (no asset exists) that exits 0; on Windows and Linux a failed fetch stops the job, because a zero exit must mean "present and verified", never "silently skipped".

## Coexistence with Trellis

Six paths are off-limits to app code, build scripts, and CI: `.trellis/`, `.claude/`, `.codex/`, `.qoder/`, `.agents/`, `AGENTS.md`. Nothing in `apps/`, `packages/`, `scripts/`, or `.github/` may read from or write to them.

Enforced at three layers, because one layer is one point of failure:

1. **Graph exclusion** — `tsconfig.base.json` `exclude` and `eslint.config.js` `ignores` list all six, so a stray file can never enter a compile or a lint pass.
2. **CI guard** — after a full install/build/package, `git diff --exit-code` over all six must be clean. `pnpm check:trellis` runs it locally. If a build step ever mutates workflow state, CI fails loudly instead of corrupting it silently.
3. **Convention** — `AGENTS.md` edits go strictly after the `TRELLIS:END` marker; app `.gitattributes` rules append below the existing Trellis block.

This document links to no file under those paths, deliberately: `docs/` has to stand on its own for a reader who does not have them.

## Licence

GPL-3.0. Any derivation from lizzieyzy-next makes it mandatory, and relicensing later would need every contributor's consent. See [`adr/0001-license.md`](./adr/0001-license.md).
