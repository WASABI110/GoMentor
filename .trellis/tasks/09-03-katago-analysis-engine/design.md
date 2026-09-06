# Design: KataGo Analysis Engine (M2)

Technical design for M2. Requirement IDs (E1–E5) and acceptance IDs (B1–B9) reference `prd.md`. Decisions D1–D10 and ADR 0003 are M1's and bind this design.

Scope settled in `prd.md` §Scope decisions: **core tier only** (bundled Eigen + one small net), no tier-2 download flow, no SQLite, no play-vs-engine, no full-offline asset. Move tree scope is PV preview + read-only branch navigation.

## Architecture and boundaries

### New main-process module: `main/katago/`

```
apps/desktop/src/main/katago/
├── locate.ts     binary/weights path resolution, existence checks (pure-ish, injectable fs)
├── config.ts     generates the KataGo analysis config into userData (pure string builder)
├── process.ts    child lifecycle: spawn, stdio plumbing, exit detection, shutdown
├── session.ts    analysis-mode protocol on a live process: query ids, in-flight map, terminate
├── sweep.ts      whole-game background sweep ledger (pure, unit-testable)
├── coalesce.ts   per-query latest-wins tick coalescer, ~20/s ceiling (pure)
└── service.ts    the engine service: owns the above, drives EngineStatus, answers IPC
```

The layering rule from M1 holds and is the point of the split: `packages/core/src/katago/{gtp,analysis}.ts` stay pure protocol; everything in `main/katago/` is lifecycle. The only new pure logic M2 adds (sweep ledger, coalescer, config builder, manifest verification) is written **transport-free and unit-testable**, with mutation coverage, because that is the exact shape that let four green gates ship an app that could not boot in M1.

### Where the engine binary lives

`paths.ts` stays the single source of truth; it gains the engine roots:

| Context | Root |
|---|---|
| Packaged | `process.resourcesPath/katago/<platform>-<arch>/` + `process.resourcesPath/weights/` |
| Dev | `apps/desktop/resources/katago/<platform>-<arch>/` + `.../weights/` |
| Override | `GOMENTOR_KATAGO_BINARY` env var (e2e against the fake, support diagnostics) |

Per-platform subdirectories exist because `extraResources` copies a directory wholesale. `electron-builder.yml` gains **per-platform** `extraResources` entries (`win.extraResources` / `linux.extraResources` — the win+linux macOS block from M1 stays unchanged) selecting only the matching subdirectory — without this, every installer ships two platforms' binaries and the tier silently doubles. The fetch scripts default to the current platform; `--all` exists for the (deferred) full-offline asset.

**Windows runtime dependency** (research `bundled-binary-packaging.md`): the KataGo Eigen build needs the VC++ runtime (undocumented upstream; KaTrain ships `msvcp140`/`vcruntime140` DLLs next to the binary). The fetch manifest therefore lists those DLLs as additional files for the `win32-x64` target and they sit in the same per-platform directory — no installer step, no registry dependency.

### Engine lifecycle and status transitions

```
            engine:start (first game open)
                  │
            unavailable ──► starting ──► ready
                              │             │ crash / hang
                              ▼             ▼
                           failed ◄── restarting (bounded backoff, ≤3 attempts/60s)
                              ▲             │
                              └─────────────┘ exhausted → failed(ENGINE_CRASHED)
```

