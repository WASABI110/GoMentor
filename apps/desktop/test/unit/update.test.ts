import { describe, expect, it } from 'vitest'
import {
  createUpdateService,
  mapUpdaterEvent,
  type UpdateDriver,
  type UpdateStatusPayload,
} from '../../src/main/update/update'
import { updateEligibility } from '../../src/main/update/updateEligibility'

/**
 * The auto-update layer's two pure decisions, tested without electron-updater
 * (which imports `electron` at module load and therefore cannot be
 * instantiated under vitest at all):
 *
 * 1. **Eligibility** — dev builds, a disabled setting, and the unsigned-macOS
 *    policy each refuse, in priority order. The macOS refusal is the M5 scope
 *    decision; if a signing identity ever arrives, this test is what changes.
 * 2. **The event mapping** — every electron-updater event maps to exactly one
 *    `update:status` payload. This is the renderer's whole view of the
 *    updater, and a missed event would leave the panel stuck on a stale
 *    state with no error anywhere.
 *
 * The service wiring (subscribe → emit) is covered by scripted drivers in the
 * second describe: a driver that records subscriptions and replays events,
 * which is the same seam the production site passes the real autoUpdater
 * through.
 */

describe('updateEligibility', () => {
  it('accepts a packaged, enabled, non-macOS build', () => {
    expect(
      updateEligibility({ platform: 'win32', isPackaged: true, enabled: true }),
    ).toEqual({
      eligible: true,
    })
    expect(
      updateEligibility({ platform: 'linux', isPackaged: true, enabled: true }),
    ).toEqual({
      eligible: true,
    })
  })

  it('refuses a dev build regardless of anything else', () => {
    expect(
      updateEligibility({ platform: 'win32', isPackaged: false, enabled: true }),
    ).toEqual({ eligible: false, reason: 'dev' })
  })

  it('refuses when the setting disables it', () => {
    expect(
      updateEligibility({ platform: 'win32', isPackaged: true, enabled: false }),
    ).toEqual({ eligible: false, reason: 'disabled-by-setting' })
  })

  it('refuses macOS — the unsigned build policy — even when enabled', () => {
    expect(
      updateEligibility({ platform: 'darwin', isPackaged: true, enabled: true }),
    ).toEqual({ eligible: false, reason: 'unsigned-macos' })
  })

  it('priority: dev beats the setting beats the platform', () => {
    expect(
      updateEligibility({ platform: 'darwin', isPackaged: false, enabled: false }),
    ).toEqual({ eligible: false, reason: 'dev' })
    expect(
      updateEligibility({ platform: 'darwin', isPackaged: true, enabled: false }),
    ).toEqual({ eligible: false, reason: 'disabled-by-setting' })
  })
})

describe('mapUpdaterEvent', () => {
  it('maps every electron-updater event to exactly one payload', () => {
    expect(mapUpdaterEvent('checking-for-update', undefined)).toEqual({
      state: 'checking',
    })
    expect(mapUpdaterEvent('update-available', { version: '1.1.0' })).toEqual({
      state: 'available',
      version: '1.1.0',
    })
    expect(mapUpdaterEvent('update-not-available', undefined)).toEqual({
      state: 'idle',
    })
    expect(mapUpdaterEvent('download-progress', { percent: 42.6 })).toEqual({
      state: 'downloading',
      progress: 42.6,
    })
    expect(mapUpdaterEvent('update-downloaded', { version: '1.1.0' })).toEqual({
      state: 'downloaded',
      version: '1.1.0',
    })
    expect(mapUpdaterEvent('error', new Error('ENOTFOUND'))).toEqual({
      state: 'error',
      error: 'ENOTFOUND',
    })
  })

  it('clamps download progress into the schema range', () => {
    // electron-updater's percent can round a fraction above 100 on the final
    // tick; the `update:status` schema rejects >100, so the mapping clamps.
    expect(mapUpdaterEvent('download-progress', { percent: 100.4 })).toEqual({
      state: 'downloading',
      progress: 100,
    })
    expect(mapUpdaterEvent('download-progress', { percent: -3 })).toEqual({
      state: 'downloading',
      progress: 0,
    })
  })

  it('drops an error event with an empty message instead of emitting a blank error', () => {
    expect(mapUpdaterEvent('error', new Error(''))).toBeNull()
  })
})

