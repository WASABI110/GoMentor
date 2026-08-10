import { create } from 'zustand'
import type { ErrorEnvelope, GameSummary } from '@gomentor/shared'

/**
 * The library list, mirrored from main.
 *
 * ## Event-authoritative, unlike `settingsStore`
 *
 * `state-management.md` §Mirroring main-process state distinguishes two cases, and
 * this is the other one. Main can change the library *without being asked* — an
 * import, a delete, or a disk watcher — so `library:changed` exists and is
 * authoritative. The pattern is: read once on mount, subscribe to the event, and
 * write by calling `invoke` rather than by mutating the store.
 *
 * `settingsStore` deliberately has no equivalent event, and the reasoning there is
 * the mirror image of the reasoning here: settings change only because the renderer
 * asked, so the response is enough. Conflating the two is what the spec warns
 * against — an event for state that only ever changes on request writes the same
 * value twice, and the late write can clobber a subsequent edit.
 *
 * ## `import` does not merge its own result into the list
 *
 * `library:import` responds with what it imported, and appending that to `games`
 * is the obvious move. It is wrong: main emits `library:changed` for the same
 * import, so the list would be written twice — once locally, once from the refetch
 * — and any disagreement between them shows as duplicated or vanishing rows. The
 * response is used for what only it knows (which files failed, how many were
 * duplicates); the list itself comes from `refresh`.
 *
 * ## Partial success is data, not an error
 *
 * One unreadable file in a folder import must not fail the batch — `ipc.ts` records
 * this in the channel contract, which returns `failures` alongside `imported`. So a
 * successful import can carry failures, and `error` stays `null`: the *operation*
 * worked. `lastImport` keeps the detail so the UI can say "14 imported, 2 failed"
 * rather than reducing it to one flag.
 */

/** Outcome of the most recent import, for the UI to report. `null` before any. */
export interface ImportOutcome {
  imported: number
  duplicates: number
  failures: { filePath: string; error: ErrorEnvelope }[]
}

interface LibraryState {
  games: GameSummary[]
  /** True until the first `refresh` resolves — distinct from "the library is empty". */
  loading: boolean
  /** True while an import is running, so the UI can disable the button. */
  importing: boolean
  /** Last failure from `refresh` or from an import that failed outright. */
  error: ErrorEnvelope | null
  /** Detail of the last import, including per-file failures. */
  lastImport: ImportOutcome | null

  refresh: () => Promise<void>
  importFiles: (filePaths: string[]) => Promise<void>
}

export const useLibraryStore = create<LibraryState>((set) => ({
  games: [],
  loading: false,
  importing: false,
  error: null,
  lastImport: null,

  refresh: async () => {
    set({ loading: true, error: null })
    const result = await window.gomentor.library.list({})
    if (!result.ok) {
      // The previous list stays. Emptying it on a failed refetch would show the
      // user an empty library, which is indistinguishable from having no games —
      // and would invite them to re-import everything.
      set({ loading: false, error: result.error })
      return
    }
    set({ games: result.data.games, loading: false })
  },

  importFiles: async (filePaths) => {
    // An empty selection is the cancel case for `sgf:openDialog`, which documents
    // that an empty array means the user cancelled and is not an error. The channel
    // requires `.min(1)`, so sending it would be a validation failure presented to
    // someone who simply closed a dialog.
    if (filePaths.length === 0) return

    set({ importing: true, error: null })
    const result = await window.gomentor.library.import({ filePaths })
    if (!result.ok) {
      set({ importing: false, error: result.error })
      return
    }

    // No merge into `games`: `library:changed` follows and `refresh` is the single
    // writer of the list. See the header note.
    set({
      importing: false,
      lastImport: {
        imported: result.data.imported.length,
        duplicates: result.data.duplicates,
        failures: result.data.failures,
      },
    })
  },
}))