- **Startup is lazy**: `engine:start` fires when the first game opens, not at app launch. A user who only chats with the teacher never pays for a several-hundred-MB resident engine process. The badge shows `starting` honestly in the gap.
- **Handshake**: analysis mode has no version handshake, so readiness is *proven*, not declared: a trivial `maxVisits: 1` probe on an empty board must return a well-formed response within a deadline. The version string is read best-effort from the stderr banner for `EngineInfo.version`. The `list_commands`-before-`kata-*` check from `gtp.ts` is for the GTP path, which M2 ships only for the test fakes (play-vs-engine deferred).
- **Missing binary is two different states, deliberately**: in a **packaged** build a missing binary is a packaging defect → `failed` with `ENGINE_BINARY_MISSING` (a build promising zero-config must not degrade silently — that is the lesson of the M1 extraResources READMEs); in **dev** it means `pnpm fetch:katago` has not been run → `unavailable`, with a log line saying exactly that. On macOS (engine tier deferred, `prd.md` scope decision 6) there is no engine asset to be missing, and the state is `unavailable` by construction — identical to M1.
- **Hang detection**: while any query is in flight, silence on stdout beyond the watchdog deadline → terminate-all, grace period, then `SIGKILL` and the crash path. The fake's `--hang-on` flag exists to test this.
- **Crash recovery**: on unexpected exit, status → `starting` and the process is respawned with backoff (1s, 2s, 4s; ≥3 attempts inside 60s → `failed(ENGINE_CRASHED)`, user-retrievable via `engine:start`). The sweep ledger survives in memory, so a restarted engine resumes the sweep at the first move it never completed; the focus query is re-issued for the current cursor. The renderer never takes part in recovery beyond rendering status.
- **Shutdown**: app quit terminates the session (in-flight `terminate`s), closes stdin, waits briefly, then `SIGKILL`. A spawned child must never outlive the app.

### Perspective and config are pinned, not inherited

`packages/shared` declares `MoveInfo.winrate` as side-to-move perspective and `scoreLead` as positive-favours-black, while KataGo's analysis output perspective is config-dependent (`reportAnalysisWinratesAs`). Left to defaults this is exactly the kind of silent sign error that four green gates would miss. `config.ts` therefore **pins `reportAnalysisWinratesAs` explicitly** and the score-lead normalisation (flip when white to move, if the pinned mode requires it) lives in one place in the session adapter with a test against a recorded real-engine transcript. The ownership array's sign convention and row-major ordering must be verified against KataGo's AnalysisEngine docs and a real-engine probe **during Stage 3** — recorded here because it is a fact to check, not a thing to assume.

## Data flow and contracts

### IPC additions (`packages/shared/src/ipc.ts`)

New channels (3):

```ts
'engine:info':   { request: empty, response: engineInfoSchema }      // snapshot for fresh mounts
'engine:start':  { request: empty, response: engineInfoSchema }      // idempotent
'engine:setGame': {
  request: z.object({
    // null closes analysis: queries terminated, sweep cleared, engine stays warm
    game: z.object({
      gameId: z.string(),           // correlates results; library id or content hash
      boardSize, komi, rules,       // from Game.meta; rules defaults 'chinese'
      setup: gameSetupSchema,       // handicap/problem stones — see below
      moves: z.array({ player, coord: coordSchema.nullable() }),   // full record
    }).nullable(),
    atMove: z.number().int().min(0),  // focus position; ignored when game is null
  }),
  response: z.object({ focusQueryId: z.string().nullable() }),
}
'engine:setCursor': {                                                 // arrow-key stream
  request: z.object({ moveNumber: z.number().int().min(0) }),
  response: z.object({ focusQueryId: z.string() }),
}
```

New event (1):

```ts
'engine:analysis': analysisResultSchema    // coalesced ≤20/s per query
```

`engine:status` is unchanged. The `AnalysisResult` schema already carries everything the UI needs (`queryId`, `gameId`, `moveNumber`, `winrate`, `scoreLead`, `candidates[].pv`, `ownership`, `complete`) — M1 designed it so.

Why the request carries the record rather than referencing the library: `engine` must not import `library/store.ts`. Self-contained requests keep the engine service free of library lifecycle (import/delete/watch) and make the e2e fake trivially drivable. A 300-move record is ~2KB — the resend cost on `setGame` is noise, and cursor steps resend nothing (`setCursor` carries one integer).

