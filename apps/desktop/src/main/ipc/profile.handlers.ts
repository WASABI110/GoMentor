import { buildProfile, type ProfileGameInput } from '@gomentor/core/profile/profile'
import { classifyGame } from '@gomentor/core/profile/categories'
import { isMyGame } from '@gomentor/core/profile/mine'
import type { ProfileSnapshot } from '@gomentor/shared'
import { handle } from './register'
import type { GameStore } from '../library/store'
import type { AnalysisRepository } from '../db/repositories/analysis'
import type { Settings } from '@gomentor/shared'

/**
 * The profile channel (M4 Stage 3). The derivation is a pure read — rows from
 * the repository, records from the store, everything assembled by the core's
 * on-demand pipeline — so the handler owns no state and cannot drift from the
 * data: an invalidated game simply stops contributing until re-analysed,
 * which is the design's "no snapshot, no invalidation" decision made code.
 *
 * "My games" is the same `isMyGame` predicate the batch tier's `mine` scope
 * queues through, so the panel and the batch button describe the same
 * library by construction.
 */
export function registerProfileHandlers(deps: {
  readonly store: GameStore
  readonly repository: AnalysisRepository
  readonly settings: { readonly get: () => Settings }
}): void {
  handle('profile:get', () => buildSnapshot(deps))
}

export function buildSnapshot(deps: {
  readonly store: GameStore
  readonly repository: AnalysisRepository
  readonly settings: { readonly get: () => Settings }
}): ProfileSnapshot {
  const playerNames = deps.settings.get().profile.playerNames

  // One pass over the library: each of the student's games contributes either
  // its marks (rows exist) or the unanalysed count (none yet). A game deleted
  // between list and get is simply gone — there is nothing to derive from.
  const inputs: ProfileGameInput[] = []
  let unanalysed = 0
  for (const summary of deps.store.list()) {
    const stored = deps.store.get(summary.id)
    if (stored === undefined) continue
    if (
      !isMyGame(
        {
          blackName: summary.blackName,
          whiteName: summary.whiteName,
          blackRank: summary.blackRank,
          whiteRank: summary.whiteRank,
        },
        playerNames,
        deps.store.getIsMineOverride(summary.id),
      )
    ) {
      continue
    }

    const rows = deps.repository.rowsFor(summary.id)
    if (rows.length === 0) {
      unanalysed += 1
      continue
    }
    inputs.push({
      gameId: summary.id,
      importedAt: stored.game.importedAt,
      marks: classifyGame(stored.game, rows),
    })
  }

  return {
    ...buildProfile(inputs),
    // `myGames` counts the unanalysed ones too, so the panel's "run the batch
    // analysis" nudge knows there is something to run.
    myGames: inputs.length + unanalysed,
    analysedMyGames: inputs.length,
  }
}
