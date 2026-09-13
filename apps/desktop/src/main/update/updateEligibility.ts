/**
 * Whether this process should run the auto-updater — the pure decision, split
 * from `update.ts`'s wiring so every policy branch is unit-testable and
 * mutation-covered without Electron.
 *
 * ## The three refusals, in priority order
 *
 * - **dev** — an unpackaged run has no `app-update.yml` for electron-updater
 *   to read and no installed version to update; "check for updates" there is
 *   meaningless, and letting it run produces a confusing `error` state on
 *   every developer launch.
 * - **disabled-by-setting** — `settings.autoUpdate.enabled` is the user's
 *   off switch. Like every settings-driven construction decision (telemetry
 *   consent), it is read once per process; flipping it takes effect on next
 *   launch, and `update:status` says `disabled` so the panel can say so.
 * - **unsigned-macos** — the M5 scope decision: no Apple developer account,
 *   so the macOS build ships ad-hoc signed, and Squirrel.Mac refuses
 *   unsigned/foreign-signature updates (its `zip` download would fail at
 *   install verification anyway). Disabling is the honest state, surfaced in
 *   the menu (the item is absent) and the settings panel (`disabled`, with
 *   the reason in the payload). If a signing identity arrives, the fix is
 *   here plus the build pipeline — this branch reads no environment.
 */

export type UpdateIneligibilityReason = 'dev' | 'disabled-by-setting' | 'unsigned-macos'

export interface UpdateEligibilityInput {
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  /** `settings.autoUpdate.enabled`. */
  readonly enabled: boolean
}

export type UpdateEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: UpdateIneligibilityReason }

export function updateEligibility(input: UpdateEligibilityInput): UpdateEligibility {
  if (!input.isPackaged) return { eligible: false, reason: 'dev' }
  if (!input.enabled) return { eligible: false, reason: 'disabled-by-setting' }
  if (input.platform === 'darwin') return { eligible: false, reason: 'unsigned-macos' }
  return { eligible: true }
}
