# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

Strict TypeScript, no `any`, zod at every boundary. Two things carry disproportionate weight in this project:

1. **The preload boundary is a security boundary.** A leak there is a sandbox escape, not a bug.
2. **Some failures look like successes.** SGF unknown-property preservation, the GTP `I`-skip, the `safeStorage` fallback — each of these can be wrong while every test appears green. They get specific verification requirements below.

---

## Forbidden Patterns

**`any`.** Use `unknown` and narrow. `any` at a boundary defeats the reason zod is here.

**Non-null assertion (`!`) to silence the compiler.** If it can be null, handle it. `!` is permitted only where an invariant is enforced immediately above and commented.

**`electron` imported in `packages/core`.** Lint-enforced. Core must run under plain Node.

**`ipcMain.handle` or `webContents.send` called directly.** Always via `ipc/register.ts`'s `handle()` or `ipc/events.ts`'s `emit()`, or the channel loses schema validation and error-envelope mapping. Lint-enforced, exempting those two wrapper files.

> A former entry here — *"Raw IPC channel strings outside `ipc.ts`. Lint-enforced. Strings drift silently on rename."* — has been **withdrawn**. Stage 4 measured the premise and it is false: the wrappers are generic over `ChannelName`/`EventName`, so a mistyped channel is a TS2345 naming every valid channel. Inline channel literals at wrapper call sites are correct style; see `directory-structure.md` and the comment in `eslint.config.js`.

**Path construction outside `paths.ts`.** Scattered `path.join(app.getPath(...))` is how cross-platform path bugs enter.

**`catch {}` with no log and no state change.** Makes the failure invisible. If genuinely ignorable, log at `debug` and say why.

**Bare string throws, or `Error` without a `code`.** The caller can't branch, the UI can't translate, the test can't assert.

**Plaintext fallback when `safeStorage` is unavailable.** Refuse to persist instead. A silent downgrade is worse than a failure.

**Secrets, SGF content, chat text, or prompts in a log call.** See `logging-guidelines.md`.

**App code touching Trellis paths** (`.trellis/`, `.claude/`, `.codex/`, `.qoder/`, `.agents/`, `AGENTS.md`). CI asserts they're unmodified after a full build.

**Unbounded retries against a child process or a local model.** KataGo restarts trip a circuit breaker after 3; the local LLM gets zero retries.

---

## Required Patterns

**Zod validation at every boundary** — IPC payloads, settings files, LLM tool arguments, KB frontmatter. One schema language, and the TypeScript types are inferred from it rather than declared twice.

**Typed errors with a domain-prefixed `code`** (see `error-handling.md`).

**Expected absence modelled as a state enum**, not an exception. `EngineStatus` is `unavailable | downloading | starting | ready | failed`.

**Protocol separated from process.** `core/katago/` encodes and decodes; `main/katago/process.ts` spawns. Protocol correctness stays testable headless.

**Pure functions in `packages/core`.** Arguments in, values out. No global state, no I/O, no store reads.

**Immutable board positions.** `position.ts` returns a new position; mutation invites aliasing bugs across the move tree.

**`AbortSignal` threaded through anything cancellable** — LLM streams, engine queries, downloads.

---

## Testing Requirements

| Code | Requirement |
|---|---|
| `packages/core` | Unit tested. It's pure — there is no excuse not to be |
| `board/coords.ts` | **Property-based** (`fast-check`) over all points × all board sizes |
| `sgf/parser.ts` + `serializer.ts` | Round-trip over a **≥20-file real-world corpus** |
| `packages/shared/src/ipc.ts` | Every channel: 1 valid + ≥2 invalid, plus a **meta-test** asserting no channel lacks coverage |
| `main/katago/process.ts` | Integration against a **real spawned** GTP-speaking child process |
| IPC handlers | Integration via stubbed `ipcMain`, response validated against schema |
| `safe-storage.ts` | The unavailable path **refuses** rather than writing plaintext |
| `settings.ts` | Round-trip **plus unknown-key survival** |

### Verification that must not be satisfied superficially

These are the "wrong but looks right" cases. A green test run is not sufficient evidence:

