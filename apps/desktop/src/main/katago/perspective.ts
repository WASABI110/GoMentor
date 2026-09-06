import type { AnalysisResult, Player } from '@gomentor/shared'

/**
 * KataGo → GoMentor perspective normalisation: the ONE place the engine's
 * reported values are adapted onto the shared contract
 * (`packages/shared/src/types/analysis.ts`: `winrate` side-to-move,
 * `scoreLead` positive-favours-black, ownership positive-favours-black).
 *
 * ## The verified facts this adapts (fetched 2026-09-05, cited where used)
 *
 * `config.ts` pins `reportAnalysisWinratesAs = SIDETOMOVE`. Verified against
 * KataGo's own sources that day:
 *
 * - `docs/Analysis_Engine.md`: "**All values will be from the perspective of
 *   `reportAnalysisWinratesAs`**"; `scoreLead` is "the predicted average
 *   number of points that the **current side** is leading by".
 * - `cpp/search/searchresults.cpp` (`Search::getAnalysisJson`): with the
 *   perspective sentinel for SIDETOMOVE, winrate/scoreLead are flipped iff
 *   `rootPla == P_BLACK` — i.e. reported from the side to move's perspective.
 * - `cpp/search/searchresults.cpp`
 *   (`getAverageAndStandardDeviationTreeOwnership`) and `docs/GTP_Extensions.md`
 *   ("from the perspective of the current player"): the root `ownership`
 *   array is side-to-move perspective too — positive = the player to move
 *   owns the point.
 *
 * So under the pin, KataGo emits winrate/scoreLead/ownership all from the
 * side-to-move perspective. The contract takes winrate as-is and wants
 * scoreLead and ownership black-anchored, so both are negated when White is
 * to move. `winrate` is listed explicitly as identity — not omitted — because
 * "no flip needed" is itself a decision someone could "optimise" away wrongly.
 *
 * ## What is deliberately NOT here
 *
 * A real-engine transcript asserting these conventions end-to-end. The
 * planning-time network block (measured 2026-09-04, `research/katago-releases.md`)
 * lifted before the final gate: the engine has since been fetched and benchmarked
 * on this machine (`research/benchmark-eigen.md`), and the packaged-launch gate
 * lands a real readout through this adapter. What is still verified by
 * construction, not by a captured transcript, is the *sign* of scoreLead and
 * ownership for a White-to-move position against a live engine — the final-gate
 * verification re-derived it from the vendored upstream source
 * (`.research-tmp/searchresults.cpp`: with `reportAnalysisWinratesAs = SIDETOMOVE`,
 * values flip iff the root player is black, over a white-perspective base —
 * i.e. side-to-move, which is what the flip below assumes; ownership row-major).
 * No transcript or winrate number is fabricated to stand in for a capture.
 */

/** Negates scoreLead and ownership when White is to move; winrate is identity. */
export function normalizeAnalysisResult(
  result: AnalysisResult,
  playerToMove: Player,
): AnalysisResult {
  if (playerToMove === 'black') {
    // Black to move: KataGo's side-to-move perspective IS black's perspective,
    // which the contract already uses for scoreLead/ownership. Nothing to do —
    // and that nothing is load-bearing, which is why the branch is explicit.
    return result
  }
  return {
    ...result,
    // White to move: positive meant "White ahead / White owns"; the contract
    // wants positive-favours-black.
    scoreLead: -result.scoreLead,
    candidates: result.candidates.map((candidate) => ({
      ...candidate,
      scoreLead: -candidate.scoreLead,
    })),
    ...(result.ownership === undefined
      ? {}
      : { ownership: result.ownership.map((value) => -value) }),
  }
}
