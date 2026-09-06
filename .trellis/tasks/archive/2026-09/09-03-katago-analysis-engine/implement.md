# Implement: KataGo Analysis Engine (M2)

Execution plan for M2. Requirements (E1–E5), acceptance IDs (B1–B9), and scope decisions are in `prd.md`; architecture and rationale in `design.md`.

M1 conventions carried forward: each stage ends with `trellis-check` → `gomentor-verify` (read-only) → main session acts on FAILs. Every gate from Stage 2 on must build and launch `out/` (M1 R12 rule). New pure logic ships with mutation coverage.

## Standard validation commands (every stage gate)

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm check:i18n && pnpm check:licenses && pnpm check:trellis
pnpm e2e                                   # apps/desktop Playwright
tsx scripts/mutate-katago.mts              # extended in Stage 3
pnpm build                                 # plus launching out/ from Stage 2 on
```

## Stage 1 — Build-time fetch and packaging wiring (E1; B2)

- [x] `scripts/katago-manifest.ts` — pinned **v1.18.1** (latest with Eigen builds; v1.18.2 is CUDA-only — research), targets `win32-x64` + `linux-x64` only (no darwin target exists; macOS reports `unavailable` by construction per scope decision 6); sha256 fields **empty/TOFU** (none published upstream — first unrestricted-network fetch records them); bundled weight **b10c128** with b6c96 recorded as fallback; license fields incl. vendored-lib notices (KataGo MIT) and net CC0

**Verify at write time against `research/katago-releases.md` + `research/katago-networks.md`** (asset names/dates were API-verified 2026-09-03; archive contents were inferred because release downloads were blocked from the planning network — the Stage-1 gate below resolves this).

**Download-source caveat, measured at planning time**: the direct release-asset probe was reset by this network on 2026-09-04 (HTTP 000; katagotraining.org's API works, but its model URL shape differs from the research file's `.../networks/kata1-b10c128.../bin.gz` guess and returns 404). The manifest must source **exact working URLs**, not inferred ones: at implementation time, derive the net URL from the live `katagotraining.org/api/networks/?format=json` index (recorded in `research/katago-networks.md`'s caveat) and confirm each engine URL with a cheap range request before committing to it. CI's runners have working egress, so a URL that resolves there is acceptable evidence — but the manifest's URLs are asserted resolvable by a unit test that does a `Range: 0-0` probe (skipped offline), so a wrong guess fails loudly instead of shipping a broken fetch.
- [x] `scripts/fetch-katago.ts` real: download → `*.partial` + `Range` resume → sha256 verify → extract → `resources/katago/<platform>-<arch>/`, chmod on POSIX; `--all` flag; current-platform default
- [x] `scripts/fetch-weights.ts` real, same contract → `resources/weights/`
- [x] `apps/desktop/electron-builder.yml` per-platform `extraResources` (`win`/`linux` select only their `<platform>-<arch>` subdir; the macOS block stays as M1 — no engine assets)
- [x] NOTICE/license test: manifest license fields asserted present in `NOTICE` (extends D4 provenance to binary payloads)
- [x] CI: `pnpm fetch:katago && pnpm fetch:weights` before `pnpm package`, `actions/cache` keyed by manifest hash; packaging gates assert `ready` on **win + linux** only (macOS asserts the installer builds and the app launches reporting `unavailable`)
- [x] Tests: corrupt-cache rejection, resume offset arithmetic, missing-manifest-entry errors; `resources.test.ts` extended to assert the fetched layout matches what `electron-builder.yml` selects

**Gate evidence**: fetch the real Windows binary + net. **Recorded blocker**: this machine's network resets GitHub release-asset downloads (measured HTTP 000, 2026-09-04); if still blocked at Stage 1, the gate's real-engine evidence defers to CI (runners have working egress) and the manifest's TOFU sha256 are written from the CI artifact — the gate asserts the *packaging* half locally (package with a locally absent-but-stubbed layout is NOT accepted: either the real binary is present in `dist/win-unpacked/resources/katago/` or the gate records the network blocker and defers, it does not fake the bytes). `pnpm package` (--dir) and inspect `dist/win-unpacked/resources/katago/` actually contains the binary when the binary could be fetched (the M1 silent-skip lesson — assert bytes, not exit codes). Acceptance: B2 (locally for the pure verification logic; the real-download half on CI).

## Stage 2 — Process lifecycle (E2; B8, B5/B6 groundwork)

- [x] `main/katago/locate.ts` — path resolution (packaged/dev/env-override `GOMENTOR_KATAGO_BINARY`), existence + executable check; missing → `unavailable` (dev) / `failed(ENGINE_BINARY_MISSING)` (packaged)
- [x] `main/katago/config.ts` — pure config-string builder (threads, batch size, **`reportAnalysisWinratesAs` pinned**); written under userData
- [x] `main/katago/process.ts` — spawn, stdio plumbing, stderr ring-buffer (~200 lines) into `scoped('main:katago')`, exit classification (clean/crash), quit-on-app-shutdown (terminate → grace → SIGKILL)
- [x] `main/katago/service.ts` skeleton — status state machine `unavailable→starting→ready/failed`, emits real `engine:status`
- [x] Readiness = 1-visit probe round-trip with deadline (design.md §Engine lifecycle — proven, not declared); version from stderr banner best-effort
- [x] Extend `fake-katago-child.ts` with `--mode=analysis`: newline-JSON in, canned deterministic responses out (seeded by request content), honours `terminate`, framing via the production `splitJsonLines` — never a local copy
- [x] IPC: `engine:info`, `engine:start` (idempotent); preload wrappers; A9 meta-test picks both up
- [x] Integration: spawn→ready, clean shutdown, missing binary both modes, `--stderr-noise` log throttle
- [x] **Benchmark on the reference machine**: real bundled net on Eigen, record visits/s in the task's research dir; B3's latency number is written from this measurement

**Gate evidence**: build `out/`, launch, badge transitions `starting→ready` against the fake via env override; dev-mode missing-binary case renders `unavailable` and every other feature works (B8 = the M1 A13 invariant). Acceptance: B8 + B5/B6 scaffolding reviewed.

## Stage 3 — Live analysis (E3; B3, B4)

- [x] `main/katago/session.ts` — query-id namespacing (`focus:<n>`), in-flight map, terminate-on-supersede, 50ms latest-wins debounce for cursor streams
- [x] `main/katago/coalesce.ts` — per-query ≤20/s latest-wins coalescer (pure, mutation-covered)
- [x] IPC: `engine:setGame` (nullable), `engine:setCursor`; event `engine:analysis`; response/request schemas per design.md
- [x] Perspective normalisation in one place in the session adapter; **verify KataGo's winrate/scoreLead/ownership conventions against AnalysisEngine docs + a real-engine transcript recorded as a test fixture** (design.md §Perspective)
- [x] Renderer: `analysisStore`; `useMainProcessEvents` gains `engine:status` + `engine:analysis`; `EngineStatus` badge reads the store
- [x] `gameStore` drives engine imperatively: `open`→`start`+`setGame`, `seek`/steps→`setCursor`, `close`→`setGame(null)`
- [x] Board overlays: candidate markers A–E (alpha ∝ winrate), PV ghost stones on hover (colour parity from side to move), ownership toggle on the dynamic canvas
- [x] i18n: extend existing `analysis.json`/`errors.json` namespaces (zh-CN + en); new error codes `ENGINE_CRASHED`, `ENGINE_TIMEOUT`, `ENGINE_BINARY_MISSING`
- [x] Extend `scripts/mutate-katago.mts` to coalescer + perspective normalisation + session mapping

**Gate evidence**: e2e with `GOMENTOR_KATAGO_BINARY`=<fake analysis mode> — stepping a game updates candidates/ownership; wrong-length ownership rejected (B4); manual smoke with the real engine on the reference machine: first complete read within the Stage-2-measured budget (B3). If the measured budget shows b10c128 too slow, swap the manifest to b6c96 and re-measure before writing the number (both nets are already in the manifest for exactly this). Acceptance: B3, B4.

## Stage 4 — Sweep, winrate graph, branch navigation (E3 cont.)

- [x] `main/katago/sweep.ts` — pure ledger (moves + completion set + restarts → next query); concurrent with focus per design.md; `sweep:<move>` ids; no ownership on sweep queries
- [x] Renderer `WinrateGraph` (SVG): progressive fill, pending region visibly distinct from 50%, current-move marker, click-to-`seek`
- [x] `sgf:parse` gains optional `variationPath`; `gameSchema` gains `branches` (`.prefault([])` — M1 zod-v4 lesson); projection tested against the variation-bearing files in the 65-file corpus
- [x] `gameStore` retains source SGF privately for re-parse; MoveTree branch picker at branch points; choosing re-parses with updated path and re-`setGame`s the engine
- [x] Mutation coverage: sweep ledger, branch projection

**Gate evidence**: corpus test over variation-bearing fixtures (real files, not synthetic — the A5 rule); e2e: graph fills as fake sweep results stream; branch switch renders the variation line and re-analyses. Acceptance: B3 (graph part), B7 for these modules.

## Stage 5 — Crash auto-recovery and final gate (E4, E5; B1, B5, B6, B7, B9)

- [x] Watchdog: stdout silence with queries in flight → terminate-all → grace → SIGKILL → crash path
- [x] Backoff restart (1s/2s/4s; ≥3 in 60s → `failed(ENGINE_CRASHED)`, user-retrievable via `engine:start`); focus re-issue; sweep resumes from ledger
- [x] Integration: `--crash-after` mid-analysis recovery, `--hang-on` watchdog, `--garbage-on` typed failure, app-quit clean shutdown, engine never outlives the app
- [x] Docs: `docs/architecture.md` + `docs/ipc-contract.md` updated to M2 reality; `.trellis/spec/` amendments from what the stages actually proved (M1 R12 pattern)
- [x] Final gate: full B1–B9 sweep incl. **packaged** `win-unpacked` launch reaching `ready` with the real bundled engine (B1); CI green on **windows + linux** (the macOS job asserts the installer builds and the app launches reporting `unavailable` — no engine asset exists for darwin, scope decision 6); Linux AppImage extraction verified on the ubuntu runner (research: never nest an AppImage inside an AppImage)

## Risky files / rollback points

| File | Why careful |
|---|---|
| `packages/shared/src/ipc.ts` | Contract; the meta-test enforces coverage — adding a channel without tests fails loudly (intended) |
| `apps/desktop/electron-builder.yml` | Per-platform `extraResources` — a wholesale-copy regression ships 3× binaries; assert packaged contents in Stage 1 gate |
| `apps/desktop/src/main/katago/process.ts` | Child lifecycle on Windows: no signals, `SIGKILL` semantics differ; shutdown ordering on app quit |
| `gameStore.ts` | Now drives IPC imperatively — keep the M1 "stores hold inputs" rule: no analysis results cached in gameStore |
| `useMainProcessEvents.ts` | Subscription lifetime rules from M1 (hook-level, no per-panel subscriptions) |

Rollback: no persistent-schema or settings changes in M2 (no SQLite), so rollback is `git revert` per stage; Stage 1's fetched binaries are local untracked artifacts (`resources/*/` READMEs stay).

## Pre-start checks

- [x] `research/katago-releases.md`, `research/katago-networks.md`, `research/eigen-cpu-throughput.md`, `research/bundled-binary-packaging.md` exist and are dated 2026-09-03. Findings folded into prd/design: v1.18.1 pin, win+linux targets only (no macOS binaries → scope decision 6), b10c128 + b6c96 fallback, TOFU sha256, VC++ DLLs beside the binary, Linux AppImage extraction.
- [x] `implement.jsonl` / `check.jsonl` curated with real spec + research entries (sub-agent platform gate)
- [x] Platform fallback question resolved: macOS engine tier deferred by user decision; no other platform lacks official Eigen builds.

## Final gate outcome (2026-09-06)

All stages implemented and gated. Deviations from the plan as written, all recorded in `research/benchmark-eigen.md` and `final-gate.md`:

- **Stage 2's benchmark ran at the final gate**, not at Stage 2 — the planning-time network block (GitHub release-asset resets, measured 2026-09-04) had lifted, and with it the first real-engine run revealed a defect every fake-based test had sailed past: KataGo v1.18.1 requires `numAnalysisThreads` (the builder emitted only the legacy `numSearchThreads` alias) and refused to start. Fixed in `config.ts` with the budget-splitting `analysisThreadSplit` (mutations M38/M93), then measured.
- **The pre-agreed Stage 3 contingency fired**: b10c128 measured 62 visits/s (8.1s per 500-visit read — outside the 1–3s live envelope), so the bundled net swapped to b6c96 (148 visits/s, 3.4s reads, 311 visits/s sweep aggregate). `fetch-weights.ts` now prunes non-primary nets from the shipped dir (the old primary would otherwise have ridden into every installer).
- **The packaged-launch gate exists as `test/e2e/packaged-launch.spec.ts`** (win/linux: `ready` + a real ≥450-visit readout against the bundled engine; darwin: `unavailable` by construction and the record still opens) — run locally green on Windows against fresh packaging, wired into CI after `pnpm package` for all three jobs. It required `electronDist` pointed at the locally installed dist (electron-builder's own dist download truncated on this network) and `launchEnv` exported from the harness (the `ELECTRON_RUN_AS_NODE` leak bites packaged launches too).
- **B3's agreed latency** (the number the benchmark gate exists to produce): complete focus read ≈ 3.4s at defaults; partials stream from ~0.1s; cold start ≈ 0.5s; 100-move-game sweep ≈ 32s.
- Remaining at commit time: the linux/darwin halves of B1 are asserted by CI (see `final-gate.md`), validated on the next push; `engine:linux-x64` sha256 is still TOFU-unrecorded (no Linux machine has fetched; CI cannot commit the observation).
