# Design: GoMentor Desktop Skeleton (M1)

Technical design for M1. Requirement IDs (R1–R11) and decision IDs (D1–D9) reference `prd.md`.

## Architecture and boundaries

### Process model (R3)

```
┌─────────────────────────────────────────────────────────────┐
│ MAIN  — sole OS authority                                   │
│                                                             │
│  lifecycle · window · menu · paths · logger · settings      │
│  safe-storage · ipc/register (zod gate)                     │
│  llm/service ──────► openai SDK ──► cloud API | local 4090  │
│  library (in-memory M1) · sgf handlers                      │
│                                                             │
│  M2+: katago/process · db (sqlite) · llm/agent-loop         │
└───────────────▲──────────────────────────┬──────────────────┘
                │ invoke (request/response)│ send (typed events)
┌───────────────┴──────────────────────────▼──────────────────┐
│ PRELOAD — thin, frozen, no business logic                   │
│  contextBridge.exposeInMainWorld('gomentor', api)           │
│  contextIsolation: true · nodeIntegration: false            │
│  sandbox: true · no ipcRenderer leak to page                │
└───────────────▲──────────────────────────┬──────────────────┘
                │                          │
┌───────────────┴──────────────────────────▼──────────────────┐
│ RENDERER — React 19, presentation only, no Node APIs        │
│  App (three-panel shell)                                    │
│  GameList │ Board + MoveTree + EngineStatus │ TeacherChat   │
│  zustand: game · chat · settings · library                  │
└─────────────────────────────────────────────────────────────┘
```

**Why the agent loop belongs in main (D9)** — deferred to M3, but the boundary is set now: tools need DB/engine/filesystem access, and a renderer reload must not orphan an in-flight multi-step run. Putting it in the renderer would make every tool a round-trip and make cancellation semantics ambiguous.

**Streaming direction rule**: renderer→main is *always* `invoke`. Main→renderer uses `webContents.send` on typed event channels for high-frequency data. M1 streams LLM token deltas. M2 adds KataGo analysis ticks, **coalesced in main to ~20/s** before sending — engines emit far faster than a UI can usefully paint, and flooding IPC is a known Electron performance cliff.

### Workspace boundaries (R1, D3)

| Package | May depend on | Must never depend on |
|---|---|---|
| `@gomentor/shared` | `zod` only | anything else in the workspace |
| `@gomentor/core` | `shared`, `zod`, `openai` | `electron`, Node-only APIs beyond `node:*` primitives |
| `apps/desktop` | `shared`, `core`, `electron`, Node | — |
| `apps/web` | `shared`, `core` | `electron` |

`packages/core` staying Electron-free is what makes it unit-testable without spawning Electron and reusable by the website's interactive demos. Enforced by an ESLint `no-restricted-imports` rule in `packages/core`.

### Trellis coexistence (R2)

The six protected paths — `.trellis/`, `.claude/`, `.codex/`, `.qoder/`, `.agents/`, `AGENTS.md` — are enforced at three layers, because a single layer is a single point of failure:

1. **Build/lint graph exclusion**: `tsconfig.base.json` `exclude` and `eslint.config.js` `ignores` both list all six. A stray `.py` or `.md` can never enter a compile or lint pass.
2. **CI guard**: after a full `pnpm install && pnpm build && pnpm package`, assert `git diff --exit-code` is clean for all six paths. If any build step ever mutates Trellis state, CI fails loudly rather than corrupting workflow state silently.
3. **Convention, documented in spec**: `AGENTS.md` edits go strictly *after* `<!-- TRELLIS:END -->`; app `.gitattributes` rules append *below* the existing Trellis `merge=union` block.

## Data flow and contracts

### IPC contract shape (R4)

`packages/shared/src/ipc.ts` exports one const map. Channels are `domain:verb`. Each carries a zod request and response schema:

