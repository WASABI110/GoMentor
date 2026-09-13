import { parseSgf } from '@gomentor/core/sgf/parser'
import { AppError, isAppError } from '@gomentor/shared'
import { contentHash, toGame } from '../../sgf/adapter'
import { emit } from '../../ipc/events'
import type { GameStore } from '../../library/store'

/**
 * The one function that moves a Fox SGF into the library — the identical
 * adapter path a file import uses (`contentHash` → dedup → `parseSgf` →
 * `toGame` → `store.put` → `library:changed`), because a Fox import IS a file
 * import as far as every other subsystem can tell: same content-hash dedup,
 * same validation, same refresh event. The integrations rule is preserved in
 * both directions — no core flow depends on Fox succeeding, and the store
 * never learns where the SGF came from.
 */
export function importFoxSgf(
  store: GameStore,
  now: () => string,
  sgf: string,
): { gameId: string; duplicate: boolean } | { error: AppError } {
  try {
    // The adapter hashes bytes (BOM/CA detection downstream), so the text is
    // encoded the same way a read file would arrive.
    const bytes = new TextEncoder().encode(sgf)
    const hash = contentHash(bytes)
    if (store.has(hash)) {
      // Same contract as a file import: a duplicate is a successful no-op.
      return { gameId: hash, duplicate: true }
    }
    const collection = parseSgf(bytes)
    const game = toGame(collection, {
      id: hash,
      source: 'import',
      importedAt: now(),
      contentHash: hash,
      // No filePath: the SGF came from Fox. Omitting it keeps the failure
      // path honest — a sourceless game cannot pretend to be a file.
    })
    store.put({ game, collection })
    emit('library:changed', { reason: 'import' })
    return { gameId: hash, duplicate: false }
  } catch (error) {
    if (isAppError(error)) return { error }
    return {
      error: new AppError(
        'SGF_NOT_SGF',
        'the fetched Fox payload did not parse as SGF',
      ),
    }
  }
}
