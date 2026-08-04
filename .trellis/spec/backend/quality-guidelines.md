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

**Raw IPC channel strings outside `packages/shared/src/ipc.ts`.** Lint-enforced. Strings drift silently on rename.

**`ipcMain.handle` called directly.** Always via `ipc/register.ts`'s `handle()` wrapper, or the channel loses schema validation.

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
- **Parsers must be asserted to terminate**, under a timeout — not merely to return the right error.
- **Preload isolation must be asserted at runtime in the renderer** (`window.ipcRenderer` and `window.require` are `undefined`), not by reading preload source.
- **Redaction must be tested with a key-shaped value**, not assumed from the code.
- **A meta-test must be shown to fail** when a channel is added without coverage. A vacuously-passing meta-test is worse than none.
- **Packaged builds must be unpacked** to confirm dependencies are present. An `.npmrc` hoist misconfig silently omits deps and `pnpm dev` does not catch it.

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
- [ ] Cancellable work threads an `AbortSignal`
- [ ] Trellis-managed paths untouched
- [ ] Tests satisfy the substance above, not just the shape
