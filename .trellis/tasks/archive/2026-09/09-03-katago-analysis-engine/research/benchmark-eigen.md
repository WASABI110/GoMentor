# Research: Real-engine benchmark — Eigen CPU throughput on the reference machine (Stage 2/3 gate)

- **Date measured**: 2026-09-06, ~19:45–19:50 local
- **Reference machine**: AMD Ryzen 7 5700X (8 cores / 16 threads), Windows 11, win32-x64
- **Engine**: KataGo v1.18.1, `katago-v1.18.1-eigenavx2-windows-x64.zip` (bundled via `scripts/katago-manifest.ts`)
- **Method**: `apps/desktop/scripts/bench-eigen.ts` (`pnpm -F @gomentor/desktop bench:engine [alt-net-path]`) — spawns the bundled binary through the **production** process layer (`main/katago/process.ts`), production config builder (`main/katago/config.ts`), production protocol codecs (`@gomentor/core/katago/analysis`). Config: `numAnalysisThreads`/`numSearchThreadsPerAnalysisThread` split of the settings default `threads = 4` → 2 positions × 2 threads, `nnMaxBatchSize = 16`, `reportAnalysisWinratesAs = SIDETOMOVE`. Focus queries carry `includeOwnership: true`; sweep queries do not (mirrors the product's focus/sweep query shapes).
- **Positions**: a fixed 30-move 19×19 fuseki; focus at moves 30/24/27 (distinct, so NN-cache reuse cannot fake speed); sweep = 8 concurrent 100-visit queries at moves 3–27.

## Results

| Phase | b10c128 (original recommendation) | b6c96 (bundled after swap) |
|---|---|---|
| Cold start (spawn → 1-visit probe complete) | 1874 ms | 521 ms |
| Focus: 500 visits + ownership, per query | 8082 / 7876 / 8955 ms | 3300 / 3380 / 3409 ms |
| **Focus rate (median)** | **62 visits/s (8.1 s per read)** | **148 visits/s (3.4 s per read)** |
| Sweep aggregate: 8 × 100 visits concurrent | 8264 ms → 97 visits/s | 2573 ms → 311 visits/s |

## Decisions driven by these numbers

1. **`numAnalysisThreads` is mandatory on v1.18.1.** The first real-engine run exited on startup: `Could not find key 'numAnalysisThreads' in config file`. The builder had emitted only the legacy `numSearchThreads` alias (valid pre-1.18); the fake test engine accepts any config, so every test against it passed. `config.ts` now emits the canonical v1.18 pair with a budget-splitting rule (`analysisThreadSplit`): half the user's thread budget to per-position threads (focus latency), half to parallel positions (sweep), capped at `SWEEP_CONCURRENCY`; total stays at the budget. Mutations M38/M93 pin both halves of the rule.

2. **Bundled net swapped b10c128 → b6c96** (the contingency pre-agreed in implement.md Stage 3). b10c128's 8.1s complete read sits outside the 1–3s useful-read envelope `eigen-cpu-throughput.md` framed as "live"; b6c96 delivers the same 500-visit read in 3.4s, fills the sweep 3× faster, starts 3.6× faster, and cuts the bundled net 13.8MB → 5.0MB. Trade-off accepted: ~1560 site Elo weaker at equal visits, but at equal wall time its 500-visit reads match b10c128's ~150-visit reads, and B3's requirement is cursor-following latency, not maximum strength. b10c128 stays in the manifest as the recorded stronger-but-slower alternative.

3. **B3's agreed latency number (the thing this gate exists to produce)**: with the bundled b6c96 and default settings (500 visits, ownership on), a **complete** focus read arrives ~3.4s after the query; partials stream from ~0.1s (0.1s `reportDuringSearchEvery`), so candidates/winrate/ownership visibly track the cursor in well under a second and settle at ~3.4s. Cold start to first probe: ~0.5s. Full-graph sweep for a 100-move game (10,000 visits): ~32s measured at 311 visits/s aggregate.

4. **Watchdog 30s bound is validated with margin**: the slowest legitimate silence (8 concurrent sweep queries) measured 2.6s; even the planning envelope's conservative 40 visits/s aggregate puts it at ~20s < 30s. The number stays.

## Reproducing

```bash
pnpm fetch:katago && pnpm fetch:weights
pnpm -F @gomentor/desktop bench:engine                                # bundled net
pnpm -F @gomentor/desktop exec tsx scripts/bench-eigen.ts \
  resources/weights/kata1-b10c128-s1141046784-d204142634.txt.gz       # alternative net
```
