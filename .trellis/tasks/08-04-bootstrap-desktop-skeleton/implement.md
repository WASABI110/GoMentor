# Implement: GoMentor Desktop Skeleton (M1)

Execution plan. Requirement IDs (R1–R11), acceptance IDs (A1–A15), and decision IDs (D1–D9) reference `prd.md`; architecture reference is `design.md`.

## Ordering rationale

Toolchain first, contracts second, pure logic third, UI last. The reasoning: M1's biggest risk is electron-vite + pnpm + electron-builder agreeing on Windows (`prd.md` §Technical notes), so it must be discovered in step 1, not step 6. Pure logic (`packages/core`) precedes UI because it is testable without Electron running, so a broken app shell never blocks logic verification.

## Gate protocol (D10)

Every stage gate below runs the same three steps in order:

1. **`trellis-check`** — built-in agent. Reviews the diff against prd/design/spec, **self-fixes**, runs typecheck + lint.
2. **`gomentor-verify`** — added agent, **read-only** (`Read, Bash, Glob, Grep`; no Write/Edit). Runs the test suite and the stage's acceptance IDs, reports `PASS | FAIL | NOT-APPLICABLE-YET` per ID with command output or file:line as evidence.
3. **Main session acts on FAILs** — dispatch more implementation, or amend `prd.md` explicitly if a criterion itself is wrong. Never lower the bar inside the verifier.

Verify runs *after* check so it judges the post-fix state. A FAIL blocks the stage. Rationale for the split and for read-only: `design.md` §Delivery verification.

Each gate lists only the acceptance IDs its stage can satisfy. The **full A1–A15 sweep runs at the Stage 7 gate**.

## Stage 1 — Workspace and toolchain (R1, R2)

Highest-risk stage. Do not proceed to stage 2 until `pnpm dev` opens a blank window on Windows.

