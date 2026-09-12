# Journal - anon (Part 1)

> AI development session journal
> Started: 2026-08-03

---



## Session 1: Stage 6 renderer components: GameList, MoveTree, EngineStatus, SettingsPanel, theme tokens

**Date**: 2026-08-22
**Task**: Stage 6 renderer components: GameList, MoveTree, EngineStatus, SettingsPanel, theme tokens
**Branch**: `master`

### Summary

Completed Stage 6 renderer components for the GoMentor desktop app: GameList with drag-drop SGF import (Electron File.path), MoveTree linear navigation with arrow-key stepping, EngineStatus badge subscribing to engine:status, SettingsPanel with locale switch, LLM provider config, and safeStorage key entry, plus UI primitives (Button/Input/Select), theme tokens in styles/theme.css, and the BoardOverlay scaffold. Fixed a resize-handle bug where mousemove listeners never attached (ref mutation does not trigger effects - mirrored into isDragging state). Added panel-resize.spec.ts as the A2 e2e gate covering drag-resize and persistence across relaunch. trellis-check pass fixed a stale locale-select value, an unmounted-setTimeout leak, and switched TeacherPanel to Button primitives. Filled frontend component/hook guidelines specs from the patterns that emerged. All gates green: lint, typecheck, 1067 unit/integration tests, 27 e2e tests, check-i18n.

### Git Commits

| Hash | Message |
|------|---------|
| `6f07f14` | (see git log) |
| `fb748fd` | (see git log) |
| `5847e8a` | (see git log) |

### Status

[OK] **Completed**

## Session 2: M2 final gate — real-engine benchmark, net swap, packaged launch, B1–B9 recorded

**Date**: 2026-09-06
**Task**: KataGo Analysis Engine (M2) — final gate
**Branch**: `master`

### Summary

Closed out M2's final gate. Updated `docs/architecture.md` to M2 reality (last Stage 5 doc item), then ran the full-scope trellis-check — it caught a high-severity packaging bug (electron-builder `copyDir` places the *contents* of `from` into `to`, so `to: katago` would have shipped the engine flat and killed the packaged launch with `ENGINE_BINARY_MISSING`; fixed to per-platform `to:` with a regression test) plus a schema tightening (`errorCode` → `errorCodeSchema.optional()`, typed service failure codes). The Sep-4 network block had lifted, so the real engine fetched for the first time — and instantly failed to start: KataGo v1.18.1 requires `numAnalysisThreads`, which the config builder never emitted (the fake accepted any config; every test was green against an engine that could not run). Fixed with the `analysisThreadSplit` budget split (mutations M38/M93), then benchmarked both nets on the reference machine: b10c128 8.1s per 500-visit read (rejected), b6c96 3.4s (148 v/s) — the pre-agreed contingency fired and the bundled net swapped, with `fetch-weights.ts` now pruning non-primary nets from the shipped dir. Built the packaged-launch gate (`packaged-launch.spec.ts`): win/linux assert `ready` + a real ≥450-visit readout against the bundled engine; darwin asserts `unavailable`-by-construction with the record still open; wired into CI after `pnpm package`. Packaging itself needed `electronDist` pointed at the local dist (electron-builder's own download truncated) and the harness's `ELECTRON_RUN_AS_NODE` strip exported. gomentor-verify verdicts: B1–B8 PASS (notes recorded), B9 initially FAIL (no recorded verdicts) — closed by `final-gate.md`, ticked `implement.md`, and this journal. 1321 unit/integration + 36 e2e green, 95/95 mutations.

### Status

[OK] **Completed** (linux/darwin B1 halves + CI green validate on next push)


## Session 2: M2 final gate: real-engine benchmark, net swap, packaged launch gates green on all three OS

**Date**: 2026-09-06
**Task**: M2 final gate: real-engine benchmark, net swap, packaged launch gates green on all three OS
**Branch**: `master`

### Summary

Closed M2. Real engine fetched and run for the first time: KataGo v1.18.1 requires numAnalysisThreads (fake-accepted config defect, fixed via analysisThreadSplit, mutations M38/M93). Benchmark: b10c128 8.1s/read rejected per contingency, b6c96 3.4s (148 v/s) bundled; fetch-weights prunes non-primary nets. Packaged-launch spec: win/linux assert ready + real >=450-visit readout, darwin asserts unavailable-by-construction; wired into CI for all three OS. trellis-check caught copyDir contents-vs-path packaging bug; gomentor-verify B1-B8 PASS, B9 closed by final-gate.md. CI: three runs verified, all three OS green with exactly one executed packaged gate per platform. Remaining: engine:linux-x64 sha256 environment-blocked (network resets release assets; 949eb16 makes first Linux-side fetch record it).

### Git Commits

| Hash | Message |
|------|---------|
| `b6db001` | (see git log) |
| `2f8874a` | (see git log) |
| `949eb16` | (see git log) |
| `edf6443` | (see git log) |

### Status

[OK] **Completed**


## Session 3: M3 complete: LLM agent loop — tools, runner, renderer steps, A1-A7 green on all three OS

