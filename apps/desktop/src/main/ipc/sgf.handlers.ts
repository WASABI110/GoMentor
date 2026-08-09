import { dialog } from 'electron'
import { parseSgf } from '@gomentor/core/sgf/parser'
import { serialiseSgf } from '@gomentor/core/sgf/serializer'
import { AppError } from '@gomentor/shared'
import { handle } from './register'
import { scoped } from '../logger'
import { contentHash, toGame } from '../sgf/adapter'
import type { GameStore } from '../library/store'

/**
 * SGF channels: parse a string the renderer already has, serialise a stored
 * game back to text, and open the file picker.
 *
 * Nothing here reads the filesystem. `sgf:openDialog` returns paths and
 * `library:import` reads them — keeping the read on the library side means there
 * is one place that decides what a readable file is, rather than two that can
 * disagree about encoding or size limits.
 */

const logger = scoped('main:sgf')

export function registerSgfHandlers(store: GameStore, now: () => string): void {
  handle('sgf:parse', (request) => {
    // A string, not bytes: the renderer got this from a paste or a text field,
    // so there is no BOM to detect and no `CA` to honour beyond what the text
    // itself declares. The bytes path is `library:import`'s.
    const collection = parseSgf(request.content)
    const hash = contentHash(request.content)

    const game = toGame(collection, {
      id: hash,
      source: 'manual',
      importedAt: now(),
      contentHash: hash,
    })

    // The AST is retained beside the Game. `sgf:serialize` writes from the AST,
    // never from `Game.moves`, because the projection drops variations and
    // unknown properties — writing from it would violate A5.
    store.put({ game, collection })

    // No `content` in these fields: it is a game record, which
    // `logging-guidelines.md` forbids logging. The move count is the useful
    // diagnostic and carries nothing private.
    logger.info('parsed sgf', {
      moveCount: game.moves.length,
      boardSize: game.meta.boardSize,
    })
    return game
  })

  handle('sgf:serialize', (request) => {
    const entry = store.get(request.gameId)
    if (entry === undefined) {
      throw new AppError('LIBRARY_NOT_FOUND', 'no such game', {
        context: { gameId: request.gameId },
      })
    }
    // From the AST, deliberately. See the note above.
    return { content: serialiseSgf(entry.collection) }
  })

  handle('sgf:openDialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'SGF', extensions: ['sgf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    // Cancellation returns an empty array, not an error — the contract says so
    // explicitly, and modelling a user changing their mind as a failure would
    // put an error dialog in front of them for doing nothing wrong.
    return { filePaths: result.canceled ? [] : result.filePaths }
  })
}