- [ ] `package.json` (root) — `packageManager` pin, workspace scripts façade, shared devDeps
- [ ] `pnpm-workspace.yaml` — declare `apps/*`, `packages/*`
- [ ] `.npmrc` — `node-linker` + hoist patterns electron-builder requires to see deps
- [ ] `tsconfig.base.json` — strict options, `@gomentor/*` aliases, **exclude all six Trellis paths (R2)**
- [ ] `eslint.config.js` — flat config, **ignore all six Trellis paths (R2)**, `no-restricted-imports` barring `electron` from `packages/core`
- [ ] `.prettierrc.json`, `.editorconfig`, `.nvmrc`
- [ ] `.gitignore` — `resources/katago`, `resources/weights`, `dist`, `out`, `node_modules`
- [ ] `.gitattributes` — app rules appended **below** the existing Trellis `merge=union` block (R2)
- [ ] `vitest.workspace.ts` — aggregate per-package projects
- [ ] `LICENSE` — **GPL-3.0 full text (D4)**
- [ ] `NOTICE` — third-party attribution; the license-provenance ledger going forward
- [ ] `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
- [ ] `apps/desktop/package.json`, `electron.vite.config.ts` (three targets), `electron-builder.yml`
- [ ] `apps/desktop/tsconfig.json` + `tsconfig.node.json` + `tsconfig.web.json` (solution-style)
- [ ] `packages/{shared,core}/package.json`, `packages/tsconfig/`
- [ ] `apps/web/` placeholder (Astro config only, no content — M5 fills it)

**Gate**: `pnpm install && pnpm dev` opens a blank Electron window on Windows. `pnpm lint`, `pnpm typecheck`, `pnpm test` (zero tests) all exit 0.

**Verify (stage-scoped)**: R2 guard clean (`git diff --exit-code` on all six Trellis paths). `LICENSE` is GPL-3.0 full text, not a placeholder (D4). `packages/core` has no `electron` import and the lint rule that forbids it actually fires when tested. Confirm `apps/web` is a placeholder only — a verifier should not pass a stage because an unbuilt package looks empty.

## Stage 2 — Shared contracts (R4)

- [ ] `packages/shared/src/types/{game,analysis,chat,settings}.ts` — domain types; `analysis.ts` includes the `EngineStatus` enum now (`design.md` §Compatibility) so M2 is additive
- [ ] `packages/shared/src/constants.ts` — board sizes, default visits, app id
- [ ] `packages/shared/src/ipc.ts` — **the single contract**: 11 channels + 5 events with zod schemas
- [ ] `packages/shared/test/ipc.test.ts` — table-driven valid/invalid + **meta-test asserting no channel lacks coverage** (A9)

**Gate**: A9 passes. Adding a channel without a test now fails CI.

**Verify (stage-scoped)**: **A9**. Specifically confirm the meta-test genuinely fails when a channel is added without coverage — verify by temporarily adding a dummy channel and observing the failure, not by reading the test source. A meta-test that passes vacuously is worse than none.

## Stage 3 — Core pure logic (R5, R6 partial, R7)

No Electron dependency in this stage. Fully testable headless.

- [ ] `packages/core/src/board/coords.ts` — internal ↔ SGF ↔ GTP (**skip `I`**) ↔ pixel converters
- [ ] `packages/core/test/board/coords.test.ts` — **property-based (`fast-check`)**, all points × all sizes (A7)
- [ ] `packages/core/src/board/position.ts` — immutable position: place, capture resolution, ko
- [ ] `packages/core/src/board/rules.ts` — legality (suicide, ko), scoring primitives
- [ ] `packages/core/test/board/rules.test.ts` — hand-built positions: capture, suicide, ko, multi-group
- [ ] `packages/core/src/board/zobrist.ts` — hashing (M3's pattern index needs it; cheap to land now)
- [ ] `packages/core/src/sgf/ast.ts` — `GameTree` with stable node ids, parent/child links, unknown-prop passthrough bag
- [ ] `packages/core/src/sgf/parser.ts` — hand-written tokeniser (see PRD library table, amended Stage 3), assign ids, typed errors (A6)
- [ ] `packages/core/src/sgf/props.ts` — zod-validated property accessors
- [ ] `packages/core/src/sgf/serializer.ts` — correct escaping, **re-emit unknown props verbatim**
- [ ] `packages/core/test/sgf/round-trip.test.ts` + `test/fixtures/sgf/` — **≥20 real-world files**: pro games, Fox exports, variations, CJK comments, escaped `]`, unknown props, truncated, empty, non-SGF binary (A5, A6)
- [ ] `packages/core/src/llm/provider.ts` — `LLMProvider` interface, `ChatRequest`/`ChatChunk`, capability types
- [ ] `packages/core/src/llm/openai-compatible.ts` — the one implementation; streaming, tool-call accumulation, abort
- [ ] `packages/core/src/llm/cloud.ts` — short timeout, 2 retries
- [ ] `packages/core/src/llm/local.ts` — long timeout, **zero retries** (`design.md` §LLM provider)
- [ ] `packages/core/src/llm/probe.ts` — `probeCapabilities`: trivial tool call, record whether tools actually work
- [ ] `packages/core/test/llm/provider.test.ts` — **mock HTTP server**; assert chunk assembly *order*, tool-call fragment accumulation across chunks, prompt abort, typed 429/500 — both factories (A8)
- [ ] `packages/core/src/llm/prompts/teacher.ts` — locale-aware system-prompt composition
- [ ] `packages/core/src/katago/gtp.ts` — pure GTP encoder/decoder, no process management
- [ ] `packages/core/src/katago/analysis.ts` — analysis-mode JSON request builders / response parsers
- [ ] `packages/core/src/katago/commands.ts` — command constants

**Gate**: A5, A6, A7, A8 all pass. `packages/core` has zero Electron imports (lint-enforced).

**Verify (stage-scoped)**: **A5, A6, A7, A8** — the highest-value gate in M1, because these are the "wrong but looks right" failure modes (`design.md` §Delivery verification). Required evidence, not just a green run:
- **A5**: count the fixture corpus (**≥20 real files, FAIL if synthetic-only**) and confirm unknown properties survive **byte-for-byte**, not merely "a round-trip test passes"
- **A6**: truncated / empty / non-SGF-binary each produce a *distinct typed* error and **no case hangs** (assert under a timeout)
- **A7**: property-based test actually covers all board sizes, and the **GTP `I`-skip** is exercised — a coords test that never crosses `I` is a FAIL on A7
- **A8**: chunk assembly **order**, tool-call fragments accumulating across chunk boundaries, mid-stream abort, and typed 429/500 — for **both** cloud and local factories (local must show zero retries, cloud two)

## Stage 4 — Main process (R3, R8)

- [ ] `src/main/paths.ts` — **single source of truth** for all paths (`design.md` §Operational)
- [ ] `src/main/logger.ts` — `electron-log`, structured fields, **secret-redaction serializer**
- [ ] `src/main/safe-storage.ts` — encrypt/decrypt/has; **refuse to persist when `isEncryptionAvailable()` is false**, memory-only + UI warning
- [ ] `src/main/settings.ts` — zod-validated, migration-safe defaults, **unknown keys survive load→save**
- [ ] `src/main/window.ts` — hardened `webPreferences` (`contextIsolation`, `sandbox`, no `nodeIntegration`), bounds persistence with on-screen validity check
- [ ] `src/main/menu.ts` — i18n-aware native menu, **"Reveal logs" item**
- [ ] `src/main/telemetry.ts` — **no-op stub**, no network call; stable call sites for M5
- [ ] `src/main/ipc/register.ts` — `handle()` wrapper: request validation always, response validation dev-only, typed error envelope
- [ ] `src/main/ipc/sgf.handlers.ts`, `library.handlers.ts` (in-memory store), `settings.handlers.ts`
- [ ] `src/main/llm/service.ts` — owns provider instance, health check, `runId` issuance, stream fan-out to renderer
- [ ] `src/main/ipc/llm.handlers.ts` — `sendMessage` returns `{ runId }`; `cancel` aborts
- [ ] `src/main/index.ts` — **single-instance lock**, lifecycle, IPC registration, window creation
- [ ] `apps/desktop/test/unit/safe-storage.test.ts` — mocked `safeStorage`; assert unavailable path refuses rather than writing plaintext (A10)
- [ ] `apps/desktop/test/unit/settings.test.ts` — round-trip + unknown-key survival
- [ ] `apps/desktop/test/integration/handlers.test.ts` — stubbed `ipcMain`, every channel, response validated against schema

**Gate**: handlers integration test passes; no schema/handler drift.

**Verify (stage-scoped)**: **A10 (partial — unit half)**. Confirm the `safeStorage`-unavailable path **refuses to persist** rather than falling back to plaintext, and that the logger's redaction serializer actually redacts (test with a key-shaped value, don't just read the code). Confirm unknown settings keys survive a load→save cycle. Also confirm `telemetry.ts` makes **no network call** in its no-op state — a stub that quietly phones home would violate `design.md` §Operational.

## Stage 5 — Preload (R3)

- [ ] `src/preload/index.ts` — one **frozen** object via `contextBridge`; `invoke` methods + `on*` registrars returning unsubscribe fns; **no `ipcRenderer` leak**
- [ ] `src/preload/api.d.ts` — global `Window` augmentation

**Gate**: renderer has full type safety on `window.gomentor`; no Node API reachable from the page.

**Verify (stage-scoped)**: treat this as a **security boundary**, not a typing check. Confirm `window.ipcRenderer` and `window.require` are genuinely `undefined` **at runtime in the renderer** (assert in the app, not by reading preload source), that the exposed object is frozen, and that `contextIsolation`/`sandbox` are on with `nodeIntegration` off in the actual `webPreferences`. A preload leak is a sandbox escape (`implement.md` §Risky files).

## Stage 6 — Renderer (R6, R9, R10)

- [ ] `src/renderer/index.html` — **strict CSP meta tag**
- [ ] `src/renderer/src/i18n/index.ts` + `locales/{zh-CN,en}/{common,board,teacher,settings,errors}.json` (R10)
- [ ] `src/renderer/src/state/{gameStore,chatStore,settingsStore,libraryStore}.ts` — zustand
- [ ] `src/renderer/src/hooks/useIpcEvent.ts` — typed subscription hook
- [ ] `src/renderer/src/main.tsx` — React root: i18n, theme, error boundary
- [ ] `src/renderer/src/App.tsx` — three-panel resizable shell, **layout persisted** (A2)
- [ ] `src/renderer/src/components/Board.tsx` — **two canvases** (static/dynamic), DPR-aware, click/hover, ≤120ms cancellable+skippable animations (A3, A4)
- [ ] `src/renderer/src/components/BoardOverlay.tsx` — overlay layer scaffold (M2 fills it)
- [ ] `src/renderer/src/components/GameList.tsx` — list + drag-drop import target (A3)
- [ ] `src/renderer/src/components/MoveTree.tsx` — linear nav in M1; arrow-key stepping (A4)
- [ ] `src/renderer/src/components/TeacherChat.tsx` — streaming, cancel, markdown, legible errors (A11)
- [ ] `src/renderer/src/components/EngineStatus.tsx` — badge; reads `unavailable` in M1 (A13)
- [ ] `src/renderer/src/panels/SettingsPanel.tsx` — provider config + key entry (A10)
- [ ] `src/renderer/src/components/ui/` — minimal primitives
- [ ] `src/renderer/src/styles/` — theme tokens

**Gate**: A1–A4, A11–A13 pass by manual smoke.

**Verify (stage-scoped)**: **A1, A2, A3, A4, A11, A12, A13**. Board correctness (A3) needs checking against a **known reference position at all three sizes** (19×19, 13×13, 9×9) — "it renders" is not "it renders correctly", and an off-by-one in `coords.ts` looks fine until you compare stone placement. A12 must be checked by switching locales **in the running app**, not by diffing JSON key sets (the CI gate already does that). A13 requires the badge to read `unavailable` **and** every other feature to still work — a disabled app would trivially satisfy the badge half.

## Stage 7 — CI, packaging, docs (R11)

- [ ] `apps/desktop/build/` — icons, `entitlements.mac.plist`, installer assets
- [ ] `apps/desktop/test/integration/fake-katago.ts` — **real spawned child** speaking GTP (M2 uses it; land the harness now)
- [ ] `apps/desktop/test/e2e/smoke.spec.ts` — Playwright `_electron`: launch, three panels, mocked chat reply
- [ ] `scripts/fetch-katago.ts`, `scripts/fetch-weights.ts` — **stubs** with a clear "M2" message
- [ ] `scripts/check-licenses.ts` — fail on any dep incompatible with GPL-3.0 (D4)
- [ ] `scripts/check-i18n.ts` — fail on keys missing relative to `en` (A12)
- [ ] `.github/workflows/ci.yml` — 3-OS × Node 22: install → lint → typecheck → test+coverage → package unsigned → artifacts; **plus lockfile drift, license gate, i18n gate, and the R2 Trellis-immutability guard** (A14, A15)
- [ ] `docs/architecture.md` — living version of `design.md`
- [ ] `docs/ipc-contract.md` — channel reference, checked against `ipc.ts`
- [ ] `docs/adr/0001-license.md` — record D4 and its reasoning
- [ ] `docs/adr/0002-monorepo-layout.md` — record D3
- [ ] `docs/adr/0003-tiered-installer.md` — record D6
- [ ] `docs/adr/0004-two-agent-verification.md` — record **D10**: why `gomentor-verify` is separate from `trellis-check` and why it is read-only
- [ ] `.claude/agents/gomentor-verify.md` — **the verification agent definition (D10)**. Tools: `Read, Bash, Glob, Grep` — **no `Write`, no `Edit`** (read-only is load-bearing, `design.md` §Delivery verification). Its prompt must encode the verdict discipline: per-acceptance-ID `PASS | FAIL | NOT-APPLICABLE-YET` with command output or file:line evidence; an untestable criterion is `NOT-APPLICABLE-YET`, **never** `PASS`; "tests pass" is not evidence a criterion is met. *(Note: this file sits under `.claude/`, which R2 declares immutable to **app code and CI**. Authoring an agent definition is a human/agent workflow action, not app code, so it is permitted — but it must be added **outside** any Trellis-managed block, and the R2 CI guard must be run after adding it to confirm it still passes.)*

**Gate**: A14, A15 pass. e2e non-blocking for two weeks, then required (`design.md` §Verification).

**Verify (final — full sweep)**: **all of A1–A15**, including re-confirming earlier stages' IDs against the final integrated state (a Stage 3 PASS can regress by Stage 6). Plus: A14 requires CI green on **all three OS** with the R2 guard, license gate, i18n gate, and lockfile-drift check all actually running — not merely present in the YAML. A15 requires **unpacking a packaged installer** and confirming dependencies are present, since an `.npmrc` hoist misconfig silently omits deps and a successful `pnpm dev` does not catch it (`implement.md` §Risky files). Report FAILs to the main session; do not fix them.

## Validation commands

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test --coverage
pnpm -F @gomentor/desktop package      # unsigned in M1
pnpm e2e                               # non-blocking initially
pnpm dev                               # manual smoke

# R2 guard — must print nothing
git diff --exit-code -- .trellis .claude .codex .qoder .agents AGENTS.md
```

