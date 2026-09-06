# PRD: KataGo Analysis Engine (M2)

## Goal and user value

Give GoMentor its analysis engine. After M2, a user can: install the app and get real KataGo analysis **with zero configuration on first launch** (ADR 0003) — see live winrate, candidate moves with principal variations, and per-point ownership while stepping through a game; the engine recovering transparently if it crashes.

M2 deliberately excludes the LLM agent loop (M3) and student profiles (M4). The engine's output is *displayed* here; it is *explained* there.

## Background and confirmed facts (from repository evidence, not assumption)

### Already built in M1 — M2 is additive on top of these

| Asset | Where | State |
|---|---|---|
| GTP protocol layer (encode/decode/framing, `I`-skip safe) | `packages/core/src/katago/gtp.ts` | Done, mutation-tested (`scripts/mutate-katago.mts`) |
| Analysis-mode JSON protocol (request build, response parse, ownership validation, PV truncation) | `packages/core/src/katago/analysis.ts` | Done, mutation-tested |
| Protocol constants + `KataGoRuleset` | `packages/core/src/katago/commands.ts` | Done |
| Engine lifecycle types: `EngineStatus` (`unavailable\|downloading\|starting\|ready\|failed`), `EngineBackend` (`tensorrt\|cuda\|opencl\|eigen`, in probe order), `EngineInfo` (measured `visitsPerSecond`, `downloadProgress`) | `packages/shared/src/types/analysis.ts` | Done |
| `AnalysisResult` / `MoveInfo` / `Ownership` / `MoveDelta` zod schemas | same file | Done |
| `engine:status` typed event, emitted by main, rendered by badge | `packages/shared/src/ipc.ts`, `apps/desktop/src/main/index.ts:128`, `apps/desktop/src/renderer/src/components/EngineStatus.tsx` | Done — badge already renders all five states incl. download progress bar |
| `extraResources` for `resources/{katago,weights,knowledge}` (outside asar, spawnable) | `apps/desktop/electron-builder.yml` | Done; dirs exist with git-tracked READMEs, guarded by `scripts/test/resources.test.ts` |
| `fetch-katago.ts` / `fetch-weights.ts` | `scripts/` | **Deliberately failing stubs**; requirements documented in-file (platform×backend, checksum before trust, resume, outside-asar) |
| GTP test double: real spawned child with fault flags (`--crash-after`, `--hang-on`, `--garbage-on`, `--unterminated-on`, `--delay-ms`, `--stderr-noise`) | `apps/desktop/test/integration/fake-katago{,-child}.ts` | Done; framing uses the production parser, not a copy |
| Board dynamic canvas layer designed for per-frame overlays | `apps/desktop/src/renderer/src/.../Board.tsx` | Done (M1); heatmap/ownership/candidates were the stated reason for the two-layer split |

### Locked decisions from M1 that bind M2

- **D6 tiered installer** (ADR 0003): core tier = app + Eigen CPU backend + one small net (b6/b10), ~120MB, analysis-capable offline on first launch. On-demand tier = the one accelerated backend the machine can use, ~180MB, checksum-verified + resumable. Full-offline tier = separate release asset.
- **Backend detection is measured, not inferred** (ADR 0003 consequences): probe by actually launching each candidate with a benchmark query, never by parsing GPU vendor strings. `EngineInfo.visitsPerSecond` is measured.
- **D8**: analysis mode primary (one response = winrate + scoreLead + ownership + PV, id-correlated concurrency); GTP secondary (third-party engines, play-vs-engine, test fakes).
- **Streaming rule**: analysis ticks coalesced in main to ~20/s before `webContents.send` (M1 design.md; engines emit faster than UI can paint, flooding IPC is a known Electron cliff).
- **i18n**: the four backend display names (`TensorRT`, `CUDA`, `OpenCL`, `CPU (Eigen)`) are pinned in the check-i18n allowlist and must match what the engine reports.
- **Single-instance lock** already enforced — matters more now: two instances would fight over the GPU and (if added) SQLite.
- **M1 research caveat**: "Before M2 implements engine packaging, verify those repos' actual layouts directly" — resolved during M2 planning: release asset names were verified via the GitHub API and recorded in `research/katago-releases.md` (with the caveat that zip contents were inferred, not listed, because release downloads were blocked from the planning network; sha256 is recorded TOFU at first real fetch).

### Key research findings (`research/`, 2026-09-03)

