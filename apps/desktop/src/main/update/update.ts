import { scoped } from '../logger'
import {
  updateEligibility,
  type UpdateEligibility,
  type UpdateEligibilityInput,
} from './updateEligibility'

/**
 * The auto-update service: electron-updater against the GitHub Releases feed,
 * states pushed to the renderer as `update:status` events.
 *
 * ## The feed needs no configuration here
 *
 * `electron-builder.yml`'s `publish:` block is what generates the packaged
 * `app-update.yml` (provider github, this repo — public, so feed reads need
 * no token), and electron-updater reads that file at runtime. Hardcoding the
 * provider here too would be a second description of the same fact.
 *
 * ## States are transitions, and the mapping is total
 *
 * Every electron-updater event maps to exactly one `update:status` payload
 * (`mapUpdaterEvent` below — pure, unit-tested): `update-not-available`
 * becomes `idle` rather than a distinct state, because "no update" and
 * "nothing has been checked yet" need the same UI answer. `autoDownload`
 * stays on (the default) so `available` and `downloading` arrive in sequence
 * without a second user action, and `autoInstallOnAppQuit` (also the default)
 * is what makes `downloaded` safe to just sit on: quitting installs, and the
 * renderer's prompt is an offer, not a requirement.
 *
 * ## The updater is injectable
 *
 * `electron-updater` imports `electron` at module load, so importing it here
 * would make the unit tests need an electron mock just to assert an event
 * mapping. The constructor takes the updater as a dependency instead; the
 * production site passes the real one, the tests pass a scripted fake, and
 * the mapping — the actual logic — is tested against the interface both
 * satisfy.
 */

const logger = scoped('main:update')

/** The subset of electron-updater's `autoUpdater` this service drives. */
export interface UpdateDriver {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  on(event: string, listener: (payload: unknown) => void): unknown
}

export interface UpdateStatusPayload {
  readonly state:
    'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  readonly version?: string
  readonly progress?: number
  readonly error?: string
}

/** electron-updater's progress event, narrowed to the fields used. */
interface ProgressInfo {
  readonly percent: number
}

interface VersionInfo {
  readonly version: string
}

export type UpdateEventName =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error'

/**
 * The total event → payload mapping. Returns null for the `error` event when
 * its payload carries nothing printable (defensive — electron-updater always
 * includes a message, but an empty string would render as a blank error).
 */
export function mapUpdaterEvent(
  event: UpdateEventName,
  payload: unknown,
): UpdateStatusPayload | null {
  switch (event) {
    case 'checking-for-update':
      return { state: 'checking' }
    case 'update-available': {
      const { version } = payload as VersionInfo
      return { state: 'available', version }
    }
    case 'update-not-available':
      return { state: 'idle' }
    case 'download-progress': {
      const { percent } = payload as ProgressInfo
      // Clamped at the schema edge too; electron-updater's percent can round
      // a fraction above 100 on the final tick.
      return { state: 'downloading', progress: Math.max(0, Math.min(100, percent)) }
    }
    case 'update-downloaded': {
      const { version } = payload as VersionInfo
      return { state: 'downloaded', version }
    }
    case 'error': {
      // A message, never a whole error object — the payload is stringified
      // only when it IS a string (an Error's own `message`; anything else
      // would render as `[object Object]`, which tells the user nothing).
      const message =
        payload instanceof Error
          ? payload.message
          : typeof payload === 'string'
            ? payload
            : ''
      if (message === '') return null
      return { state: 'error', error: message }
    }
  }
}

export interface UpdateService {
  /** The eligibility decision this process started with. */
  readonly eligibility: UpdateEligibility
  /** Runs one check. A no-op (logged) when ineligible. */
  checkForUpdates(): Promise<void>
}

export interface CreateUpdateServiceDeps extends UpdateEligibilityInput {
  readonly driver: UpdateDriver
  readonly emitStatus: (payload: UpdateStatusPayload | { state: 'disabled' }) => void
}

export function createUpdateService(deps: CreateUpdateServiceDeps): UpdateService {
  const eligibility = updateEligibility(deps)

  if (!eligibility.eligible) {
    // One `disabled` emission at startup, with the reason carried by the
    // caller (`index.ts` logs it; the renderer shows a status line). The
    // updater is never touched — importing it is fine, subscribing is not.
    logger.info('auto-update disabled', { reason: eligibility.reason })
    deps.emitStatus({ state: 'disabled' })
    return {
      eligibility,
      checkForUpdates: () => {
        logger.debug('checkForUpdates skipped (ineligible)', {
          reason: eligibility.reason,
        })
        return Promise.resolve()
      },
    }
  }

  const { driver, emitStatus } = deps
  driver.autoDownload = true
  driver.autoInstallOnAppQuit = true

  for (const event of [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error',
  ] as const) {
    driver.on(event, (payload: unknown) => {
      const status = mapUpdaterEvent(event, payload)
      if (status !== null) emitStatus(status)
    })
  }

  return {
    eligibility,

    async checkForUpdates() {
      try {
        // States flow through the event wiring above; the returned promise is
        // only about completion/failure of the check itself.
        await driver.checkForUpdates()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('update check failed', { error: message })
        emitStatus({ state: 'error', error: message })
      }
    },
  }
}