```
CHANNELS = {
  'sgf:parse':          { request, response }
  'sgf:serialize':      { request, response }
  'sgf:openDialog':     { request, response }
  'library:list':       { request, response }
  'library:import':     { request, response }
  'llm:sendMessage':    { request, response }   // returns { runId }; tokens arrive on events
  'llm:cancel':         { request, response }
  'settings:get':       { request, response }
  'settings:set':       { request, response }
  'settings:setSecret': { request, response }
  'settings:hasSecret': { request, response }
}

EVENTS = {
  'llm:delta' | 'llm:toolCall' | 'llm:done' | 'llm:error'
  'library:changed'
  // M2: 'katago:analysis' | 'katago:status'   M5: 'update:status'
}
```

**Enforcement mechanism**: `ipc/register.ts` exposes a single `handle(channel, handler)` helper that parses the request against the channel's schema before invoking the handler, maps thrown errors to a typed error envelope, and — **in dev builds only** — also parses the response. Fail loud in dev, fast in prod. A `no-restricted-syntax` ESLint rule forbids raw channel string literals outside `ipc.ts`, so drift is caught at lint time rather than runtime.

`llm:sendMessage` returning a `runId` rather than the reply is deliberate: the reply is a stream, and modelling it as a request/response would either block or require chunked invoke hacks. The renderer correlates `llm:delta` events by `runId`.

### SGF pipeline (R5)

```
SGF bytes ──parser──► GameTree AST (values kept raw)
                        │
     ┌──────────────────┼──────────────────┐
     ▼                  ▼                  ▼
board/position    library store      (M2: DB rows)
(replay to move N) (metadata)
     │
     ▼
serializer ──► SGF text/bytes (escaping + unknown props intact)
```

Why hand-written rather than wrapping `@sabaki/sgf` — amended in Stage 3, see the PRD library table for the full reasoning. In short: A5 requires unknown properties to round-trip **byte-for-byte**, which means owning escape handling, because a library that decodes `\]` to `]` on read has lost the bytes needed to write it back. Values are therefore stored raw in the AST and decoded opt-in per property by the typed accessors in `props.ts`.

Stable node identity was the original reason to wrap, and it is unchanged: the parser assigns monotonic ids and parent/child links once, at parse time.

**Unknown-property preservation is a hard contract** (A5). SGF files in the wild carry editor-specific and engine-specific properties; silently dropping them means a user's file degrades every time it passes through GoMentor. The AST stores unrecognised properties verbatim in a passthrough bag and the serializer re-emits them.

Failure modes are typed, never thrown-string and never hanging (A6): truncated, empty, and non-SGF-binary input each produce a distinct typed error. A parser that hangs on malformed input would freeze the import flow with no recovery path.

### Board rendering (R6)

Two stacked canvases, both sized to `devicePixelRatio`:

| Layer | Contents | Redraw trigger |
|---|---|---|
| Static | wood texture, grid, star points, coordinate labels | resize only |
| Dynamic | stones, last-move marker, (M2: heatmap, ownership, candidates) | state change |

Splitting the layers is what makes M2's per-frame overlay updates affordable — the expensive static content is painted once per resize, not once per analysis tick.

**Coordinate systems** — internal `[x, y]` zero-indexed from top-left is canonical. Pure converters live in `board/coords.ts`:

```
internal [x,y] ◄──► SGF letters ("dp")
               ◄──► GTP labels ("D4", skipping I)
               ◄──► pixel space (DPR-aware)
```

Every historical Go software bug lives in these conversions — the GTP `I`-skip especially. Hence property-based testing (A7) rather than example-based: assert round-trip identity across *all* board sizes and all points, not a handful of hand-picked cases.

Animations get a ≤120ms budget via `requestAnimationFrame`, cancellable and skippable. Skippability is both an accessibility requirement and a practical one: holding the arrow key to scan a game must not queue 200 animations.

### LLM provider (R7, D5)