**Query-id namespacing is the routing contract**: focus queries are `focus:<n>`, sweep queries `sweep:<moveNumber>`. The renderer routes `engine:analysis` payloads by prefix without a schema change; `gameId` filters results from a since-closed game. This is a convention, not a type — stated here because it is the one place the two result streams are distinguished.

### Two-tier analysis

| Tier | Trigger | Query shape | Feeds |
|---|---|---|---|
| **Focus** | `setGame` / `setCursor` | current position, `includeOwnership`, `reportDuringSearchEvery`, capped visits | candidates, PV hover, ownership overlay, current winrate/scoreLead |
| **Sweep** | `setGame` | every position in order, fixed low visits, no ownership, `complete` only | the winrate graph, filled progressively |

Both run as concurrent analysis-mode queries; KataGo time-slices threads between them (verified behaviour of the analysis engine — the alternative, a strict queue, means the graph freezes whenever the user lingers on a position, which is the common case). Focus termination on cursor move is `encodeTerminateRequest`, already in `analysis.ts`. Cursor streams are debounced ~50ms latest-wins in main, so holding an arrow key cannot queue 200 engine queries.

The sweep ledger (`sweep.ts`) is pure: in goes (moves, per-move completion set, engine restarts), out comes the next move to query. It survives engine restarts; it does not survive `setGame`.

### Renderer

New `analysisStore` (zustand), following the M1 store rules (inputs in stores, derivation in core):

| State | Writer |
|---|---|
| `status: EngineInfo` | `engine:status` event |
| `focus: AnalysisResult \| null` | `engine:analysis` where queryId starts `focus:` |
| `sweep: Map<moveNumber, {winrate, scoreLead}>` | `engine:analysis` where `sweep:` and `complete` |
| `showOwnership: boolean`, `hoveredCandidate: number \| null` | UI local |

`useMainProcessEvents` gains the two subscriptions — its own comment already names `engine:status` as the sixth event with "no store to write to yet". The `EngineStatus` badge is refactored to read the store instead of local state (its M1 comment says this store arrives in M2). **gameStore drives the engine imperatively**: `open()` success → `engine:start` + `setGame`; `seek`/step actions → `setCursor`; `close()` → `setGame(null)`. This matches M1's pattern of stores calling the bridge directly.

### Board overlays (dynamic canvas + `BoardOverlay`)

M1's two-layer canvas split was made for exactly this:

- **Candidates**: top-N (≤5) markers on the dynamic canvas, lettered A–E in rank order, alpha ∝ winrate mass; the hovered candidate shows its **PV as numbered ghost stones**. PV colour parity starts from the side to move — a ghost sequence starting on the wrong colour is a fabricated continuation (the parser's PV-truncation rule exists for the same reason).
- **Ownership**: toggle (toolbar button); per-point alpha fill on the dynamic canvas, black/white by sign, from `focus.ownership`. Board-size aware via the same `size²` row-major contract `parseOwnership` validates.
- **Winrate graph**: new component under the move controls in the board panel: sweep winrate-by-move rendered as it fills, unanalysed region visibly pending (not zero — a 50% flatline reads as a real even game), current-move marker, click-to-`seek`. SVG, not canvas: ≤361 nodes at sweep tick rates (~1/s) is far from the per-frame load that ruled SVG out for the board.

### Branch navigation (read-only)

The renderer's `Game` is a mainline *projection*; variations live in the AST in main. To keep M1's "exactly one way a `Game` comes into existence" invariant, branch navigation extends the existing parse path rather than adding a second:

- `sgf:parse` request gains optional `variationPath: number[]` (child index at each branch point). Response `gameSchema` gains `branches`: for each mainline move index with alternatives, the option list (first move, move count, optional comment label). This is the R12-amendment precedent (`setup` was added the same way in M1 Stage 6).
- MoveTree renders a branch picker at moves where `branches` is non-empty; choosing one re-parses with an updated `variationPath`. `gameStore` now retains the source SGF string privately to re-parse — it already flows through `open(content)`.
- Not in scope: creating variations, editing, writing back (deferred per scope decision 3).

## Build-time fetch (E1)

`scripts/katago-manifest.ts` is the single pinned source: `{ version, assets: { 'win32-x64' | 'linux-x64': { url, sha256, size, files } }, weights: { name, url, sha256, size } }`, plus license identifiers. **Values come from `research/katago-releases.md` / `research/katago-networks.md`, never from memory.**

- **Pinned engine version: v1.18.1** — the latest release with Eigen builds (v1.18.2 is CUDA-only; verified via GitHub API at planning time, 2026-09-03). Only `win32-x64` and `linux-x64` targets exist: no macOS binaries are published in any release (scope decision 6), so the manifest has no darwin target and `locate.ts` reports `unavailable` there by construction.
- **No checksums are published upstream** for the engine or the nets. The manifest's `sha256` fields are therefore **TOFU**: empty until the first verified download from an unrestricted network records them; once recorded, every subsequent fetch verifies against them, and CI fails on mismatch (the check itself is the point — a truncated or substituted binary must fail loudly, per the M1 stub's contract).
- **Weights: b10c128** is the bundled core-tier net (13.79 MiB `.txt.gz`, CC0, stable URL since 2020-11-28); b6c96 is the recorded fallback if the Stage-2 benchmark shows b10 is too slow on the reference CPU (`research/katago-networks.md`).
- **Windows extras**: `msvcp140`/`vcruntime140` DLLs ship in the same per-platform directory (see §Where the engine binary lives).

