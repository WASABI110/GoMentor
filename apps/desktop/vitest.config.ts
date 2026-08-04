import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // e2e runs under Playwright, not vitest.
    exclude: ['test/e2e/**'],
  },
  resolve: {
    alias: {
      '@gomentor/shared': resolve('../../packages/shared/src'),
      '@gomentor/core': resolve('../../packages/core/src'),
      '@main': resolve('src/main'),
    },
  },
})
