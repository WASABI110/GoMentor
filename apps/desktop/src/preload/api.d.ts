import type { GoMentorApi } from './index'

declare global {
  interface Window {
    /**
     * The sole bridge to the main process, exposed by preload via
     * contextBridge. There is no `window.ipcRenderer` and no `window.require`
     * — see .trellis/spec/frontend/directory-structure.md.
     */
    readonly gomentor: GoMentorApi
  }
}
