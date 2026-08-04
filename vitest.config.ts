import { defineConfig } from 'vitest/config'

// Root test config. vitest 3 uses `projects` here rather than the deprecated
// defineWorkspace in a separate vitest.workspace.ts.
export default defineConfig({
  test: {
    // Stage 1 has no test files yet; Stage 2 onward does. Without this the
    // toolchain gate can't go green on an empty tree.
    passWithNoTests: true,
    projects: [
      'packages/shared/vitest.config.ts',
      'packages/core/vitest.config.ts',
      'apps/desktop/vitest.config.ts',
    ],
  },
})
