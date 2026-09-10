import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // e2e runs under Playwright, not vitest.
    exclude: ['test/e2e/**'],
    // Runs before any test file imports the DB-backed store, so the
    // better-sqlite3 binding matches plain Node even right after a `pnpm e2e`
    // swapped it to the Electron ABI. See the setup file for the full story.
    globalSetup: ['test/ensure-node-sqlite.setup.ts'],
  },
  // No `resolve.alias` for `@gomentor/*`. There was one, built with
  // `resolve('../../packages/shared/src')` — but `resolve` is relative to the
  // *process cwd*, and tests run from the repository root
  // (`quality-guidelines.md` §Running tests), so it pointed at a path outside
  // the repo and every import failed. The pnpm workspace already symlinks these
  // into `node_modules/@gomentor/`, and each package's `exports` map covers the
  // subpath imports (`@gomentor/core/sgf/parser`), so normal resolution is both
  // correct and cwd-independent. `packages/core` and `packages/shared` rely on
  // exactly this and always have.
})
