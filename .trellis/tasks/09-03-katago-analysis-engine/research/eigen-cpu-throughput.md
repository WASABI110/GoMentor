# Research: Eigen CPU Throughput — visits/s on small nets, and what makes live analysis feel responsive

- **Query**: reported visits/second for Eigen CPU on b6/b10/b18 nets on mid-range desktop CPUs; what maxVisits/reportDuringSearchEvery gives ~1-3s useful reads on CPU
- **Scope**: external
- **Date**: 2026-09-04

## Findings

### The one authoritative throughput statement that exists (KataGo README)

From https://github.com/lightvector/KataGo README "OpenCL vs CUDA vs TensorRT vs ROCm vs ONNX vs Eigen" (fetched via GitHub API, 2026-09-04), about the Eigen backend:

> "Eigen is a *CPU* backend that should work widely *without* needing a GPU or fancy drivers. Use this if you don't have a good GPU or really any GPU at all. It will be quite significantly slower than OpenCL or CUDA, but **on a good CPU can still often get 10 to 20 playouts per second if using the smaller (15 or 20) block neural nets**. Eigen can also be compiled with AVX2 and FMA support, which can provide a big performance boost for Intel and AMD CPUs from the last few years. However, it will not run at all on older CPUs (and possibly even some recent but low-power modern CPUs) that don't support these fancy vector instructions."

- Note: this sentence describes the **15- or 20-block** nets (b15c192 / b20c256 ≈ 7M / 17M params). b6c96 (~1M params) and b10c128 (~3M params) are 5-20x cheaper per evaluation.
- The v1.18.1 release body adds: "If you need a pure-CPU version of KataGo, use Eigen AVX2. It will be quite slow compared to GPU."

### KaTrain's calibration (the closest thing to a productized CPU preset)

Fetched 2026-09-04 via api.github.com (repo `sanderland/katrain`):

- `katrain/config.json` engine defaults: **`max_visits: 500`** (full analysis), **`fast_visits: 25`** (live/fast analysis overlay).
- `ENGINE.md` "GPU vs CPU" section: the standard (GPU) executables fail silently on GPU-less machines; users should select the CPU 'Eigen' build via "download katago versions", and: "Keep in mind that a CPU based engine can be significantly slower, and **you may want to set your maximum number of visits to a lower number to compensate** for this."
- KaTrain's own UI shows analysis settling progressively; its fast-analysis mode at 25 visits is designed to feel "instant" while full analysis at 500 visits is the "settled" read.

### Direct b6/b10/b18 Eigen benchmarks — NOT FOUND from this environment

- Searched GitHub issues (`repo:lightvector/KataGo` + eigen/benchmark/visits/playouts): 71 hits, none containing per-net Eigen visit-rate tables. No pinned benchmark issue exists.
- Web search engines (DuckDuckGo HTML) and Wikipedia are unreachable from this environment (connection timeouts, 2026-09-04); KataGo release downloads are also blocked, so a self-benchmark of the official binary could not be run here.
- **Honest status: no public hard numbers for b6/b10 Eigen v/s on a named CPU were verifiable from this environment.** The rest of this file is proxy arithmetic built on the README quote above, clearly labeled.

### Proxy estimate (estimate, NOT measurement)

Cost model: NN eval cost scales ~linearly with parameter count for these convnets; search visits/s then scales ~1/params (single-threaded NN eval dominates on CPU).

| Net | Approx params | Params vs b20 | Implied v/s if b20 = 10-20 v/s on a "good CPU" |
|---|---|---|---|
| b20c256 (README's reference) | ~17M | 1x | 10-20 |
| b15c192 (README's reference) | ~7M | 0.4x | ~25-50 |
| b10c128 (candidate bundle) | ~3M | ~0.18x | **~55-110** |
| b6c96 (candidate bundle) | ~1M | ~0.06x | **~170-330** |

Apply mid-range-desktop discounts (fewer AVX2/FMA execution resources than "a good CPU", memory bandwidth limits): a defensible planning envelope is **b10 ≈ 40-100 v/s, b6 ≈ 100-250 v/s** on a mid-range desktop CPU (e.g. modern i5/Ryzen 5, eigenavx2 build). Treat as order-of-magnitude, not data. Real systems also lose time to policy/aux heads per eval, so the low end is more realistic for live analysis with ownership enabled.

### What this means for "live" analysis latency (derived, assuming the envelope above)

Time to reach N visits ≈ N / (v/s), single position, ignoring batching effects:

| Budget | b10 @ 50 v/s | b10 @ 100 v/s | b6 @ 150 v/s |
|---|---|---|---|
| 25 visits (KaTrain "fast") | 0.5 s | 0.25 s | 0.17 s |
| 100 visits | 2.0 s | 1.0 s | 0.67 s |
| 300 visits | 6.0 s | 3.0 s | 2.0 s |
| 500 visits (KaTrain "full") | 10.0 s | 5.0 s | 3.3 s |

- For a **useful read within 1-3 s on CPU**, `maxVisits` in the 100-300 range (b10) or 200-400 (b6) is the evidence-based starting point. KaTrain's 500-visit default is calibrated for GPU speeds and would feel ~5-10 s on CPU.
- `reportDuringSearchEvery` / `wideRootNoise`-style streaming: KataGo's analysis engine reports periodically during search. With the M1 rule of coalescing ticks to ~20/s in main, a `reportDuringSearchEvery` of **0.1-0.25 s** keeps IPC flat while the UI still updates 4-10x/s — the winrate graph animates toward its settled value rather than appearing after search completes.
- Ownership is computed from the final/root eval pass; it arrives with the same cadence as reports.
- Pondering settings for the bundled config: for review (not play), `ponderingEnabled = false` is typical for analysis sessions — keep CPU free for the current position; revisit in the spike.

### How to get real numbers (what M2 must do, per its own PRD risk note)

1. On the reference Windows machine: fetch official `katago-v1.18.1-eigenavx2-windows-x64.zip` + b10c128/b6c96 nets, run `katago benchmark -model <net>` (it prints nn evals/s and search playouts/s per thread count) — this is the standard, tool-provided measurement.
2. Run a scripted analysis-mode query sweep over maxVisits {50,100,200,300,500} and measure wall time to first report / to settle for b6 and b10; pick the bundled config's default maxVisits from the knee of that curve.
3. Record measured `visitsPerSecond` into `EngineInfo` exactly as the M1 types anticipate (measured, not inferred).

### Related Specs / Task Context

- PRD risk note: "Eigen CPU throughput bounds what 'live' means on the core tier: visit budgets and net size (b6 vs b10 vs b18) trade strength against latency. Needs a benchmark on the reference machine before acceptance latencies are promised." — this research supplies the planning envelope only; the promise must wait for the benchmark.
- `packages/shared/src/types/analysis.ts` — `EngineInfo.visitsPerSecond` is designed for exactly this measurement.

## Caveats / Not Found

- The 40-100 / 100-250 v/s envelope is FLOPs-ratio arithmetic anchored to one README sentence ("10 to 20 playouts per second … 15 or 20 block neural nets" on "a good CPU"). It is not a measurement. Do not quote it as a benchmark result.
- Thread scaling, NUMA, and AVX-512 vs AVX2 differences can move real numbers by 2x either way; `katago benchmark` on the reference machine is the only reliable source.
- Model load time on Eigen (first launch latency) was not measurable from this environment.