- `fetch-katago.ts` / `fetch-weights.ts`: download to `*.partial`, resume via HTTP `Range`, verify sha256 before rename into place (a truncated binary must fail the existence check, per the stub's own doc comment), extract, `chmod 755` on POSIX. Current platform by default; `--all` for CI/full-asset use. **The Linux official build is an AppImage** (`research/bundled-binary-packaging.md`): self-contained, so fetch extracts it (never nests an AppImage inside an AppImage) and asserts the extraction actually produced an executable — `libzip`/`Error 127` failures are a Stage-1 test target.
- **NOTICE and the license gate extend to binary payloads**: npm packages are covered by `check:licenses`; the engine and net are not npm packages. The manifest carries license fields and a test asserts `NOTICE` names both payloads — otherwise the D4 provenance rule has a hole exactly where the biggest binary enters.
- CI: the package job runs `pnpm fetch:katago && pnpm fetch:weights` before `pnpm package`, behind `actions/cache` keyed by the manifest hash (100MB+ per matrix run otherwise).

## Compatibility and migration notes

- `AnalysisResult`/`EngineInfo`/`MoveInfo` schemas are M1-frozen and sufficient — no breaking contract change; additions are `sgf:parse.variationPath` (optional in) and `gameSchema.branches` (`.prefault([])` so old callers are unaffected, per the zod-v4 `.prefault` lesson in M1).
- Settings gain `engine.autoStart` (`prefault(true)`)? **No** — no settings surface is added in M2; lazy-start behaviour is fixed. Recorded because it is the kind of flag that sneaks in without a decision.
- The i18n gate's allowlist already pins the four backend display names; all new UI strings go into the existing `analysis.json` / `errors.json` namespaces in both locales. New error codes: `ENGINE_BINARY_MISSING`, `ENGINE_CRASHED`, `ENGINE_TIMEOUT`, `ENGINE_QUERY_FAILED` (exists in core).

## Important trade-offs

| Choice | Rejected alternative | Why |
|---|---|---|
| Lazy engine start on first game open | Eager start at app launch | A chat-only user never pays RAM/CPU for the engine; the badge already models `starting` |
| Self-contained `setGame` requests | Engine reads `library/store.ts` | Engine must not inherit library lifecycle; 2KB resend is noise |
| Concurrent focus+sweep queries | Strict queue, focus first | Queue freezes the graph exactly when the user lingers — the common case |
| Re-parse with `variationPath` | Second channel returning the branch tree | Keeps the single-projection invariant; a second shape is a second place to drift |
| Readiness probe (1-visit query) | Parse stderr "ready" line | stderr banners are not a protocol; a proven round-trip is |
| Sweep results in-memory only | SQLite cache | Scope decision 2: M4's batch analysis is what forces persistence |
| Winrate graph in SVG | Canvas | ≤361 nodes at ~1/s is not the load that ruled SVG out for the board |

## Operational considerations

- **Logging**: engine stderr → `scoped('main:katago')` at debug; a bounded in-memory tail (~200 lines) is dumped at warn on crash, so a `failed` status carries the engine's own last words. stderr noise (`--stderr-noise` in the fake) must not flood the log file — throttle, don't drop the crash tail.
- **Single-instance lock** (M1) now genuinely matters: two instances would contend for CPU threads and double-spawn engines.
- **Rollback**: no persistent schema changes (no SQLite), so rollback is reinstall — same as M1.
- **Benchmark gate**: before B3's latency number is fixed, run the bundled net on the reference machine (Eigen) and record visits/s in `research/eigen-cpu-throughput.md`'s stead if the web numbers were thin. The acceptance latency is written from measurement, not aspiration.

## Verification design (extends M1's)

| Layer | Technique | Why |
|---|---|---|
| Manifest/fetch | Unit: corrupt-cache rejection, resume offset arithmetic, sha256 mismatch | A truncated engine must fail loudly |
| Config builder | Unit + snapshot; mutation: perspective pin removed | The sign-error class must be mutation-covered |
| Sweep ledger, coalescer | Pure unit + mutation harness (extend `mutate-katago.mts`) | New pure logic gets the same proof as the protocol layer |
| Process lifecycle | Integration against `fake-katago` — extended to speak **analysis mode** (framing via the production `splitJsonLines`, never a copy) | Pipes/framing/exit are what break; mocks test mocks |
| Crash/hang recovery | Integration with `--crash-after`, `--hang-on`, `--garbage-on` | B5/B6 are only real against a child that can actually die |
| IPC | A9's meta-test auto-covers the new channels (adding one without tests fails the meta-test) | Already load-bearing |
| Board overlays | Renderer unit (store → overlay props) + e2e with `GOMENTOR_KATAGO_BINARY`=<fake> | The whole pipeline, no real engine needed |
| Real engine | Manual smoke B1/B3 on the reference machine; CI asserts the *packaged* app reaches `ready` (real binary, packaged layout — the M1 lesson: launch the artifact, not the dev server) | Protocol correctness is proven in tests; packaging is proven on the artifact |

## Risks (carried into implement.md)

1. **Eigen throughput is an envelope, not a measurement** (`research/eigen-cpu-throughput.md`: b10 ≈ 40–100 v/s, b6 ≈ 100–250 v/s estimated; no public benchmarks reachable). Mitigation: the Stage-2 benchmark gate measures the bundled net on the reference machine and B3's latency is written from that measurement; if b10 misses, the net falls back to b6 (manifest already carries both).
2. **Windows runtime deps**: the VC++ redistributable is required but undocumented upstream; KaTrain's precedent (ship the DLLs beside the binary) is adopted. Residual risk: an as-yet-unknown additional DLL discovered only on a clean machine — the CI packaged-launch gate on a pristine runner is where it surfaces.
3. **GitHub release downloads were blocked from the planning network** (connection reset); archive contents were inferred from in-package READMEs + KaTrain's checked-in copies. Mitigation: Stage 1's first real fetch (from an unrestricted network) verifies contents and records sha256 TOFU; the manifest fails loudly until then.
4. **KataGo asset availability is now verified for both shipped platforms** (v1.18.1 win-x64 + linux-x64 Eigen), so the platform-fallback risk is closed by scope decision 6: no darwin target exists in the manifest, and `locate.ts` reports `unavailable` there by construction.
