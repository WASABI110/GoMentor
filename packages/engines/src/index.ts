/**
 * Public surface of the engines package. Two modules, one authority each:
 *
 * - `katago-manifest.ts` pins WHICH engine/net bytes exist (version, per-
 *   platform assets, measured sizes, TOFU checksum sidecar) — the single
 *   source of truth the CLI, the CI workflows, the packager docs, and the
 *   app's GPU-download flow all read.
 * - `fetch-engine.ts` is HOW those bytes arrive: verified, resumable,
 *   checksum-gated download + extraction. It is pure Node — no electron, no
 *   app state — so the same pipeline serves `pnpm fetch:katago`, the CI
 *   matrix, and (since M5 Stage 4) the in-app GPU download service.
 *
 * ## Why this is a package and not scripts/
 *
 * The desktop main process needs the same pipeline the CLI uses, and a
 * cross-tree relative import into `scripts/` fights the desktop package's
 * CJS TypeScript settings (import.meta, rootDir) — measured, reverted, and
 * recorded in the M5 task's implement.md. A workspace package is the
 * structure the monorepo already has for exactly this: shared source, no
 * build step, aliased into the electron-vite bundle like shared and core.
 */
export * from './katago-manifest'
export * from './fetch-engine'
