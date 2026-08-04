# PRD: Bootstrap GoMentor Desktop Skeleton (M1)

## Goal and user value

Stand up the first demoable vertical slice of **GoMentor** — a desktop Go (围棋) AI learning platform that unifies traditional KataGo review with an LLM coaching layer.

After M1, a user can: launch the app, drag in an SGF file, see the game render on a real goban, step through moves, configure an LLM provider (cloud API or local 4090 server), and ask the AI teacher a question and get a streamed answer.

M1 deliberately excludes KataGo. The engine badge reads `unavailable` and the app stays fully usable. This proves the whole vertical (board + library + teacher + settings + IPC + packaging) works before adding the highest-risk runtime component.

## Background and confirmed facts

### Working directory state

`e:\Workspace\Go` contains **only** Trellis scaffolding — no application code:

- `.trellis/` (workflow state, empty `spec/{backend,frontend,guides}`), `.claude/`, `.codex/`, `.qoder/`, `.agents/`, `AGENTS.md`, `.gitattributes`
- A `trellis init`-generated bootstrap task exists at `.trellis/tasks/00-bootstrap-guidelines/` for populating `.trellis/spec/`
- Trellis v0.6.12, initialized for claude/codex/qoder platforms, developer identity `anon`
- Claude Code is a **sub-agent-dispatch** platform, so `implement.jsonl` and `check.jsonl` need real entries before `task.py start` (`.trellis/workflow.md:424`)

### Reference repositories (design inspiration, not code source)