**Date**: 2026-09-09
**Task**: M3 complete: LLM agent loop — tools, runner, renderer steps, A1-A7 green on all three OS
**Branch**: `master`

### Summary

Delivered M3 end to end. Stage 1: read-only tool registry (ToolSchema from zod, isError self-correction, registered codes only) + get_position/search_library/get_analysis wired to the engine's new analyzeOnce — an agent:<n> independent query tier proven on the wire to never touch the user's cursor session. Stage 2: the runner (serial dispatch, 8-step cap -> LLM_AGENT_LIMIT via llm:error, AbortSignal threaded to the engine query, degrade tri-state where single-shot is the same loop with no tools — wire byte-identity asserted at three layers); check caught a model-supplied __proto__ poisoning parseToolArguments (null-prototype record, test + mutation R8). Stage 3: ToolSteps in the teacher panel (fragment accumulation preserved, ~120-char previews, blank-state reload semantics documented) + e2e against a scripted SSE model server through the real provider parser; check caught a vacuous cross-check (whole-turn innerText always contains the step JSON — fixed to read markdown paragraphs only, sabotage-verified). Final gate: A1-A7 all PASS; the A2 citation gap closed with a search_library e2e (matched count + typed result fields digit-matched answer-vs-step). 8 dead M1-era i18n keys removed; both mutation harnesses now exit non-zero on escapes (exit code is the gate, seeded-escape demonstrated); design deviations recorded in-design; architecture.md to M3; 5 spec lessons captured. CI to green took three rounds: icon byte-identity test timeout on cold windows runners (60s budget), then a genuine prettier non-idempotence bug on trailing-argument comments (comment moved above the call; three --writes produced three layouts); final run green on all three OS with every packaged gate success. 1433 unit/integration + 42 e2e, 36/36 + 95/95 mutations.

### Git Commits

| Hash | Message |
|------|---------|
| `d134858` | (see git log) |
| `4800187` | (see git log) |
| `f428cc0` | (see git log) |
| `40f3c87` | (see git log) |
| `b095537` | (see git log) |
| `98971f6` | (see git log) |

### Status

[OK] **Completed**


## Session 4: M4 complete: student profile & persistence — SQLite, batch tier, profile core, C1-C8 green on all three OS

**Date**: 2026-09-12
**Task**: M4 complete: student profile & persistence — SQLite, batch tier, profile core, C1-C8 green on all three OS
**Branch**: `master`

### Summary

Delivered M4 end to end across four stages, each committed, pushed, and CI-green (three OS + repo gates) on first attempt. Stage 1: SQLite foundation — WAL, transactional numbered migrations, corrupt-file quarantine, GameStore Map->DB swap behind an unchanged interface (equivalence tests), better-sqlite3 ABI probe (pnpm rebuild proven a no-op under neverBuiltDependencies), C1 restart e2e. Stage 2: ledger-driven batch tier — batch:<n> one-shot queries (B3 third binding), waves from the thread model, yield to focus sessions, chunk checkpoints, rows+ledger-done in ONE transaction, cancel/engine-loss leave games pending, mine scope; 14 integration tests against the real service + fake child; mutate-profile harness born (G/P/B/D mutants). Stage 2's trellis-implement agent died on API quota mid-work; salvaged and completed in the main session — every leftover defect was unreconciled agent work, none a design flaw. Stage 3: pure profile core in packages/core — mine predicate relocated with the C4 professional exclusion (override > pro > names, one predicate shared by batch mine + profile), four-category classifier (type-locked signature, board-replay geometry via core Position, Chebyshev, recorded thresholds), normalized-decay EMA (textbook recurrence measured to give a 2-game library's OLDEST game ~93% weight — inverted recency; replaced), profile:get with readonly wire arrays and semantic refines; harness grew to 80 mutants across both packages, 80/80 caught. Stage 4: ProfileSection (evidence click-through reusing the open->seek path), settings my-names editor, get_profile tool (fourth registry entry, profile seam, quote-don't-classify prompt constraint both locales), profile.json i18n, e2e C5 (real batch against the fake engine drives the panel; no DB seeding — binding-ABI and honesty reasons recorded) and C6 (score digits cross-checked on the wire A2-style); architecture.md rewritten to M4; final-gate.md records C1-C8 per-criterion verdicts. Two mutation lessons specced: a no-op mutant presents as an escape (G11 replaced, not loosened) and a downstream gate can mask an upstream mutant (C10 fixture must let the effect reach the observable); per-gate ABI-state fact specced after a smoke launch measured alive-but-windowless on an ABI mismatch. Final tree: 1600 unit/integration + 45 e2e, mutations 95/95 + 38/38 + 80/80, all gates green, CI three OS green on every stage commit.

### Git Commits

| Hash | Message |
|------|---------|
| `c8f8afb` | (see git log) |
| `0249a90` | (see git log) |
| `975afb9` | (see git log) |
| `eeb4c2c` | (see git log) |

### Status

[OK] **Completed**