```
              ┌──────────────────────────┐
              │ LLMProvider (interface)  │
              │  chat(req, signal)       │  AsyncIterable<ChatChunk>
              │  listModels()            │
              │  health()                │
              │  capabilities            │
              └────────────▲─────────────┘
                           │
              ┌────────────┴─────────────┐
              │ OpenAICompatibleProvider │  ← the only implementation
              └────────────▲─────────────┘
                    ┌──────┴──────┐
              cloud.ts        local.ts     ← thin factories
              baseUrl: api     baseUrl: http://<4090>:port
              apiKey: req      apiKey: optional
              timeout: short   timeout: long
              retries: 2       retries: 0
```

Async-iterator `chat()` rather than callbacks or an EventEmitter: streaming becomes a `for await` loop and cancellation is just breaking out of it, with `AbortSignal` propagating to the underlying fetch. This is materially simpler to reason about than callback-based cancellation.

Local gets **zero retries and a long timeout**; cloud gets **2 retries and a short timeout**. A local 4090 loading a large model can legitimately take a minute on first token, and retrying against it just multiplies GPU load. A cloud API failing fast is usually transient and worth retrying.

**`probeCapabilities` on first connect** attempts a trivial tool call and records whether tools actually work. Tool-calling support in Ollama/LM Studio varies *by model*, not just by server, so the capability cannot be inferred from configuration. Recording it lets M3's agent loop degrade to a no-tools prompt strategy instead of failing at the first tool dispatch.

### Settings and secrets (R8)

```
settings.json  { …zod-validated config…, llm: { …, hasSecret: true }, secretBlob: "<opaque>" }
                                                        ▲
                                          safeStorage.encryptString (OS keychain)
```

The `hasSecret` boolean is plaintext and *is* sent to the renderer (the UI must show whether a key is configured). The key itself never leaves main, never enters the renderer, and is redacted by a logger serializer keyed on field name and on any value matching key-shaped patterns.

If `safeStorage.isEncryptionAvailable()` returns false — real on some Linux desktop configurations — **refuse to persist** and hold the key in memory for the session, with an explicit UI warning. Writing plaintext as a fallback would be a silent security downgrade the user never agreed to.

### State management (R9)

Four zustand stores, deliberately split by lifecycle rather than by screen:

| Store | Owns |
|---|---|
| `gameStore` | current game, cursor position, derived board position |
| `chatStore` | message list, streaming state, active `runId` |
| `settingsStore` | mirror of persisted settings |
| `libraryStore` | game list, import status |

zustand over Redux (too much ceremony here) and over Jotai (atom sprawl once imperative code reads state): the canvas renderer and the IPC event handlers both need `getState()` from *outside* React, which zustand does natively.

## Compatibility and migration notes

- **Settings forward-compatibility**: unknown keys must survive a load→save cycle (tested). A user who runs a newer build, then rolls back, must not lose their newer settings.
- **SGF forward-compatibility**: unknown properties preserved (A5), same reasoning applied to user data.
- **Engine status as an enum, not an exception** (R9): `unavailable | downloading | starting | ready | failed`. M1 ships permanently `unavailable`. Modelling absence as a state rather than an error is what lets M2 add the engine without touching UI control flow, and what keeps the app usable when KataGo fails.
- **`packages/core/src/katago/{gtp,analysis}.ts` are written in M1** as pure, transport-agnostic encoders/decoders with no process management. M2 adds `main/katago/process.ts` around them. Designing the pure layer first means M2's risk is confined to process lifecycle, not protocol correctness.
- **No SQLite in M1** (deliberate): the library store is in-memory. This removes `better-sqlite3`'s native-rebuild variable from M1's already-risky toolchain bring-up. M2 introduces it when there is analysis data worth persisting.

## Important trade-offs