/** A driver that records subscriptions so the test can replay events. */
function scriptedDriver(): UpdateDriver & {
  readonly handlers: Map<string, (payload: unknown) => void>
  readonly configure: { autoDownload: boolean[]; autoInstall: boolean[] }
  readonly checks: number
  failWith(error: Error | null): void
} {
  const handlers = new Map<string, (payload: unknown) => void>()
  const configure = { autoDownload: [] as boolean[], autoInstall: [] as boolean[] }
  let checks = 0
  let failCheckWith: Error | null = null
  return {
    handlers,
    configure,
    get checks() {
      return checks
    },
    set autoDownload(value: boolean) {
      configure.autoDownload.push(value)
    },
    set autoInstallOnAppQuit(value: boolean) {
      configure.autoInstall.push(value)
    },
    get autoDownload() {
      return configure.autoDownload.at(-1) ?? false
    },
    get autoInstallOnAppQuit() {
      return configure.autoInstall.at(-1) ?? false
    },
    checkForUpdates() {
      checks += 1
      if (failCheckWith !== null) return Promise.reject(failCheckWith)
      return Promise.resolve(null)
    },
    on(event, listener) {
      handlers.set(event, listener)
      return undefined
    },
    failWith(error: Error | null): void {
      failCheckWith = error
    },
  }
}

describe('createUpdateService wiring (scripted driver)', () => {
  it('an ineligible build emits disabled once and never subscribes', async () => {
    const driver = scriptedDriver()
    const statuses: (UpdateStatusPayload | { state: 'disabled' })[] = []
    const emitStatus = (payload: UpdateStatusPayload | { state: 'disabled' }): void => {
      statuses.push(payload)
    }
    const service = createUpdateService({
      driver,
      platform: 'darwin',
      isPackaged: true,
      enabled: true,
      emitStatus,
    })
    expect(service.eligibility).toEqual({ eligible: false, reason: 'unsigned-macos' })
    expect(driver.handlers.size).toBe(0)
    expect(statuses).toEqual([{ state: 'disabled' }])
    await service.checkForUpdates()
    expect(driver.checks).toBe(0)
  })

  it('subscribes every event, configures auto-download, and forwards mapped payloads', () => {
    const driver = scriptedDriver()
    const statuses: (UpdateStatusPayload | { state: 'disabled' })[] = []
    const emitStatus = (payload: UpdateStatusPayload | { state: 'disabled' }): void => {
      statuses.push(payload)
    }
    const service = createUpdateService({
      driver,
      platform: 'win32',
      isPackaged: true,
      enabled: true,
      emitStatus,
    })
    expect(service.eligibility).toEqual({ eligible: true })
    // All six electron-updater events are subscribed — a missed one strands
    // the status row.
    expect(driver.handlers.size).toBe(6)
    expect(driver.autoDownload).toBe(true)
    expect(driver.autoInstallOnAppQuit).toBe(true)

    const check = driver.handlers.get('checking-for-update')
    const downloaded = driver.handlers.get('update-downloaded')
    check?.(undefined)
    downloaded?.({ version: '9.9.9' })
    expect(statuses).toEqual([
      { state: 'checking' },
      { state: 'downloaded', version: '9.9.9' },
    ])
  })

  it('a rejected check becomes an error status, not an unhandled rejection', async () => {
    const driver = scriptedDriver()
    driver.failWith(new Error('offline'))
    const statuses: (UpdateStatusPayload | { state: 'disabled' })[] = []
    const emitStatus = (payload: UpdateStatusPayload | { state: 'disabled' }): void => {
      statuses.push(payload)
    }
    const service = createUpdateService({
      driver,
      platform: 'win32',
      isPackaged: true,
      enabled: true,
      emitStatus,
    })
    await service.checkForUpdates()
    expect(statuses).toEqual([{ state: 'error', error: 'offline' }])
  })

  it('the startup sequence ends in idle when no update exists', () => {
    const driver = scriptedDriver()
    const statuses: (UpdateStatusPayload | { state: 'disabled' })[] = []
    const emitStatus = (payload: UpdateStatusPayload | { state: 'disabled' }): void => {
      statuses.push(payload)
    }
    createUpdateService({
      driver,
      platform: 'win32',
      isPackaged: true,
      enabled: true,
      emitStatus,
    })
    driver.handlers.get('checking-for-update')?.(undefined)
    driver.handlers.get('update-not-available')?.(undefined)
    expect(statuses).toEqual([{ state: 'checking' }, { state: 'idle' }])
  })
})