- **SGF unknown properties** must survive **byte-for-byte**, verified against real files. A round-trip test over synthetic fixtures proves nothing about files in the wild.
- **The corpus must be real and ≥20 files.** Three synthetic fixtures passing is a failure, not a pass.
- **Coordinate tests must actually cross `I`.** A test that never exercises the GTP `I`-skip has not tested it.
- **Parsers must be asserted to terminate**, under a timeout — not merely to return the right error. But be clear about what a `{ timeout }` annotation buys: **vitest cannot interrupt synchronous code.** Measured — a test with `{ timeout: 500 }` that spins for 3s runs the full 3s and *then* fails at 3006ms. So the annotation is a post-hoc report on a loop that already finished, and against a genuine infinite sync loop it does not fail the run, it hangs the runner. Termination has to be structural: every parser loop carries a guard bounded by **input length**, so the bound is reachable and the failure is a typed error. A guard set to `Number.MAX_SAFE_INTEGER` is not a bound — 2^53 iterations outlives the process, so it presents as the hang it was meant to prevent. `sgf/parser.ts` had exactly that and was corrected. To actually verify termination, kill from outside the runner (`timeout 150 npx tsx …`).
- **Preload isolation must be asserted at runtime in the renderer** (`window.ipcRenderer` and `window.require` are `undefined`), not by reading preload source. Implemented in Stage 5 as `apps/desktop/test/e2e/preload-boundary.spec.ts`, which launches the built app under Playwright's Electron driver rather than constructing a `BrowserWindow` in-test — a hand-built window proves only that the test set the flags, so it asserts the real `webPreferences` via `webContents.getLastWebPreferences()` (undocumented internal API; returns `null` until a navigation has committed, so await the page first). Two findings from that suite are worth carrying forward. **`Object.freeze` in the preload is not what makes the bridge immutable**: a mutation removing it left all six tests green, and measuring with a deliberately unfrozen export showed why — `contextBridge` builds its own frozen mirror in the page realm, so the page sees `Object.isFrozen === true` regardless. That survivor was a comment over-attributing a guarantee, not a coverage gap; keep the freeze, but do not claim it. **`contextBridge` also strips an Error's own properties** — a thrown `AppError` arrives in the page as a plain `Error` with `code` and `context` `undefined` and only `message` intact — so the `IpcResult` envelope must stay a union all the way in and must not be unwrapped into a throw at the preload. `register.ts` asserted the opposite before it was tested.
- **Redaction must be tested with a key-shaped value**, not assumed from the code.
- **A meta-test must be shown to fail** when a channel is added without coverage. A vacuously-passing meta-test is worse than none.
- **A measuring instrument must be shown to fail too.** The rule above applies to anything that reports on the tests, not just to tests. A mutation harness whose test filter matches nothing gets a green run for every mutation and reports `0 escaped` — the most reassuring possible output from an instrument measuring nothing. Every harness in `scripts/` therefore gates on its own baseline (`total <= 0 || failed > 0` ⇒ refuse to report) and treats an anchor matching ≠1 site as a failure rather than a skip. Both guards have fired on real mistakes; keep them in any new harness.
- **Path filters passed to vitest resolve against the project root, not the repo root.** `npx vitest run --project core packages/core/test/foo.test.ts` matches zero files and exits 0; the filter must be `test/foo.test.ts`. This is the specific mistake the baseline gate above caught, and it is silent without it — note that it contradicts the natural reading of "always run from the repository root" below, which governs the *cwd*, not the filter.
- **An unkillable mutation must be removed from the harness, not recorded as escaped.** Code that is provably dead cannot be covered by any test, so listing a mutation on it inflates the denominator with a check the suite cannot make. Mutate the premise that makes it dead instead (`mutate-coord-error.mts`'s `Z1` shrinks the zobrist key table), and say in the source comment that the dead branch is enforced by review rather than by tests.
- **Packaged builds must be unpacked** to confirm dependencies are present. An `.npmrc` hoist misconfig silently omits deps and `pnpm dev` does not catch it.
- **The built bundle must be launched, not just built.** `electron-vite build` succeeding says nothing about whether `out/main/index.js` can be loaded, and typecheck, lint, and vitest all run against source — none of them loads the bundle. Measured in Stage 5: the app had a green gate four stages running while `out/` died instantly at `packages/shared/src/index.ts:5` with `SyntaxError: Unexpected token 'export'`, because `externalizeDepsPlugin()` had left the workspace packages as runtime `require()`s out of a CJS bundle and Node resolved them to uncompiled `.ts`. Note this is *not* the same hole as the `.npmrc` one above and is not caught by the same check: here the dependency is present, it is the module format that is wrong, and `pnpm dev` does not catch it either — dev serves the renderer through Vite and does not exercise the production main bundle. The `e2e` script therefore builds before it tests (`electron-vite build && playwright test`) rather than trusting whatever is in `out/`; a stale bundle turns every assertion below into a statement about the previous commit. Cheap standing check on the preload, whose sandbox has no module resolution at all: `grep -o 'require("[^"]*")' out/preload/index.js` must print only `require("electron")`.

---

## Running tests

Always run from the **repository root**, never `cd` into a package:

```bash
pnpm test                          # all projects
npx vitest run --project core      # one project
npx vitest run --project shared
npx vitest run --project desktop
pnpm e2e                           # Playwright; builds `out/` first, then drives the real app
pnpm lint
pnpm typecheck
pnpm format:check
```

`pnpm e2e` is separate from `pnpm test` deliberately: it needs a build and a real
Electron process, so it is seconds rather than milliseconds and cannot run in a
vitest worker. It is not optional at a stage gate — see "the built bundle must be
launched" above.

One cwd trap specific to the build: `electron.vite.config.ts` resolves its entry
points with `resolve('src/main/index.ts')`, which is **cwd-relative**. Running
`electron-vite build` from the repo root fails with "An entry point is required
in the electron vite main config"; go through the package script
(`pnpm --filter @gomentor/desktop build`, or root `pnpm build`) so pnpm sets the
cwd. This is the same class of bug as the vitest path filter above.

`cd <pkg> && npx vitest ...` works but is worse for two reasons: it does not
match the permission allowlist in `.claude/settings.json` (so an agent hits the
approval path on every iteration), and running one package in isolation hides
cross-package breakage — `--project core` still resolves `@gomentor/shared`
through the workspace, so a contract change that breaks a consumer shows up.

---

## Code Review Checklist

- [ ] No `any`, no `!` used to silence the compiler
- [ ] Every new IPC channel has a schema **and** a test (meta-test will catch omissions)
- [ ] Errors carry a domain-prefixed `code`; no bare throws
- [ ] No `cause` or stack trace sent to the renderer
- [ ] Expected absence is a state, not an exception
- [ ] No secrets, SGF, chat text, or prompts reachable by a log call
- [ ] Paths come from `paths.ts`
- [ ] `packages/core` additions are pure and Electron-free
- [ ] The built bundle was launched, not just built — `pnpm e2e` green
- [ ] Cancellable work threads an `AbortSignal`
- [ ] Trellis-managed paths untouched
- [ ] Tests satisfy the substance above, not just the shape