| Choice | Rejected alternative | Why |
|---|---|---|
| Custom Canvas 2D board | WGo.js / shudan | Our heatmap/ownership overlays with 361-point per-frame updates are exactly where a generic library forces a fight |
| Canvas 2D | SVG | 361 DOM nodes with per-frame overlay updates is where SVG collapses |
| Canvas 2D | WebGL | Unnecessary here, and it costs GPU context that KataGo wants |
| Analysis mode primary (D8) | GTP primary | One response carries winrate + score lead + ownership + PV, with concurrent id correlation; GTP's lockstep model fights that |
| Agent loop in main (D9) | Agent loop in renderer | Tools need OS access; renderer reload must not orphan a run |
| BM25 + Zobrist pattern index (M3) | Vector search | Embeddings mean +100MB and a second inference path for marginal gain on a few-thousand-entry curated corpus; BM25 is debuggable, and "what joseki is this corner" is a *deterministic pattern match*, not text search |
| EMA weakness scoring (M4) | Plain average | A plain average makes the profile feel dead — it must visibly change as the student improves |
| Heuristics assign categories, LLM only explains (M4) | LLM assigns categories | Non-determinism in the profile would destroy trust in the training plan |
| Tiered installer (D6) | Single 500MB bundle | Core stays analysis-capable offline, so zero-config holds literally, while median download drops ~70% and auto-update blockmaps stay small |
| GPL-3.0 (D4) | MIT | Any derivation from lizzieyzy-next makes GPL mandatory, and later relicensing needs every contributor's consent |

## Operational considerations

- **Logging**: `electron-log`, file + console with rotation, wrapped to enforce `{ level, ts, scope, msg, ...fields }` and to redact secrets. Renderer logs forward to main over IPC. A "Reveal logs" menu item is the single highest-value support affordance — ship it in M1.
- **Telemetry**: opt-in, default off, **no-op until consented** (no network call whatsoever before consent). When enabled: crashes only. Never gameplay content, SGF, chat text, or prompts — this tool handles a user's private study material and their LLM keys, so content telemetry is permanently off the table. Wiring lands in M5; the no-op module exists in M1 so call sites are stable.
- **Single-instance lock**: enforced in `main/index.ts`. Two instances would fight over settings, the log file, and (in M2) SQLite and the GPU.
- **Window bounds persistence**: saved and restored, with an on-screen validity check so a window never restores off-screen after a monitor change.
- **`paths.ts` as the single source of truth** for userData, resources, logs, and library roots. Scattered `path.join(app.getPath(...))` calls are how cross-platform path bugs enter, and this is the file that makes the Windows-first / cross-platform-clean stance (`prd.md` §Environment) actually hold.
- **Rollback**: M1 has no persistent schema, so rollback is reinstall. The forward-compat settings test is the only migration-shaped concern.

## Verification design

Test strategy per layer, with rationale for the choice of technique. Full criteria in `prd.md` §Acceptance criteria.

| Layer | Technique | Why this technique |
|---|---|---|
| SGF round-trip (A5, A6) | Fixture corpus, ≥20 real-world files | Real-world malformation is not something you invent in unit tests — it has to come from actual files |
| Coordinates (A7) | Property-based (`fast-check`) | The bug space is all points × all board sizes; examples miss the `I`-skip and edge cases |
| Board rules | Hand-built positions | Capture resolution, suicide, ko, and multi-group capture are specific known-hard cases |
| LLM provider (A8) | Mock HTTP server (`msw` or bare `node:http`) | Must assert chunk *assembly order* and mid-stream abort, which a mocked SDK object cannot exercise |
| IPC schemas (A9) | Table-driven + **meta-test** | The meta-test asserting every channel has coverage is what prevents an untested channel being added later |
| KataGo process | **Real spawned child process** speaking GTP (`test/integration/fake-katago.ts`) | Exercises actual pipes, framing, and exit handling — mocks would test the mock. GTP chosen over analysis mode here precisely because it is trivial to fake |
| Handlers | Stubbed `ipcMain`, invoke each channel, validate response against schema | Catches handler/schema drift without a UI |
| Settings | Write → restart-simulate → read, plus unknown-key survival | Forward-compat is a correctness property, not a nicety |
| App shell (A1–A4, A10–A13) | Manual smoke checklist + Playwright `_electron` | Some of this (visual board correctness, key absence from logs) is genuinely human-verified |