## Risky files and rollback points

| File | Risk | Mitigation |
|---|---|---|
| `apps/desktop/electron.vite.config.ts` | Three-target build wiring gates everything downstream | Stage 1 gate exists precisely to fail here early |
| `.npmrc` | Wrong hoist config → electron-builder silently omits deps from the package | Verify by unpacking a packaged build, not by a successful `dev` run |
| `packages/shared/src/ipc.ts` | Every process depends on it; a late reshape ripples through all three | Land in stage 2, before any consumer exists |
| `packages/core/src/sgf/parser.ts` | Data foundation for board, library, analysis, and (M2+) profile | ≥20-file corpus with round-trip + unknown-prop assertions |
| `packages/core/src/board/coords.ts` | Every historical Go bug lives here | Property-based tests over all points × all sizes |
| `src/main/safe-storage.ts` | A wrong fallback writes user API keys in plaintext | Explicit test that the unavailable path *refuses*; grep logs in smoke (A10) |
| `src/preload/index.ts` | An `ipcRenderer` leak is a sandbox escape | Frozen object, no raw handle exposed; review as a security boundary |
| `electron-builder.yml` | `extraResources` misconfig breaks M2's engine bundling | Land the structure now even though `resources/katago` is empty |

**Rollback**: M1 introduces no persistent schema (no SQLite — `design.md` §Compatibility), so rollback is uninstall/reinstall. Per-stage gates are the real rollback points: each stage leaves the tree in a lint-clean, test-passing state.

