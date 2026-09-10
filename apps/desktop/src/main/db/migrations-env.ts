/**
 * Migrations are authored as `.sql` files and inlined into the bundle at
 * build time via vite's `?raw` suffix. This module is what lets TypeScript see
 * that import.
 *
 * It is a global script (no imports or exports) so the `declare module` is an
 * ambient declaration, and `migrate.ts` imports it for its side effect — that
 * is what makes it visible to *every* tsconfig project that transitively
 * compiles `migrate.ts` (the test project does not include `src/main/**` and
 * would otherwise report TS2307 on the `?raw` import). At runtime it compiles
 * to an empty module.
 */

declare module '*.sql?raw' {
  const sql: string
  export default sql
}
