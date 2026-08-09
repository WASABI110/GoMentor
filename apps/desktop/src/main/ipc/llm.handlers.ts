import { handle } from './register'
import type { LlmService } from '../llm/service'

/**
 * LLM channels. Thin by design: the service owns the run lifecycle, and a
 * handler that did more than translate the request would be a second place where
 * `runId` semantics live.
 */
export function registerLlmHandlers(llm: LlmService): void {
  handle('llm:sendMessage', (request) => ({
    // Returns immediately with a handle. The reply streams over `llm:delta`
    // events correlated by this id — see `llm/service.ts` for why this is not
    // request/response.
    runId: llm.send({ content: request.content, history: request.history }),
  }))

  handle('llm:cancel', (request) => {
    llm.cancel(request.runId)
    // Empty response, and deliberately not a boolean "was it cancelled". The
    // run may have finished microseconds earlier, and reporting that as a failed
    // cancel would give the renderer a distinction it cannot act on — the user
    // wanted the stream to stop, and it has.
    return {}
  })
}
