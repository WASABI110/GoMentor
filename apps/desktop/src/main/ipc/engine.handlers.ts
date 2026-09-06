import { handle } from './register'
import type { EngineService } from '../katago/service'

/**
 * Engine channels. Thin by the handler rule: the service owns the lifecycle
 * (`katago/service.ts`), these translate the contract onto it. `engine:start`
 * is where a game open (Stage 3) or a retry after `failed` lands; its
 * idempotence lives in the service, not here — a handler that re-checked would
 * be a second copy of the state machine's rules.
 */
export function registerEngineHandlers(engine: EngineService): void {
  // A snapshot for fresh mounts: the badge subscribes to `engine:status`
  // events, but events emitted before mount are gone — this is the sync path
  // that closes that gap.
  handle('engine:info', () => engine.info())

  handle('engine:start', () => engine.start())

  // Thin by the handler rule: supersede, debounce, and readiness-held intent
  // all live in the service/session — a handler that re-checked would be a
  // second copy of those rules.
  handle('engine:setGame', (request) => engine.setGame(request.game, request.atMove))

  handle('engine:setCursor', (request) => engine.setCursor(request.moveNumber))
}
