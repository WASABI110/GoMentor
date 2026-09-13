import { handle } from './register'
import type { GameStore } from '../library/store'
import type { FoxService } from '../integrations/fox/service'
import { importFoxSgf } from '../integrations/fox/import'

/**
 * Fox (野狐) channels (M5 Stage 5). Thin by the handler rule: upstream calls
 * live in `integrations/fox/service.ts` (rate-limited, error-mapped), and the
 * import is the ordinary library path via `integrations/fox/import`. These
 * translate the contract onto them and carry no Fox knowledge of their own.
 *
 * `fox:import` composes the two service calls (fetch the SGF, then run the
 * library adapter) because the user's action is "import this game", not
 * "fetch a payload" — the composition is the handler's whole job.
 */
export function registerFoxHandlers(
  fox: FoxService,
  store: GameStore,
  now: () => string,
): void {
  handle('fox:lookupUser', (request) => fox.lookupUser(request.nickname))

  handle('fox:listGames', async (request) => ({
    games: await fox.listGames(request.uid, request.lastCode),
  }))

  handle('fox:import', async (request) => {
    const sgf = await fox.fetchGameSgf(request.chessid)
    const result = importFoxSgf(store, now, sgf)
    if ('error' in result) throw result.error
    return { gameId: result.gameId, duplicate: result.duplicate }
  })
}
