import { defineConfig } from 'vitest/config'

/**
 * Tests for repo tooling — the gate scripts in `scripts/`.
 *
 * A separate project rather than folding these into `packages/shared`, because
 * `shared` is contracts-only (`directory-structure.md`) and a test there importing
 * `../../../scripts/` would reach across a package boundary that the spec draws
 * deliberately. The scripts are not part of any published package; they are build
 * infrastructure, and their tests belong with them.
 *
 * Node environment: these are CLI programs, not renderer code.
 */
export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['test/*.test.ts'],
  },
})
