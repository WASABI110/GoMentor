import { describe, expect, it } from 'vitest'
import {
  analysisThreadSplit,
  buildAnalysisConfig,
  NN_MAX_BATCH_SIZE,
} from '../../src/main/katago/config'

/**
 * The config builder's load-bearing decisions, per `design.md` §Perspective:
 *
 * - `reportAnalysisWinratesAs = SIDETOMOVE` is pinned so the wire perspective
 *   can never drift from the shared contract (winrate = side to move). This is
 *   the sign-error class: every test passes, the UI shows confident nonsense.
 * - Threads and the visit cap flow from the caller (settings) — a builder that
 *   silently substituted its own values would make the settings UI a placebo.
 * - KataGo v1.18 analysis mode refuses to start without `numAnalysisThreads`
 *   (measured against the real v1.18.1 Eigen binary), so both thread-model
 *   keys are emitted and their split honours the caller's total budget.
 * - Per-query fields (report cadence, per-query visit budgets) must NOT leak
 *   in here; the request owns them.
 */

describe('buildAnalysisConfig', () => {
  it('pins reportAnalysisWinratesAs to SIDETOMOVE', () => {
    const config = buildAnalysisConfig({ threads: 4, maxVisits: 500 })
    expect(config).toContain('reportAnalysisWinratesAs = SIDETOMOVE')
    expect(config).not.toContain('BLACK')
  })

  it('places per-query fields only in the pinned process-wide set', () => {
    const config = buildAnalysisConfig({ threads: 4, maxVisits: 500 })
    // These belong to AnalysisQuery, not the file — asserting absence is the
    // point: a duplicate home for a value is how the two drift.
    expect(config).not.toContain('reportDuringSearchEvery')
    expect(config).not.toContain('analyzeTurns')
    expect(config).not.toContain('includeOwnership')
  })

  it('carries the caller visit cap verbatim', () => {
    const config = buildAnalysisConfig({ threads: 7, maxVisits: 300 })
    expect(config).toContain('maxVisits = 300')
    expect(config).toContain(`nnMaxBatchSize = ${String(NN_MAX_BATCH_SIZE)}`)
  })

  it('emits both v1.18 thread-model keys', () => {
    // v1.18.1 exits on startup without `numAnalysisThreads`; the legacy
    // `numSearchThreads` alias is not emitted so the canonical pair is the
    // only spelling the engine can receive.
    const config = buildAnalysisConfig({ threads: 4, maxVisits: 500 })
    expect(config).toContain('numAnalysisThreads = 2')
    expect(config).toContain('numSearchThreadsPerAnalysisThread = 2')
    expect(config).not.toContain('numSearchThreads =')
  })

  it('keeps the thread total at the caller budget and splits it focus/sweep', () => {
    // Even budget: half positions (sweep parallelism), half threads per
    // position (focus latency). Total = positions × threadsPerPosition.
    expect(analysisThreadSplit(4)).toEqual({ positions: 2, threadsPerPosition: 2 })
    expect(analysisThreadSplit(8)).toEqual({ positions: 4, threadsPerPosition: 4 })
    // Odd budgets round the per-position half up: a lone focus read (the
    // latency-critical tier) keeps the extra thread.
    expect(analysisThreadSplit(5)).toEqual({ positions: 2, threadsPerPosition: 3 })
    // Tiny budgets collapse to one position with one thread rather than zero.
    expect(analysisThreadSplit(1)).toEqual({ positions: 1, threadsPerPosition: 1 })
    // Large budgets stop adding sweep positions past the sweep's own
    // concurrency; the surplus goes to per-position threads (focus).
    expect(analysisThreadSplit(32)).toEqual({ positions: 8, threadsPerPosition: 16 })
  })

  it('disables pondering — review, not play', () => {
    const config = buildAnalysisConfig({ threads: 4, maxVisits: 500 })
    expect(config).toContain('ponderingEnabled = false')
  })

  it('is deterministic for the same params', () => {
    const params = { threads: 4, maxVisits: 500 }
    expect(buildAnalysisConfig(params)).toBe(buildAnalysisConfig(params))
  })

  it('every emitted line is either a comment, blank, or key = value', () => {
    // A structural floor, not a KataGo config parser: it catches a malformed
    // line (a stray template artifact, a dropped `=`) that a `toContain` sweep
    // of individual keys would walk straight past.
    const config = buildAnalysisConfig({ threads: 4, maxVisits: 500 })
    for (const line of config.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      expect(trimmed, `malformed config line: ${line}`).toMatch(/^[a-zA-Z]+ = .+$/)
    }
  })
})