## Follow-up before `task.py start`

- [x] Curate `implement.jsonl` and `check.jsonl` with real entries — **required ready gate** for sub-agent-dispatch platforms (`.trellis/workflow.md:424`); the seed `_example` row does not count. *(Done: 8 and 7 entries respectively, seed rows removed, all referenced files verified to exist.)*
- [x] Populate `.trellis/spec/` — **empty spec means sub-agents write generic code** instead of code matching this project's conventions. *(Done: 4 backend + 2 frontend guides + both indexes. `backend/database-guidelines.md` deferred to M2 — no persistence in M1. The 4 remaining frontend guides deferred to Stage 6, to be written from real renderer code rather than invented up front.)*
- [ ] Declare workspace packages in `.trellis/config.yaml` so `get_context.py --mode packages` resolves spec layers
- [ ] Confirm the `GoMentor` name (D7) before it is baked deeper — already in `package.json`, `appId`, and `electron-builder.yml` as of Stage 1, so changing it now means a rename sweep
- [ ] Obtain ≥20 real-world SGF fixtures, including genuine Fox exports (A5 cannot be satisfied with synthetic files alone) — **blocks Stage 3's gate**
- [ ] Have at least one LLM endpoint reachable for manual smoke (A11) — either a cloud key or the local 4090 server running — **blocks Stage 6's gate**

## Carried risk out of Stage 1

- **`.npmrc` hoist config is unverified.** `node-linker=hoisted` plus the `*electron*`/`*builder*` patterns are configured, but a hoist misconfig silently omits dependencies from a packaged build and `pnpm dev` does not catch it. Verification requires unpacking a packaged build (A15, Stage 7). This is the largest unverified toolchain risk carried forward; `pnpm package:dir` is the cheap early check if it is worth de-risking sooner.
- **A13's engine badge is currently a hardcoded string** (`App.tsx`), not the `EngineStatus` enum driving a component. Stage 2 lands the enum, Stage 6 the badge. Flagged so it is not mistaken for done at the Stage 6 gate.
- **A1 passed only partially.** The renderer process starts and the dev server returns 200, but "no console errors or unhandled rejections" and the <5s budget are untested — both need the Stage 7 Playwright `_electron` harness.
