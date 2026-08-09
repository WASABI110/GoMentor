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
//
// ## Why the workspace packages are excluded from externalization
//
// `externalizeDepsPlugin()` reads `dependencies` from package.json and leaves
// every entry as a runtime `require()` instead of bundling it. That is right for
// real npm packages — `electron-log` ships CJS and shipping it twice is waste —
// but wrong for `@gomentor/shared` and `@gomentor/core`, which are `"type":
// "module"` and whose `main` points at uncompiled `.ts` source. Externalized,
// the CJS main bundle emits `require("@gomentor/shared")`, Node resolves it to
// `packages/shared/src/index.ts`, and the app dies at load with
// `SyntaxError: Unexpected token 'export'`.
//
// That was a real defect, found by launching `out/` for the first time in
// Stage 5: every gate up to that point ran typecheck, lint, and vitest, none of
// which load the built bundle. `zod` is excluded for the same reason one layer
// down — the shared schemas import it, so bundling shared while externalizing
// zod would just move the unresolved `require` inside the bundle. The preload
// needs it too, and more urgently: a sandboxed preload has no node_modules
// resolution at all, so *any* runtime `require` of a non-Electron module throws
// `module not found` (measured). `src/preload/index.ts` therefore takes only
// type-only imports, and this exclusion is the second layer of that guarantee.
const WORKSPACE_DEPS = ['@gomentor/shared', '@gomentor/core', 'zod']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_DEPS })],
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
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_DEPS })],
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