**CI gates beyond the test suite** (R11): lockfile drift, dependency-license compatibility with GPL-3.0 (D4), i18n key completeness against `en`, and the R2 Trellis-immutability guard. The license gate exists because a single incompatible transitive dependency is a legal problem discovered most cheaply at commit time.

e2e is allowed to be **non-blocking for the first two weeks**, then required — Playwright-on-Electron is flaky to stabilise and should not block M1 landing, but it must not stay optional either.

## Delivery verification: two-agent model (D10)

Trellis ships `trellis-check` (`.claude/agents/trellis-check.md`), which reads the git diff, checks code against `prd.md`/`design.md`/`.trellis/spec/`, **self-fixes** issues, and runs typecheck + lint. That covers convention conformance well, but it leaves two real gaps:

1. **It verifies conformance, not function.** It runs typecheck and lint — not the test suite, not the app, not the acceptance criteria. The R2 Trellis-immutability guard, A10's "key absent from logs", and A3's board-rendering correctness are outside its loop entirely.
2. **It self-fixes, so finding and judging are the same agent.** That is efficient but gives no independent review. For the failure modes that are *wrong but look right* — SGF unknown-property preservation, the GTP `I`-skip, the preload sandbox boundary, the `safeStorage` unavailable path — a self-graded fix is exactly the wrong shape.

**Decision (D10): add a read-only verification agent at every stage gate, alongside `trellis-check`.** Division of labour:

| | `trellis-check` (built-in) | `gomentor-verify` (added) |
|---|---|---|
| Question answered | "Does this code follow our conventions and design?" | "Does this actually work, per the acceptance criteria?" |
| Reads | git diff, prd/design/implement, `.trellis/spec/` | prd acceptance table, test output, running app |
| Runs | typecheck, lint | **full test suite**, R2 guard, license/i18n gates, targeted smoke |
| **May edit code** | **Yes — self-fixes** | **No — read-only by construction** |
| Output | list of fixes applied | **PASS / FAIL verdict per acceptance ID, with evidence** |

**Why read-only is the load-bearing property.** An agent that can fix what it finds will rationalise its own fix as correct — that is the same conflation D10 exists to break. Denying it Write/Edit forces every finding to surface as a verdict the main session must act on, so a failure cannot be quietly absorbed. Tools: `Read, Bash, Glob, Grep` — no `Write`, no `Edit`.

**Verdict discipline.** The agent must report per-acceptance-ID `PASS | FAIL | NOT-APPLICABLE-YET` with the command output or file:line that justifies it. Two rules exist because they are the common ways this kind of gate becomes theatre:

- **A criterion it could not test is `NOT-APPLICABLE-YET`, never `PASS`.** Silence must not read as success.
- **"Tests pass" is not evidence a criterion is met.** A5 requires the ≥20-file corpus to *exist and be real*; a green run against 3 synthetic fixtures is a FAIL on A5 with a note, not a PASS.

**Ordering at each gate**: implement → `trellis-check` (fix conventions) → `gomentor-verify` (judge function) → main session acts on FAILs. Verify runs last so it judges the post-fix state. A FAIL blocks the stage; the main session either dispatches more implementation or, if the criterion itself is wrong, amends `prd.md` — explicitly and visibly, never by lowering the bar inside the verifier.

**Stage-scoped criteria.** Each stage gate checks only the acceptance IDs its stage can satisfy (see `implement.md`); the full A1–A15 sweep runs at the final gate. This keeps early gates fast and stops a verifier from failing a stage for something not yet built.
