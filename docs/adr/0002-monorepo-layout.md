# ADR 0002: Monorepo layout — pnpm workspace

**Status**: Accepted
**Date**: 2026-08-04

## Context

GoMentor needs to ship an Electron desktop app, and eventually a marketing and
documentation website. Both want to reason about the same domain concepts: SGF
game records, board positions, coordinate systems, KataGo analysis payloads.

The obvious starting point is a single package — one `package.json`, all code
under `src/`. The question is whether that holds up.

## Decision

**pnpm workspace with four members**, kept deliberately shallow:

```
apps/desktop        Electron app
apps/web            Astro site (M5)
packages/shared     IPC contract + domain types. zod only.
packages/core       Pure domain logic. Electron-free.
```

No deeper nesting. No `packages/utils`.

## Rationale

Three genuinely separate build targets exist, with different runtime
environments (Electron main/renderer, Node, browser) and different build tools
(electron-vite, Astro). Forcing them into one package means one build config
serving three incompatible targets.

The decisive factor is **`packages/core` being Electron-free**. That property
buys two things a single package cannot:

1. **Domain logic tests headless.** SGF parsing, board rules, and coordinate
   conversions run under plain vitest with no Electron process. These are the
   most test-dense parts of the codebase and the most bug-prone (every
   historical Go software bug lives in coordinate conversion).
2. **The website can reuse it.** Interactive board demos on the docs site want
   the same SGF parser and board renderer logic as the app.

This is enforced by an ESLint `no-restricted-imports` rule, not by convention —
a convention that only holds when everyone remembers is not a boundary.

`packages/shared` is separate from `packages/core` because the IPC contract has
a different dependency profile: zod and nothing else. It is imported by all
three processes, so keeping it dependency-light matters.

## Alternatives considered

**Single package.** Simpler, and correct for a smaller app. Rejected because it
makes the Electron-free property of the domain logic unenforceable — everything
would have Electron in scope.

**Deeper workspace** (`packages/{sgf,board,katago,llm,kb,profile}`). Rejected:
these are cohesive parts of one domain model that change together. Six packages
with six `package.json` files and six version numbers is ceremony without
benefit at this size. They live as directories inside `packages/core`.

## Consequences

- Root `package.json` is a script façade; real work happens in workspace members
- `pnpm -r` and `-F` filters drive per-package commands
- Path aliases (`@gomentor/shared`, `@gomentor/core`) are declared in three
  places that must stay consistent: `tsconfig.base.json`,
  `electron.vite.config.ts`, and each `vitest.config.ts`
- `.npmrc` needs hoist settings for electron-builder to resolve dependencies
  when packaging — a known friction point between pnpm's strict linking and
  electron-builder's expectations
- Adding a workspace member means touching `pnpm-workspace.yaml`,
  `vitest.config.ts` projects, and the tsconfig path map