- **Latest Eigen builds: KataGo v1.18.1** (2026-08-24). v1.18.2 (2026-08-30) is CUDA-only. Eigen + eigenavx2 builds exist for **windows-x64 and linux-x64 only**; no macOS binaries in any release.
- **No checksums are published** upstream for engine or small nets. The fetch manifest records sha256 **TOFU** (recorded at first verified download), and the first fetch from an unrestricted network writes them.
- **Bundled net recommendation: b10c128** (13.79 MiB `.txt.gz`, Elo 11522, CC0) for the core tier; b6c96 (4.97 MiB, Elo 9962) is the size-optimal fallback. Net URLs stable since 2020-11-28.
- **Eigen CPU throughput has no public b6/b10 benchmark.** Envelope estimate: b10 ≈ 40–100 v/s, b6 ≈ 100–250 v/s on a desktop CPU. B3's latency number must come from the on-machine benchmark gate, not from this file.
- **Windows VC++ redistributable is required but undocumented upstream**; KaTrain ships `msvcp140`/`vcruntime140` DLLs next to `katago.exe` — GoMentor bundles them the same way.
- **macOS ad-hoc deep-sign is required for Apple Silicon children** (KaTrain CI precedent) — deferred with the macOS tier per scope decision 6.
- **Download sources have a measured caveat**: GitHub release-asset downloads are reset by the development network (HTTP 000, measured 2026-09-04), and katagotraining.org's model URL shape differs from the research file's guess (its live API index works, the guessed direct path 404s). The manifest must therefore derive net URLs from the live `katagotraining.org` API index at implementation time and assert every URL with a cheap range probe (skipped offline) — no URL ships on inference.

### Deferred-to-M2 items carried from M1

- SQLite / `better-sqlite3`: "lands in M2 **when there is analysis data to persist**" (M1 PRD out-of-scope note). Whether M2 has such data is a scope decision (below).
- Code-signing spike runs in parallel from M2; actual signing is M5. macOS Gatekeeper treatment of an unsigned bundled `katago` binary is a named M2 risk.
- Engine-download hosting: "GitHub Releases works initially, but a mainland-China CDN/mirror should be planned (M2)" — still open.

## Requirements

### E1 — Zero-config bundled engine
Build-time fetch (`fetch-katago.ts`, `fetch-weights.ts` become real): platform-correct KataGo Eigen build + one small net, checksum-verified against a pinned manifest, resumable, landing in `resources/{katago,weights}` (outside asar). Packaged app spawns the bundled engine with no user setup. Dev mode resolves the same resources directory.

### E2 — Engine process lifecycle in main
`main/katago/process.ts` around the M1 pure layer: spawn, handshake (verify it *is* KataGo via `list_commands` before sending `kata-*`), analysis-mode session management, stderr capture into the logger, clean shutdown on app quit. `engine:status` transitions become real: `starting → ready`, `failed` with typed error codes.

### E3 — Live analysis UI
While the user steps through a game, the current position is analysed continuously: winrate + score lead graph/panel, candidate moves ranked on the board with PV preview (hover), per-point ownership/heatmap overlay on the dynamic canvas layer. Ticks coalesced to ~20/s in main. Board-size correct for 19/13/9.

### E4 — Crash auto-recovery
Engine exit while work is in flight → typed detection (not a hang), bounded restart with backoff, in-flight query re-issued or failed cleanly, UI informed via `engine:status`. The fake-engine fault flags (`--crash-after`, `--hang-on`) exist precisely to test this against a real child process.

### E5 — Acceptance-verification extension
New acceptance IDs + stage gates per R12/D10 (trellis-check → gomentor-verify, build-and-launch-`out/` rule). Mutation harnesses extended to whatever new pure logic M2 adds (e.g. backend manifest parsing, download verification).

## Scope decisions (resolved)

1. **Tier-2 on-demand GPU download flow: DEFERRED** (user, 2026-09-03). M2 ships the core tier only — bundled Eigen + one small net. Backend detection lands in its minimal form: verify the bundled Eigen launches, measure `visitsPerSecond` while running. The multi-backend benchmark machinery, download manager (resume/checksum/progress UI), backend swap, and the mainland-China hosting decision all move to the follow-on task that implements tier-2. Consequence recorded: GPU users get CPU-speed analysis until then — the ADR 0003 promise holds (analysis-capable offline on first launch); the "~40x faster" offer does not exist yet.

2. **SQLite analysis cache: DEFERRED** (user, 2026-09-03). M2 keeps analysis results in memory for the session; re-opening the same game at the same move re-analyses (seconds on CPU). `better-sqlite3`'s native rebuild and `backend/database-guidelines.md` land with M4's batch analysis, which is what forces persistence. Consequence: nothing in M2 writes a DB schema, so no migration concern is created either.

3. **Move tree scope: PV + read-only branch navigation** (user, 2026-09-03). M2 delivers: (a) hovering a candidate on the board steps through its principal variation; (b) MoveTree gains branch choice at nodes where the loaded SGF actually has variations — read-only navigation of what the file carries. The SGF parser already keeps the full branching AST, so this is renderer work, not parser work. NOT in M2: creating/editing variations (a user trying moves on the board and branching the record) — that is editor territory with `gameStore` writes and SGF serialisation-back, deferred.

## Scope decisions (resolved — continued)

4. **Play-vs-engine: DEFERRED** (user, 2026-09-03). M2 is review/analysis only. The GTP layer stays exercised by the test fakes; `genmove` ships unused by product code. Consequence: no game-mode UI (colour choice, resign/pass handling, scoring) is designed in M2.

