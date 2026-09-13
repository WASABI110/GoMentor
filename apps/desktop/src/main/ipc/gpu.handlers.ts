import { handle } from './register'
import type { GpuService } from '../katago/gpu'
import type { SettingsService } from '../settings'

/**
 * GPU tier-2 channels (M5 Stage 4). Thin by the handler rule: the download
 * lifecycle lives in `katago/gpu.ts` and reports on `gpu:progress`; these
 * translate the contract onto it.
 *
 * `gpu:download` takes the settings service because selecting a backend is
 * the natural second half of the flow — download, then prefer. That write is
 * a plain settings update (validation and persistence for free) rather than
 * a third bespoke path; the saved document flows back through the ordinary
 * `settings:get` the panel already re-reads.
 */
export function registerGpuHandlers(gpu: GpuService, settings: SettingsService): void {
  handle('gpu:status', () => gpu.status())

  handle('gpu:download', (request) => {
    const started = gpu.download(request.backend)
    settings.update({ engine: { backend: request.backend } })
    return started
  })
}
