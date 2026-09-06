/**
 * Builds the KataGo analysis config file, a pure string in / string out.
 *
 * ## What belongs here and what does not
 *
 * Only **process-wide** settings: thread count, batch size, cache size, and the
 * perspective pin. Visit budgets and reporting cadence are *per-query* fields
 * (`AnalysisQuery` in `packages/core/src/katago/analysis.ts`) and travel with
 * each request, so they are not duplicated into this file — one source of
 * truth per value, and a config that cannot silently disagree with the query
 * that overrode it.
 *
 * ## Why `reportAnalysisWinratesAs` is pinned here, in a comment and in code
 *
 * KataGo's reported perspective is config-dependent (`reportAnalysisWinratesAs`,
 * `SIDETOMOVE` or `BLACK`), while the shared contract declares
 * `MoveInfo.winrate` as **side-to-move perspective** and `scoreLead` as
 * positive-favours-black (`packages/shared/src/types/analysis.ts`). Left to a
 * default or inherited from a user-supplied config, a silent sign error would
 * render "70% for the player to move" as "70% for black" — visually plausible
 * and entirely wrong, the class of bug M1's gates shipped four times green.
 * The builder sets it explicitly and there is no parameter to change it; the
 * mutation harness breaks the pin and requires the suite to notice.
 *
 * `SIDETOMOVE` (not `BLACK`) is the pinned value because that is the contract
 * the renderer was built against.
 *
 * ## What the pin does and does NOT settle — verified against KataGo's source
 *
 * This comment originally also claimed "scoreLead needs no equivalent pin
 * since KataGo reports it positive-favours-black unconditionally". That was
 * wrong, and the correction is worth recording in detail because it is exactly
 * the failure mode this pin exists for. Verified 2026-09-05 against
 * `docs/Analysis_Engine.md` ("All values will be from the perspective of
 * `reportAnalysisWinratesAs`"; `scoreLead` is "points that the current side is
 * leading by") and `cpp/search/searchresults.cpp` (`getAnalysisJson`):
 *
 * - With `SIDETOMOVE` pinned, `winrate` and `scoreLead` are **side-to-move
 *   perspective** — positive `scoreLead` means the player to move is ahead,
 *   whichever colour that is.
 * - The root `ownership` array is also side-to-move perspective (positive =
 *   the player to move owns the point), per the same flip logic in
 *   `getAverageAndStandardDeviationTreeOwnership` and `GTP_Extensions.md`
 *   ("from the perspective of the current player").
 *
 * The shared contract wants `scoreLead` positive-favours-black and ownership
 * positive-favours-black, so the session adapter negates both when White is to
 * move (`main/katago/perspective.ts`). That normalisation is the *reason* the
 * config pin is load-bearing: with the config accidentally on `BLACK`, every
 * winrate would already be black-anchored and the adapter's flip would double-
 * flip — mutation M37 exists to prove the suite notices the pin breaking.
 */

import { SWEEP_CONCURRENCY } from './sweep'

/** Matches KataGo's own analysis-example default; the CPU tier is visit-latency bound, not batch bound. */
export const NN_MAX_BATCH_SIZE = 16

export interface AnalysisConfigParams {
  /**
   * The user's **total** engine thread budget (`settings.engine.threads`),
   * split across the v1.18 thread model — see `analysisThreadSplit`.
   */
  readonly threads: number
  /** Default per-query visit cap — requests may go lower, not higher. */
  readonly maxVisits: number
}

export interface AnalysisThreadSplit {
  /** `numAnalysisThreads` — positions searched in parallel. */
  readonly positions: number
  /** `numSearchThreadsPerAnalysisThread` — search threads per position. */
  readonly threadsPerPosition: number
}

/**
 * Splits the user's thread budget across KataGo v1.18's two-axis thread model.
 *
 * v1.18 analysis mode **requires** `numAnalysisThreads` (measured: v1.18.1
 * refuses to start — `Could not find key 'numAnalysisThreads'` — on a config
 * that only sets the old `numSearchThreads` alias; the real-engine gate caught
 * what every test against the fake child could not). The two axes are:
 *
 * - `numAnalysisThreads` — POSITIONS searched in parallel;
 * - `numSearchThreadsPerAnalysisThread` — search threads per position;
 *
 * with total threads as their product (`analysis_example.cfg` §EXPLANATION).
 * GoMentor has both workload shapes KataGo's guidance names: interactive
 * single-position reads (focus, latency-critical) and batched multi-position
 * reads (sweep, throughput-oriented, `SWEEP_CONCURRENCY` wide). So the budget
 * is split in half — each position keeps enough threads to finish a focus read
 * promptly, and the sweep still gets real parallelism, capped at the sweep's
 * own concurrency because more search positions than that never run.
 *
 * The total stays at the user's budget (±1 on odd values), which is what the
 * 30s watchdog bound and the throughput envelope in
 * `research/eigen-cpu-throughput.md` are calibrated against.
 */
export function analysisThreadSplit(threads: number): AnalysisThreadSplit {
  const positions = Math.max(1, Math.min(SWEEP_CONCURRENCY, Math.floor(threads / 2)))
  const threadsPerPosition = Math.max(1, Math.ceil(threads / 2))
  return { positions, threadsPerPosition }
}

export function buildAnalysisConfig(params: AnalysisConfigParams): string {
  const split = analysisThreadSplit(params.threads)
  return [
    '# Generated by GoMentor on every engine start. Manual edits are overwritten.',
    '# Process-wide settings only: visit budgets and reporting cadence are',
    '# per-query fields and travel with each analysis request.',
    '',
    `maxVisits = ${String(params.maxVisits)}`,
    `numAnalysisThreads = ${String(split.positions)}`,
    `numSearchThreadsPerAnalysisThread = ${String(split.threadsPerPosition)}`,
    `nnMaxBatchSize = ${String(NN_MAX_BATCH_SIZE)}`,
    'nnCacheSizePowerOfTwo = 21',
    '',
    '# Review, not play: pondering would spend CPU on positions the user has',
    '# already left (`research/eigen-cpu-throughput.md`).',
    'ponderingEnabled = false',
    '',
    '# Pinned, never inherited: the shared contract declares winrate as',
    '# side-to-move perspective. Do not make this configurable without changing',
    '# the contract and the renderer in the same commit.',
    'reportAnalysisWinratesAs = SIDETOMOVE',
    '',
  ].join('\n')
}
