import {
  FoxProtocolError,
  fetchGameSgf,
  listGames,
  lookupUser,
  type FoxFetch,
  type FoxGameSummary,
} from './protocol'

/**
 * The Fox service: rate limiting + error mapping around the protocol layer.
 * Isolated by the integrations rule — no core flow may depend on it
 * succeeding, so every failure surfaces as a typed envelope on the operation
 * that asked, and nothing here ever touches library/analysis state directly
 * (imports go through the same `library:import` path a file does).
 *
 * ## The rate limiter
 *
 * 1 request / 2 s, enforced over an INJECTABLE clock and an injectable wait —
 * the tests drive time, the production waits are real. The limiter is
 * process-global because the upstream does not distinguish callers; a single
 * user clicking fast must not get either of them banned.
 *
 * ## Zero retries
 *
 * The quality guideline forbids unbounded retries against anything fragile;
 * Fox is the most fragile surface in the app. One attempt per user action,
 * and the typed error tells the user what happened.
 */

/** Minimum spacing between two upstream requests, in ms. */
const MIN_INTERVAL_MS = 2000

export interface FoxService {
  /** Resolves a nickname to a uid + display name (1 upstream request). */
  lookupUser(nickname: string): Promise<{ uid: string; nickname: string }>
  /** One page of the user's public games (1 upstream request). */
  listGames(uid: string, lastCode?: string): Promise<FoxGameSummary[]>
  /** Fetches one game's SGF (1 upstream request). */
  fetchGameSgf(chessid: string): Promise<string>
}

export interface FoxServiceDeps {
  /** The transport. Production binds global fetch; tests bind fixtures. */
  readonly fetch: FoxFetch
  readonly now: () => number
  /**
   * Waits so the NEXT request honours the interval. Production sleeps; tests
   * inject a no-op (and assert the computed delay instead of waiting for it).
   */
  readonly wait: (ms: number) => Promise<void>
}

export class FoxServiceError extends Error {
  readonly code: 'SOURCE_UNREACHABLE' | 'SOURCE_SCHEMA_CHANGED' | 'FOX_USER_NOT_FOUND'

  constructor(
    code: 'SOURCE_UNREACHABLE' | 'SOURCE_SCHEMA_CHANGED' | 'FOX_USER_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'FoxServiceError'
    this.code = code
  }
}

export function createFoxService(deps: FoxServiceDeps): FoxService {
  let lastRequestAt: number | null = null

  async function paced<T>(operation: () => Promise<T>): Promise<T> {
    const now = deps.now()
    if (lastRequestAt !== null) {
      const elapsed = now - lastRequestAt
      if (elapsed < MIN_INTERVAL_MS) {
        await deps.wait(MIN_INTERVAL_MS - elapsed)
      }
    }
    lastRequestAt = deps.now()
    try {
      return await operation()
    } catch (error) {
      // Map the protocol's typed failures onto the integration codes the
      // renderer already translates. A network-level throw (fetch rejects —
      // DNS, TLS, offline) is SOURCE_UNREACHABLE; a payload that no longer
      // matches the fixtures is SOURCE_SCHEMA_CHANGED; a missing user is a
      // state, not an infrastructure failure, and keeps its own code.
      if (error instanceof FoxProtocolError) {
        if (error.code === 'FOX_USER_NOT_FOUND') {
          throw new FoxServiceError('FOX_USER_NOT_FOUND', error.message)
        }
        if (error.code === 'FOX_BAD_PAYLOAD') {
          throw new FoxServiceError('SOURCE_SCHEMA_CHANGED', error.message)
        }
        throw new FoxServiceError('SOURCE_UNREACHABLE', error.message)
      }
      throw new FoxServiceError(
        'SOURCE_UNREACHABLE',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return {
    lookupUser: (nickname) => paced(() => lookupUser(deps.fetch, nickname)),
    listGames: (uid, lastCode) => paced(() => listGames(deps.fetch, uid, lastCode)),
    fetchGameSgf: (chessid) => paced(() => fetchGameSgf(deps.fetch, chessid)),
  }
}
