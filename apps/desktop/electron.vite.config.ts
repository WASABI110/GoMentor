import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite's `startElectron` spawns the Electron binary with
// `stdio: 'inherit'` and no `env` override, so the child inherits our
// environment verbatim. If ELECTRON_RUN_AS_NODE is set — Electron-based
// editors and terminals leak it into their integrated shells — the binary
// boots as plain Node instead of as Electron. `require('electron')` then
// resolves to the npm wrapper module, which exports the path string to
// electron.exe, and `app` is undefined. Clear it here: this config is loaded
// in the very process that does the spawning.
delete process.env['ELECTRON_RUN_AS_NODE']

// Three build targets: main (Node/Electron), preload (isolated bridge),
// renderer (browser). Getting this wiring right is Stage 1's whole point —
// everything downstream depends on it.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@gomentor/shared': resolve('../../packages/shared/src'),
        '@gomentor/core': resolve('../../packages/core/src'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@gomentor/shared': resolve('../../packages/shared/src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },

  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@gomentor/shared': resolve('../../packages/shared/src'),
        '@gomentor/core': resolve('../../packages/core/src'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
})
