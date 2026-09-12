import { handle } from './register'
import type { BatchService } from '../katago/batch'

/**
 * Batch channels. Thin by the handler rule: the scheduler (`katago/batch.ts`)
 * owns the run lifecycle — queue, yield, ledger, progress — and these translate
 * the contract onto it. `batch:start` returns the run snapshot while the work
 * proceeds in the background and reports on `batch:progress`.
 */
export function registerBatchHandlers(batch: BatchService): void {
  handle('batch:start', (request) => batch.start(request.scope))

  handle('batch:cancel', () => batch.cancel())

  handle('batch:status', () => batch.status())
}
