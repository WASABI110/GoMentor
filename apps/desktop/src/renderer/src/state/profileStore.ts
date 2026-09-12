import { create } from 'zustand'
import {
  profileSnapshotSchema,
  type BatchProgress,
  type ErrorEnvelope,
  type ProfileSnapshot,
} from '@gomentor/shared'

/**
 * The student profile and the batch run that feeds it.
 *
 * ## Two states, one panel
 *
 * The profile snapshot is a derivation main computes per request, so the store
 * mirrors it like `libraryStore` mirrors the library: read once on mount, again
 * after anything that could change the rows (a batch run finishing, a game
 * deletion — `library:changed`), never optimistically.
 *
 * The batch run state comes from `batch:progress` events, with `batch:status`
 * filling the gap for a panel that mounts mid-run — the same sync-then-subscribe
 * pairing the engine status panel uses. The terminal event flips `running` off
 * and triggers the profile refetch, which is the only moment new weaknesses can
 * appear without renderer participation.
 */

interface ProfileState {
  /** Null until the first `refresh` resolves — the panel shows loading, not "empty". */
  snapshot: ProfileSnapshot | null
  loading: boolean
  /** Last failure from `refresh` or `startBatch`. */
  error: ErrorEnvelope | null
  /** The live batch run, or null when idle. Mirrors `batch:progress`. */
  batch: BatchProgress | null
  /** True from a `batch:start` call until its response (or a terminal event). */
  starting: boolean

  refresh: () => Promise<void>
  startBatch: (scope: 'all' | 'mine') => Promise<void>
  cancelBatch: () => Promise<void>
  /** Applies one `batch:progress` event. Exposed for the event wiring. */
  applyProgress: (progress: BatchProgress) => void
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,
  batch: null,
  starting: false,

  refresh: async () => {
    set({ loading: true, error: null })
    const result = await window.gomentor.profile.get({})
    if (result.ok) {
      // Through the schema, the libraryStore precedent: the shape the channel
      // returns, not the shape this file hopes for.
      set({ snapshot: profileSnapshotSchema.parse(result.data), loading: false })
    } else {
      set({ error: result.error, loading: false })
    }
  },

  startBatch: async (scope) => {
    set({ starting: true, error: null })
    const result = await window.gomentor.batch.start({ scope })
    if (result.ok) {
      const status = result.data
      set({
        starting: false,
        batch:
          status.status === 'running'
            ? {
                status: 'running',
                total: status.total,
                done: status.done,
                failed: status.failed,
              }
            : null,
      })
    } else {
      set({ error: result.error, starting: false })
    }
  },

  cancelBatch: async () => {
    // The cancel response is the post-cancel snapshot; the terminal
    // `batch:progress` event carries the same news, and `applyProgress` owns
    // the state transition — writing both would be two writers for one value.
    await window.gomentor.batch.cancel({})
  },

  applyProgress: (progress) => {
    const terminal = progress.status !== 'running'
    set({ batch: terminal ? null : progress })
    if (terminal) {
      void get().refresh()
    }
  },
}))
