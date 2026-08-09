import { readFileSync } from 'node:fs'
import { parseSgf } from '@gomentor/core/sgf/parser'
import {
  AppError,
  isAppError,
  type ErrorEnvelope,
  type GameSummary,
} from '@gomentor/shared'
import { handle } from './register'
import { scoped } from '../logger'
import { contentHash, toGame, toSummary } from '../sgf/adapter'
import { emit } from './events'
import type { GameStore } from '../library/store'

/**
 * Library channels: list what is stored, import files from disk.
 *
 * ## Partial success is the normal case, not an error path
 *
 * A folder import that hits one malformed file must not fail the whole batch.
 * Someone importing 300 games from a decade of Fox exports will have a few
 * truncated ones, and forcing them to find and remove those by hand before any
 * import succeeds would make the feature useless for the collections that most
 * need it. So failures are **data** — `{ filePath, error }` rows in the
 * response — rather than a thrown error, which the contract encodes directly.
 *
 * The consequence to keep in mind: this handler must not throw for anything
 * per-file. A throw here loses the successes alongside the failure.
 */

const logger = scoped('main:library')

/** Files above this are refused unread. */
const MAX_FILE_BYTES = 16 * 1024 * 1024

interface ImportFailure {
  filePath: string
  error: ErrorEnvelope
}

export function registerLibraryHandlers(store: GameStore, now: () => string): void {
  handle('library:list', () => ({ games: store.list() }))

  handle('library:import', (request) => {
    const imported: GameSummary[] = []
    const failures: ImportFailure[] = []
    let duplicates = 0

    for (const filePath of request.filePaths) {
      try {
        // Read as **bytes**, not utf8. The parser detects the BOM and honours
        // `CA`; decoding to a JS string here would force a UTF-8 assumption and
        // mojibake every Shift_JIS and GB18030 file in the corpus.
        const bytes = readFileSync(filePath)

        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new AppError(
            'LIBRARY_FILE_UNREADABLE',
            'file is too large to be an SGF record',
            {
              context: { bytes: bytes.byteLength },
            },
          )
        }

        const hash = contentHash(bytes)
        if (store.has(hash)) {
          // Counted, not reported as a failure. A duplicate is a successful
          // no-op from the user's point of view — they already have the game.
          duplicates += 1
          continue
        }

        const collection = parseSgf(bytes)
        const game = toGame(collection, {
          id: hash,
          source: 'import',
          importedAt: now(),
          contentHash: hash,
          filePath,
        })

        store.put({ game, collection })
        imported.push(toSummary(game))
      } catch (error) {
        // `filePath` is logged; file *contents* never are. A path is needed to
        // act on the failure at all, and unlike the content it is not the user's
        // study material.
        logger.failure('import failed', error, { filePath })
        failures.push({
          filePath,
          error: isAppError(error)
            ? error.toEnvelope()
            : {
                code: 'LIBRARY_FILE_UNREADABLE',
                message: 'The file could not be read',
              },
        })
      }
    }

    if (imported.length > 0) {
      // Fired so a second window, and the renderer's own list, refetch rather
      // than relying on the caller to update local state — the import may not
      // be what is on screen.
      emit('library:changed', { reason: 'import' })
    }

    logger.info('import finished', {
      requested: request.filePaths.length,
      imported: imported.length,
      duplicates,
      failed: failures.length,
    })
    return { imported, duplicates, failures }
  })
}