Both by the same author (wimi321), created 17 days apart, sharing [goagent.top](https://goagent.top) and infrastructure (KataGo, Fox game fetching, Zhizi Cloud). Neither README cross-references the other.

| | lizzieyzy-next | GoAgent |
|---|---|---|
| Role | Traditional KataGo review GUI | AI-agent learning workbench |
| Ancestry | Fork of `yzyray/lizzieyzy` | Original |
| Stack | Java + Maven | TypeScript + Electron + React |
| License | **GPL-3.0** (inherited) | MIT |
| Stars / size | 83★ / 161MB (bundles binaries) | 28★ / 16MB (source only) |
| AI layer | KataGo only | KataGo + multimodal LLM, tool-calling |
| Unique | Fox sync, readboard, winrate graph, backend packaging | Three-panel UI, local KB, student profile |

Neither project has student-profile-driven coaching as a shipped, validated feature. That is GoMentor's actual differentiator (M4).

### Environment

Node v24.18.0, npm 11.16.0, Python 3.12.10, Windows 11 Pro. Windows-first, cross-platform-clean.

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | New independent project, not a fork of either repo | Neither codebase is the right base: one is Java, the other lacks the coaching layer |
| D2 | TypeScript + Electron + React + pnpm + electron-vite | Reuses GoAgent's proven three-process pattern; mature ecosystem for LLM/KataGo integration |
| D3 | pnpm workspace monorepo: `apps/{desktop,web}` + `packages/{shared,core}` | Three genuinely separate build targets; `packages/core` importable by app, website demos, and tests |
| D4 | **GPL-3.0** | Any file/asset derived from lizzieyzy-next (GPL-3.0) makes GPL mandatory; MIT→GPL relicensing later needs every contributor's consent. GPL absorbs GoAgent's MIT one-way. Cost: forecloses proprietary fork — acceptable. AGPL rejected: desktop app, §13 buys nothing |
| D5 | LLM **required**, dual provider via one OpenAI-compatible adapter | Cloud API key and local 4090 server differ only in `baseUrl`/`apiKey`. Single `LLMProvider` interface, two thin factories |
| D6 | **Tiered installer**, not a single 500MB bundle | ~120MB core (Eigen CPU backend + one small net) is analysis-capable offline on first launch — zero-config held literally. GPU users prompted to fetch their one backend (~180MB, ~40x faster). Full offline bundle as separate release asset for restricted networks. Median download −70%, auto-update blockmaps stay small |
| D7 | Working name **GoMentor** (`gomentor`, 围棋导师) | "Mentor" signals the coaching core; pronounceable in all six target locales |
| D8 | KataGo **analysis mode** primary, GTP secondary | Analysis mode returns winrate + score lead + ownership + PV in one response with concurrent id correlation; GTP kept for third-party engines, play-vs-engine, and test fakes |
| D9 | LLM agent loop lives in **main process** | Tools need DB/engine/filesystem access; a renderer reload must not orphan an in-flight multi-step run |
| D10 | **Independent read-only verification agent** (`gomentor-verify`) at every stage gate, alongside built-in `trellis-check` | `trellis-check` verifies *conformance* (specs, conventions) and **self-fixes**, running only typecheck + lint. It does not run tests, the app, or the acceptance criteria — so R2's guard, A10's log scan, and A3's board correctness fall outside it. And because it fixes what it finds, finding and judging are the same agent, which is the wrong shape for failure modes that are *wrong but look right* (SGF unknown props, GTP `I`-skip, preload sandbox, `safeStorage` fallback). The verifier is **read-only by construction** so a finding cannot be quietly absorbed into a self-graded fix |

## Library choices (M1 scope)

| Concern | Choice | Rationale |
|---|---|---|
| Validation | **zod v4** | One schema language for IPC, settings, LLM tool args, KB frontmatter |
| SGF | **`@sabaki/sgf`**, wrapped | Most battle-tested JS SGF impl; handles malformed files and CJK/escaped-`]` round-trip. Wrapped because our move tree, DB rows, and IPC payloads need stable node identity raw SGF lacks |
| Board render | **Custom Canvas 2D**, two layers | Our heatmap/ownership overlays + 361-point per-frame analysis updates are exactly where a generic lib (WGo.js, shudan) forces a fight. SVG collapses at 361 nodes with per-frame updates; WebGL costs GPU context KataGo wants |
| LLM client | **official `openai` SDK** with configurable `baseUrl` | Both targets are OpenAI-compatible; SDK gives streaming, tool-calling, retries, abort for free |
| State | **zustand** | `getState()` outside React is what the imperative canvas renderer and IPC event handlers need. Redux too ceremonious; Jotai sprawls once imperative code reads stores |
| Secrets | Electron **`safeStorage`** | OS keychain. If `isEncryptionAvailable()` is false, refuse to persist and hold in memory with UI warning — never write plaintext |
| i18n | **`i18next` + `react-i18next`** | Default `zh-CN`, fallback `en`. Namespaced JSON, shared with main process for native menu/dialogs |
| Logging | **`electron-log`** | File + console with rotation, wrapped to enforce structure and secret redaction |
| Test | **vitest** + **Playwright `_electron`** | Workspace-aware unit runner; real Electron launch for e2e |

## Requirements

### R1 — Workspace and toolchain
pnpm workspace with `apps/desktop`, `apps/web` (placeholder), `packages/shared`, `packages/core`. Strict TypeScript, flat ESLint, Prettier, vitest workspace. `pnpm dev` launches the app; `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm package` all work.

### R2 — Trellis coexistence (hard boundary)
App code, build scripts, and CI **never** read from or write to `.trellis/`, `.claude/`, `.codex/`, `.qoder/`, `.agents/`, or `AGENTS.md`. Enforced by:
- `tsconfig.base.json` `exclude` and `eslint.config.js` `ignores` both listing these paths
- A CI step asserting `git diff --exit-code` is clean for all six paths after a full build
- `AGENTS.md` edits only outside the `TRELLIS:START`/`TRELLIS:END` block
- App `.gitattributes` rules appended **below** the existing Trellis `merge=union` rule

### R3 — Three-process architecture
- **Main**: sole OS authority. Owns filesystem, secrets, outbound network, logging, (later) KataGo processes + SQLite + agent loop
- **Preload**: thin, no business logic. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Exposes exactly one frozen object via `contextBridge`; no `ipcRenderer` leak to the page
- **Renderer**: React 19 + TS. Presentation only, never touches Node APIs

Renderer→main is always `invoke`. Main→renderer uses typed event channels for streaming (LLM token deltas; later KataGo ticks, coalesced to ~20/s in main).

### R4 — IPC contract
`packages/shared/src/ipc.ts` is the single contract: namespaced `domain:verb` channel names with zod request/response schemas. `ipc/register.ts` wraps every handler with request validation (and response validation in dev builds). A lint rule forbids raw channel strings outside `ipc.ts`.

M1 channels: `sgf.parse|serialize|openDialog`, `library.list|import`, `llm.sendMessage|cancel`, `settings.get|set|setSecret|hasSecret`. M1 events: `llm.delta|toolCall|done|error`, `library.changed`.

### R5 — SGF pipeline
Parse SGF → `GameTree` AST with stable node ids and parent/child links. Typed, zod-validated property accessors. Serialize back with correct escaping. **Unknown properties preserved byte-for-byte.** Typed errors (never hangs) on truncated, empty, or non-SGF input.

### R6 — Board rendering
Canvas goban: static layer (wood, grid, star points, coordinates) redrawn only on resize; dynamic layer (stones, last-move marker, overlays) per state change. Both `devicePixelRatio`-aware. Correct for 19×19, 13×13, 9×9. Move stepping via click and arrow keys. Placement/capture fades ≤120ms, cancellable and skippable.

Internal `[x, y]` zero-indexed from top-left is canonical, with pure converters to/from SGF letters, GTP labels (**skipping `I`**), and pixel space. Every historical Go bug lives in these conversions — exhaustive tests required.

### R7 — LLM provider
`LLMProvider` interface: async-iterator `chat()` (so streaming is ergonomic and cancellation is breaking the loop), `listModels()`, `health()`, `capabilities`. One concrete `openai-compatible` impl; `cloud.ts` and `local.ts` factories differ only in `baseUrl`, `apiKey` presence, default model, and timeout/retry policy (local: long timeout, zero retries; cloud: short timeout, 2 retries).

`probeCapabilities` on first connect attempts a trivial tool call and records whether tools actually work — Ollama/LM Studio support varies by model, so degrade to a no-tools prompt strategy rather than fail.

### R8 — Settings and secrets
Zod-validated settings persistence with migration-safe defaults. API keys via `safeStorage.encryptString` → opaque blob in `settings.json` beside a plaintext `hasSecret` flag. Never logged, never sent to renderer, redacted by a logger serializer.

### R9 — Three-panel UI
Resizable three-panel shell (game library / board + move nav / teacher chat), layout persisted across restart. Streaming chat with visible token flow, working cancel, and legible error states. Engine status badge as a first-class enum (`unavailable | downloading | starting | ready | failed`) — never an exception.

### R10 — i18n foundation
`zh-CN` (authoring locale) and `en` complete for all M1 surface. Namespaced JSON. Main process shares the same JSON for native menu/dialogs. CI fails on keys missing relative to `en`. Remaining locales (ja/ko/th/vi) deferred to M5.

### R11 — CI
Three-OS matrix (windows-latest, macos-latest arm64, ubuntu-latest) × Node 22 LTS: install (frozen lockfile) → lint → typecheck → test with coverage → package unsigned → upload artifacts. Plus lockfile-drift check, dependency-license gate (must be GPL-3.0-compatible per D4), i18n key completeness, and the R2 Trellis-immutability guard.

### R12 — Delivery verification at every stage gate (D10)
Each of the seven implementation stages ends with the same three-step gate: `trellis-check` (self-fixes conventions) → **`gomentor-verify`** (read-only, judges function) → main session acts on FAILs.

`gomentor-verify` is defined in `.claude/agents/gomentor-verify.md` with tools `Read, Bash, Glob, Grep` and **no `Write`/`Edit`**. It runs the test suite plus the stage's acceptance IDs and reports per-ID `PASS | FAIL | NOT-APPLICABLE-YET` with command output or file:line as evidence.

Two rules are mandatory, because they are how this kind of gate degrades into theatre:
- A criterion it could not test is **`NOT-APPLICABLE-YET`, never `PASS`** — silence must not read as success.
- **"Tests pass" is not evidence a criterion is met.** A5 requires the ≥20-file corpus to exist and be real; a green run over 3 synthetic fixtures is a FAIL on A5.

A FAIL blocks the stage. If a criterion itself proves wrong, amend this PRD explicitly — never lower the bar inside the verifier. Per-stage ID scoping and required evidence: `implement.md`. Rationale: `design.md` §Delivery verification.

## Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| A1 | `pnpm install && pnpm dev` opens the app window within 5s with no console errors or unhandled rejections | Manual smoke |
| A2 | Three panels visible and resizable; layout persists across restart | Manual smoke |
| A3 | Dragging an SGF onto the game list imports it, opens it, and renders the correct position for 19×19, 13×13, and 9×9 | Manual smoke vs known-position reference |
| A4 | Arrow-key and click move stepping is smooth; last-move marker and captures render correctly | Manual smoke |
| A5 | SGF parse→serialize→parse is deep-equal across a ≥20-file corpus including variations, CJK comments, escaped `]`, and unknown properties (preserved byte-for-byte) | `packages/core/test/sgf/round-trip.test.ts` |
| A6 | Truncated, empty, and non-SGF binary input each throw a typed error and never hang | Unit test |
| A7 | `internal→sgf→internal` and `internal→gtp→internal` are identities across all board sizes; GTP skips `I` | Property-based test (`fast-check`) |
| A8 | LLM streamed deltas assemble in order; tool-call fragments accumulate across chunks; `AbortSignal` terminates promptly; 429/500 surface as typed errors — for both cloud and local factory configs | `packages/core/test/llm/provider.test.ts` against a mock HTTP server |
| A9 | Every channel in `ipc.ts` accepts one valid payload and rejects ≥2 invalid ones; a meta-test asserts no channel lacks coverage | `packages/shared/test/ipc.test.ts` |
| A10 | An entered API key survives restart, and appears in **neither** `settings.json` plaintext **nor** any log file | Manual smoke (grep log dir) + mocked-`safeStorage` unit test |
| A11 | Asking the teacher a question streams tokens; cancel interrupts mid-stream; wrong key / down local server render legible errors | Manual smoke |
| A12 | Switching zh-CN ↔ en leaves no untranslated key visible | Manual smoke + CI key-completeness gate |
| A13 | Engine badge reads `unavailable` and the app remains fully usable | Manual smoke |
| A14 | CI green on all three OS, including the Trellis-immutability guard | CI |
| A15 | A packaged (unsigned) installer is produced on each OS | CI artifact |
| A16 | Every stage gate ran `trellis-check` then `gomentor-verify`, and every acceptance ID carries a recorded `PASS`/`NOT-APPLICABLE-YET` verdict with evidence — no ID left unjudged, no FAIL left open at the final gate | Verify agent reports (R12) |

## Out of scope for M1

Deferred to later milestones, with no M1 design decision blocking them:

- **KataGo integration** (M2) — bundled engine, backend auto-detection, winrate graph, heatmap, move tree variations. M1 designs `packages/core/src/katago/{gtp,analysis}.ts` and the `EngineStatus` enum so M2 is additive
- **LLM tool-calling agent + knowledge base** (M3) — agent loop, tools, KB with BM25 + Zobrist pattern index, ~150 curated entries
- **Student profile, weakness tracking, training plans** (M4) — SQLite schema, EMA weakness scoring, plan generation
- **Fox sync, readboard, full i18n, signed releases, Astro website** (M5)
- SQLite / `better-sqlite3` — M1's library store is in-memory; DB lands in M2 when there is analysis data to persist
- Code signing and macOS notarization — CI packages unsigned in M1; the signing spike runs in parallel from M2
- Telemetry — opt-in, default off, no-op until consented; wiring lands in M5

## Technical notes and risks

- **Toolchain risk is M1's biggest**: electron-vite + pnpm + electron-builder agreeing on Windows is the classic Electron time sink. Doing it first, properly, is the point of M1. `better-sqlite3`'s native rebuild is deferred to M2, removing that variable from M1.
- **`.trellis/spec/` is populated** (done before Stage 1 implementation, since `implement.jsonl` references spec files and pointing sub-agents at empty templates would be worthless). Filled: `backend/{directory-structure,error-handling,quality-guidelines,logging-guidelines}.md` and `frontend/{directory-structure,state-management}.md`, plus both index files. `backend/database-guidelines.md` is deliberately deferred to M2 (M1 has no persistence layer). The four remaining `frontend/` guides (component, hook, quality, type-safety) are deferred to Stage 6, to be written from real renderer code rather than invented up front. Still outstanding: `.trellis/config.yaml` should declare the workspace packages so `get_context.py --mode packages` resolves the spec layers.
- **License provenance must be tracked from day one.** Under D4, if any asset or logic is derived from lizzieyzy-next, record it in `NOTICE`. This also matters for readboard (M5): reverse-engineering from a GPL binary reinforces D4.
- **Design source note**: the design pass could not fetch the two reference repos directly (GitHub API rate limit from that host). Repo facts in this PRD come from a separate successful research pass. Before M2 implements engine packaging or M5 implements Fox/readboard, verify those repos' actual layouts directly.
- **LLM answer quality is the product** (M3 risk, flagged early): a teacher that hallucinates Go advice actively harms a learner. The M3 eval set (~40 question/position pairs) is an acceptance criterion, not polish.
- **Weakness categorisation validity** (M4 risk): categories are derived from analysis deltas plus board-geometry heuristics, kept pure and unit-testable. The LLM only *explains* categories, never assigns them — non-determinism in the profile would destroy trust in the training plan. Needs external validation from a strong player.

## Milestone roadmap (context for M1's boundaries)

| M | Title | Deliverable | Effort | Riskiest item |
|---|---|---|---|---|
| **M1** | `bootstrap-desktop-skeleton` | This task: skeleton + SGF board + LLM chat vertical slice | **L** | Electron toolchain on Windows |
| M2 | `katago-analysis-engine` | Zero-config bundled KataGo, live winrate/heatmap/ownership, move tree, crash auto-recovery | **XL** | Cross-platform GPU backend detection; CUDA/TensorRT DLL deps on Windows; notarizing unsigned third-party binaries on macOS |
| M3 | `llm-teacher-agent-kb` | Tool-calling teacher: "why was move 47 bad?" → analyze + KB lookup → cited answer with board highlights | **L** | Answer quality (eval set required) |
| M4 | `student-profile-training-plans` | Batch-analyse library, surface three weakest areas with evidence links, track improvement, generate training plans | **L** | Mistake-categorisation validity |
| M5 | `external-sources-i18n-release` | Fox sync, readboard bridge, six locales, signed installers + auto-update, Astro site. Public 1.0 | **XL** | Code signing / macOS notarization (spike from M2 onward) |

Optional M6: extract `readboard-physical-sync` from M5 if scope demands — least-coupled, most-likely-to-slip piece.

## Open questions

None blocking M1. Deferred, non-blocking:

- Engine-download hosting for D6's tiered installer — GitHub Releases works initially, but a mainland-China CDN/mirror should be planned (M2)
- Which physical board models readboard must support, and whether protocol documentation exists or only lizzieyzy-next's binary (M5)
- Knowledge base authoring is ~40–80h of **content**, not engineering work — track as its own task with a content-authoring gate; likely critical path for M3/M4 quality
