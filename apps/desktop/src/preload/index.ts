import { contextBridge } from 'electron'

// The ONLY bridge between renderer and main. Thin by design: no business
// logic here, just typed pass-through.
//
// Stage 5 fills this in with invoke methods and on* event registrars that
// return unsubscribe functions. The object is frozen so the page cannot
// augment or replace it, and no raw ipcRenderer handle is ever exposed —
// that would be a sandbox escape.

const api = Object.freeze({
  version: '0.1.0',
})

export type GoMentorApi = typeof api

contextBridge.exposeInMainWorld('gomentor', api)