5. **Full-offline bundle asset: DEFERRED** (user, 2026-09-03). The ~500MB all-backends asset serves the tier-2 audience through restricted networks; with tier-2 deferred it would also require the deferred multi-backend detection to be useful. It lands with tier-2. M2's CI builds only the core tier per OS.

6. **Platform support: Windows + Linux only in M2** (user, 2026-09-03). Research (`research/katago-releases.md`) established that KataGo publishes official Eigen builds for windows-x64 and linux-x64 only — **no macOS binaries exist in any release**; homebrew builds from source (Metal on arm64, Eigen on Intel). A macOS source-build pipeline (CMake/toolchain) is its own XL project and is excluded from M2. macOS packaged installers are still built in CI (the installer build itself is verifiable) but the app on macOS transparently reports `unavailable`; the engine code (`locate.ts`, fetch manifest) is written platform-generic so a later macOS engine asset drops in. The ADR 0003 zero-config promise holds on win/linux; macOS users get everything except engine analysis.

## Open scope decisions

None. All scope decisions are resolved above.

## Out of scope for M2

Deferred to later milestones, with no M2 design decision blocking them:

- **Tier-2 on-demand GPU download flow + full-offline asset** — lands together (scope decisions 1, 5); includes the multi-backend benchmark machinery and the mainland-China hosting decision
- **SQLite / `better-sqlite3` analysis cache** — lands with M4's batch analysis (scope decision 2); `backend/database-guidelines.md` deferred with it
- **Play-vs-engine** — GTP layer stays exercised by test fakes (scope decision 4)
- **macOS engine tier** — no official macOS KataGo binaries exist (scope decision 6); a source-build pipeline is its own project, and the ad-hoc-deep-sign knowledge is preserved in `research/bundled-binary-packaging.md` for it
- **Variation creation/editing** — read-only branch navigation only (scope decision 3)
- LLM tool-calling agent + knowledge base (M3)
- Student profile, weakness tracking, batch library analysis (M4)
- Code signing / notarization itself (M5)
- Fox sync, readboard, additional locales, auto-update wiring (M5)
- Telemetry beyond M1's no-op (M5)

## Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| B1 | Fresh packaged install (Windows/Linux) analyses a game with no network and no configuration (core tier, Eigen); the macOS build transparently reports `unavailable` and remains fully usable | Unpack packaged `out/`/installer artifact, launch, assert `engine:status` → `ready` and a real `AnalysisResult` arrives |
| B2 | Engine binary + net are checksum-verified at fetch time; a corrupted download is rejected and resumable | Scripted: corrupt the cache, re-run fetch |
| B3 | Live analysis follows the cursor: stepping moves updates winrate/candidates/ownership within an agreed latency on the reference machine | e2e against fake engine (deterministic) + manual smoke against real KataGo |
| B4 | Ownership array renders per-point on the correct intersections for 19/13/9; wrong-length ownership is rejected, never shifted | Unit (protocol) + board overlay test |
| B5 | Killing the engine mid-analysis recovers: status transitions are observable, in-flight work is re-issued or cleanly failed, app stays usable | Integration test with `--crash-after` fault flag |
| B6 | Hang detection: an engine that stops responding is detected and restarted, not awaited forever | Integration test with `--hang-on` fault flag |
| B7 | All new IPC carries the A9-style coverage + non-vacuity meta-test; new pure logic carries mutation harnesses | Test suite + `scripts/mutate-*.mts` |
| B8 | App remains fully usable with the engine `failed`/`unavailable` (the M1 A13 invariant must not regress) | e2e |
| B9 | Every stage gate ran trellis-check then gomentor-verify with recorded per-ID verdicts; gates build and launch `out/` | Verify agent reports |

## Technical notes and risks

- **KataGo release facts were verified via the GitHub API at planning time** (see `research/katago-releases.md`): latest Eigen builds are v1.18.1, windows-x64 + linux-x64 only, and **no macOS binaries exist in any release** (scope decision 6). One caveat carried into Stage 1: release-asset *downloads* were blocked from the planning network, so archive contents were inferred from in-package READMEs and KaTrain's checked-in copies; the first fetch from an unrestricted network verifies zip contents and records sha256 TOFU (none are published upstream).
- **Windows runtime deps**: the Eigen build needs the VC++ redistributable (undocumented upstream; KaTrain ships the DLLs next to the binary — GoMentor does the same).
- **macOS deferred per scope decision 6**; the ad-hoc-deep-sign knowledge for a future Apple Silicon build is captured in `research/bundled-binary-packaging.md`.
- **Eigen CPU throughput** bounds what "live" means on the core tier: envelope estimates b10 ≈ 40–100 v/s, b6 ≈ 100–250 v/s, with no public benchmarks (`research/eigen-cpu-throughput.md`). Visit budgets and net choice trade strength against latency; the on-machine benchmark gate (Stage 2) records the real number and B3's latency is written from that measurement, not from the envelope.
- **Linux official builds are AppImages** (self-contained) — fetch extracts them rather than nesting; `libzip`/`Error 127` extraction risks are a Stage-1 test target.
