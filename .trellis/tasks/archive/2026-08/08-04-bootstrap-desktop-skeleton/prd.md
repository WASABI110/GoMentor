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
| Validation | **zod v4** (4.4.3) | One schema language for IPC, settings, LLM tool args, KB frontmatter. Migrated from 3.25 during Stage 2, while `packages/shared` was the only consumer — deferring it would have meant touching far more schema surface. Two traps, both silent data bugs rather than type errors, both found by measurement. (1) `.prefault({})`, not `.default({})`, for nested sections: in zod 4 `.default` emits the value verbatim so nested defaults never apply. (2) **`.partial()` does not make a patch schema.** It makes keys optional on *input* but leaves each field's inner `.default()` in place, so the *output* is the whole document filled with defaults — and `register.ts` hands handlers the output. Stage 4 shipped `settings:set` this way and a patch naming one field reset every other setting the user had chosen. A patch schema must be written out explicitly (`settingsPatchSchema`); deriving one by walking `def` was rejected because a zod upgrade changing that shape would degrade it to validating nothing, which fails open |
| SGF | **Hand-written parser/serialiser** in `packages/core/src/sgf/` | Amended during Stage 3, under R12's "if a criterion itself proves wrong, amend this PRD explicitly". The original choice was `@sabaki/sgf`, wrapped. It was dropped because it is incompatible with A5 as written, not merely inconvenient: A5 requires unknown properties to survive **byte-for-byte**, and a library that helpfully decodes `\]` to `]` on read has already discarded the information needed to write the original bytes back. Escape handling has to be owned to make that contract hold, and once values are kept raw the library's remaining value is small. Two further requirements landed in the same place — three-state encoding detection (`CA`, BOM, or a refusal to guess) and a bounded parse depth so a malformed file cannot hang the import flow (A6) — both of which are parser-internal decisions. The wrapper's original justification, stable node identity, is unaffected and still holds: the AST assigns monotonic ids at parse time. Cost accepted knowingly: escaping, encodings, and malformed input are now ours to get right, which is why the round-trip corpus is 65 real files and why the SGF paths carry mutation harnesses in `scripts/` |
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

**The workspace packages must be excluded from `externalizeDepsPlugin()`** in `apps/desktop/electron.vite.config.ts` — `exclude: ['@gomentor/shared', '@gomentor/core', 'zod']` on both the `main` and `preload` targets. Recorded during Stage 5, after the app as built was found not to start at all. The plugin reads `dependencies` and leaves each entry as a runtime `require()`, which is right for real npm packages and wrong for these three: `@gomentor/shared` and `@gomentor/core` are `"type": "module"` with `main` pointing at uncompiled `.ts` source, so the CJS bundle emitted `require("@gomentor/shared")`, Node resolved it to the TypeScript source, and the app died at load. `zod` is excluded one layer down because the shared schemas import it — bundling shared while externalizing zod only moves the unresolved `require` inside the bundle. The preload needs the exclusion more urgently still: a sandboxed preload has **no node_modules resolution whatsoever** (measured), so any runtime `require` of a non-Electron module throws `module not found`, the preload dies before `exposeInMainWorld`, and the page silently gets `window.gomentor === undefined`. That is why `src/preload/index.ts` takes only `import type` imports; this exclusion is the second layer of the same guarantee. Verify with `grep -o 'require("[^"]*")' out/preload/index.js` — the only line should be `require("electron")`.

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

**The `IpcResult` envelope stays a union all the way into the renderer — the preload must not unwrap it into a `throw`.** Amended during Stage 5, because the opposite was already asserted in `main/ipc/register.ts` before anyone tested it. `contextBridge` does not carry an Error's own properties: an `AppError` thrown inside a bridged function is caught in the page as a plain `Error` with `name: 'Error'`, an empty `Object.keys()`, and both `code` and `context` `undefined`. Only `message` survives — which is precisely the failure the typed envelope exists to prevent (`error-handling.md:65`: the renderer localises `code`, never displays raw `message`), reintroduced one layer later. Returning the envelope as *data* preserves `code`, `message`, and nested `context`, measured end-to-end in a real sandboxed window. Note also what the frozen-object requirement above does *not* buy: `Object.freeze` in the preload is not what stops the page mutating the bridge — `contextBridge` builds its own frozen mirror in the page realm, so removing the freeze changes nothing observable from the renderer. Keep it, but do not treat it as the guarantee.

### R4 — IPC contract
`packages/shared/src/ipc.ts` is the single contract: namespaced `domain:verb` channel names with zod request/response schemas. `ipc/register.ts` wraps every handler with request validation (and response validation in dev builds). A lint rule forbids reaching past the typed wrappers to Electron's IPC primitives (`ipcMain.handle`, `webContents.send`) anywhere but `register.ts` and `events.ts`.

M1 channels (11): `sgf:parse|serialize|openDialog`, `library:list|import`, `llm:sendMessage|cancel`, `settings:get|set|setSecret|hasSecret`.

M1 events (6): `llm:delta|done|error`, `library:changed`, `menu:command`, `engine:status`.

The event count was wrong before Stage 6 and is corrected here rather than quietly: it said 5 while `EVENTS` has held six since Stage 2 — `menu:command` was added there and never counted. A stale count is not a harmless typo in this document: the desktop integration suite asserts an explicit channel ledger against `CHANNEL_NAMES`, so a reader reconciling code against this PRD is told the test is over-covering when in fact the prose is behind. Both numbers were re-derived by evaluating `Object.keys` on the real objects, not by counting the lists above.

Three deliberate departures from this requirement's first draft. The first two were settled during Stage 2, the third during Stage 4:

- **No separate `llm:toolCall` event.** Tool-call fragments ride inside `llm:delta` as a variant of `chatChunkSchema`'s discriminated union. A separate event would carry the same data on a second path and force the renderer to re-order two streams by `runId` — strictly worse than one ordered stream.
- **`engine:status` added.** R9 requires engine state to be a first-class enum rather than an exception, so the renderer needs a push channel for transitions. Without it, `EngineStatus` would only be readable by polling.
- **The lint rule guards the wrappers, not channel strings.** This requirement first read "forbids raw channel strings outside `ipc.ts`", on the premise that inlined channel names drift silently on rename. Stage 4 measured that premise and it is false: `handle()` and `emit()` are generic over `C extends ChannelName` / `E extends EventName`, so a renamed or mistyped channel is a TS2345 that names every valid channel — the loudest available failure. The rule fired on all 17 already-type-checked call sites, and the remedy it advised — importing a per-channel constant from `@gomentor/shared/ipc` — named an export that does not exist and should not: `CHANNELS` is the contract, and per-channel constants would be a second place for a channel name to live.

  What types genuinely cannot express is the invariant the rule now guards. A bare `ipcMain.handle` is perfectly well-typed while silently skipping request validation, response validation, and error-envelope mapping — so a throw would cross the boundary as a stringified `Error` and lose the `code` the renderer translates (`error-handling.md`). That is the drift worth a linter.
**A withdrawn fourth departure, recorded because the withdrawal is the lesson.** Stage 6 added a `menu:setLabels` channel (renderer → main) so the renderer could push translated menu labels, on the stated premise that "only the renderer knows the locale". The channel was built, tested, mutation-proven, and written up here before that premise was checked. It is false: `locale` lives in `ui.locale` inside the settings document, which **main** owns, and `main/index.ts` already calls `settings.get()` before it builds the menu. R10 had said all along that main shares the same i18n JSON.

The channel and its tests were reverted, and `main/menu.ts` now imports `renderer/src/i18n/locales/<locale>/common.json` directly — literally the same files the renderer uses, so a missing key is a compile error rather than a menu item rendering as `undefined`. Measured after the change: launching the built bundle with `ui.locale` set to `zh-CN` yields a menu bar of `["文件","视图","帮助"]` and with `en` yields `["File","View","Help"]`, from one artifact.

Translating in main is also strictly better than the channel was, for a reason the channel could not fix: the menu is correct on the **first paint**. Labels arriving over IPC cannot land until React has mounted and i18n has initialised, so the bar would show English until then — the very A12 gap the channel was supposed to close.

The generalisable failure was not the wrong design; it was writing a long, confident rationale for a boundary without verifying the factual claim underneath it. Volume of justification reads as evidence and is not. One `grep locale` in `types/settings.ts` would have refuted it before any code existed.

**An amendment to the Stage 2 contract, made in Stage 6 under R12's amend-don't-lower rule.** `gameSchema` gained a required field:

```ts
setup: gameSetupSchema.prefault({})   // { black: Coord[]; white: Coord[] }
```

The contract as designed in Stage 2 could describe *play* but not *position*. `Game` carried `meta` and `moves`, and nothing else — so a handicap game's `AB` stones and a life-and-death problem's `AB`/`AW` stones had nowhere to live, and a nine-stone handicap record reached the board with all nine stones missing. That is a direct A3 failure ("renders the correct position for 19×19, 13×13, and 9×9"), and it was invisible to four consecutive green stage gates because nothing yet read a position off a `Game`.

Measured across the 44-file real corpus before choosing the shape, rather than reasoned about:

- **10 files carry `AB`/`AW`.** Four carry white setup stones, one of them 34 — so `HA[]` cannot stand in for the field. A count expresses black stones only, and cannot express *which* points.
- **Three setup-bearing files declare no `HA` at all** (`gnugo-ko6-jago`, `sabaki-sgf-no-ca`, `katago-sampletest9x9`), which independently rules out deriving setup from `meta.handicap`.
- **Every mainline setup node in the corpus occurs before move 1.** This is what bounds the fix to an initial position instead of a general position-at-node model.
- **All four `AE` (remove-stone) nodes are off-mainline**, so `AE` is deliberately not applied.
- **Replaying the whole corpus from setup produces zero rule violations**, which is the evidence that the projection is faithful rather than merely type-correct.

The accepted bound, stated rather than hidden: a file that places stones *mid*-mainline replays without them. That is the same move-tree limitation already recorded elsewhere, not a new one.

Setup is deliberately **not** folded into `moves`. Doing so would shift every move number by the number of setup stones and hand move 1 to the wrong player — a handicap game's first played move is white's.

Two further consequences worth recording, because each was a hole a gate had not caught:

- `state-management.md` names `board/position.ts` as the module that "replays moves". It did not, and no replay function existed anywhere in the repo. `replay(game, moveNumber)` was added there, returning a `stopped` record rather than throwing: a record whose move 137 is illegal still has 136 good moves, and refusing the whole file would be worse than showing 136. Silently skipping the bad move would be worse still — a wrong board looks exactly as authoritative as a right one.
- **A corpus-wide test that reimplements its subject cannot guard its subject.** `packages/core/test/board/replay.test.ts` sweeps all 44 fixtures, but built its input with a local copy of the projection. Measured: replacing `setup: toSetup(...)` with `setup: { black: [], white: [] }` in the *shipping* adapter left **784 tests green** — the exact defect above would have shipped with a corpus-wide test file sitting next to it. `apps/desktop/test/unit/sgf-adapter.test.ts` now drives the real `toGame`, deriving every expectation from each fixture's own properties rather than from a transcribed board; the same mutation now produces 21 failures, a root-only read produces 1, and dropping white setup alone produces 6.


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

**Amended in Stage 6 (R12's amend-don't-lower rule): "keys missing relative to `en`" is not a sufficient gate.**

Key-set comparison passes for a locale file whose keys are all present and whose **values are copied from `en`** — which is the untranslated state A12 exists to forbid. Measured rather than argued: overwriting five of the six `zh-CN` catalogues with their `en` counterparts — every error message, the whole settings panel, all teacher and board and analysis text in English — left the i18n gate at **40/40 and the full suite at 914/914**. Only `common.json` was caught, and only incidentally, by two `locale selection` cases that happen to spot-check particular keys; the five namespaces with no spot-check were invisible.

The gate now also rejects values identical to `en` outside an enumerated allowlist of 11 key paths — the product name, six endonyms (each language named in its own language), and four KataGo backend names (`TensorRT`, `CUDA`, `OpenCL`, `CPU (Eigen)`), which must match what the engine itself reports. The allowlist is pinned to an exact count by its own test, because growing it is the one way to silently disable the check. Re-running the same mutation now fails five tests, each naming its namespace.

Two claims made in an earlier draft of this amendment were **wrong and are corrected here rather than deleted**, since the error is the same class as R4's withdrawn fourth departure — writing a confident rationale without checking the fact under it:

- "`check:i18n` had no implementation behind it" — false. `scripts/check-i18n.ts` exists and runs; it deliberately delegates to the test suite rather than re-implementing the comparison. (Its doc comment does record that the script was once a missing file, which is presumably what the draft was remembering.)
- "the gate only compares one direction" — false. `i18n.test.ts` has asserted both directions since it was written, with the reasoning stated in place.

One real inaccuracy found while checking: `scripts/check-i18n.ts` names the suite as `apps/desktop/test/unit/i18n.test.ts`, but it lives at `apps/desktop/test/renderer/i18n.test.ts`. The script's filter (`--project desktop … i18n`) matches by pattern, so the gate does run — the comment is stale, not the code.

### R11 — CI
Three-OS matrix (windows-latest, macos-latest arm64, ubuntu-latest) × Node 22 LTS: install (frozen lockfile) → lint → typecheck → test with coverage → package unsigned → upload artifacts. Plus lockfile-drift check, dependency-license gate (must be GPL-3.0-compatible per D4), i18n key completeness, and the R2 Trellis-immutability guard.

**Status after Stage 6: `.github/workflows/ci.yml` exists but has never run.** Stated plainly because "CI exists" and "CI works" are different claims, and this document has already been wrong once by conflating a script's *name* with its *implementation*. What has been verified locally, and what has not:

| Claim | Evidence |
|---|---|
| Every `pnpm` script the workflow calls exists | All 11 `run:` references resolved against `package.json` |
| The YAML parses and has the intended shape | Parsed; 2 jobs, 3-OS matrix, `fail-fast: false`, Node 22, `permissions: contents: read` |
| `check:trellis` can actually fail | Appending one line under `.trellis/` exits 1; reverting returns 0 |
| `check:licenses` can actually fail | Removing `MIT` from the allowlist fails and names the packages; replacing the allowlist with a denylist fails 9 tests |
| `check:i18n` can actually fail | Five copied namespaces now fail 5 tests, each naming its namespace |
| `pnpm typecheck` covers `scripts/` and the config files | Added in Stage 6 — it did not before; see below |
| `pnpm package` produces a launchable app | Windows `--dir` only, and with a manual cache workaround — see below |
| The installer (NSIS/dmg/AppImage) builds | **Not verified.** The signing-tool download is unreachable from this machine |
| The workflow runs green on any runner | **Not verified.** No push has triggered it |
| `xvfb-run` lets Electron launch on Linux | **Not verified.** Cannot be tested from this machine |
| macOS arm64 packaging works | **Not verified.** Same |

`pnpm package` was broken until Stage 6 and nobody had run it: it failed with "Cannot compute electron version from installed node modules … version (^33.3.1) is not fixed in project". Electron *was* installed (33.4.11), but `.npmrc` sets `node-linker=hoisted`, so it resolves to the repository root while electron-builder searches under `apps/desktop`. Fixed by pinning `electronVersion` in `electron-builder.yml`. This is the same shape as Stage 5's finding — a build step that no gate had ever executed — which is the argument for having CI run it on every push rather than at whichever gate someone remembers.

Past that fix, packaging reached a **network** wall rather than a configuration one, and the distinction matters because only the first kind is the project's problem. electron-builder's downloader is a Go binary (`app-builder`) that does not use the proxy this machine's `curl` uses: `curl` fetches from `github.com` in ~2s, while `app-builder` times out against `20.205.243.166:443` on every attempt. Two artifacts are affected — the 115 MB Electron zip, and `winCodeSign-2.6.0.7z`, needed to build the NSIS installer.

The Electron zip was already on disk from `pnpm install`, in electron's own cache rather than electron-builder's. It was **checksum-verified before being reused** (`sha256 f64c8a5a…`, matching the `SHASUMS256.txt` line for `electron-v33.4.11-win32-x64.zip` fetched from the release) and then passed via `--config.electronDist=<cache dir>`, which `ElectronFramework.js` treats as a cache hit when the directory holds the expected zip name. That is a **local-only workaround, deliberately not committed**: the path is machine-specific, and CI's runners have working egress and need no such help.

With that, `electron-builder --dir` completed and was verified as an artifact rather than as a log line:

- `dist/win-unpacked/GoMentor.exe`, 188 MB, plus 17 sibling files
- `resources/app.asar` contains `out/main`, `out/preload`, `out/renderer` **and** bundled `node_modules` — the concrete confirmation of the `.npmrc` hoist-pattern comment that a working `pnpm dev` does not catch a packaging omission
- launched from the unpacked directory it stays alive as **4 processes** and logs `{"level":"info","scope":"main:app","msg":"app starting","electron":"33.4.11"}` — real Electron, not a stub

One caution recorded because it produced a false failure first: this shell exports `ELECTRON_RUN_AS_NODE=1`, under which `GoMentor.exe --version` prints `v20.18.3` and the app exits silently with no window. That is the harness, not the build; the launch must be probed with `env -u ELECTRON_RUN_AS_NODE`. A test environment can fail a healthy artifact as convincingly as a broken artifact fails a good test.

The installer step therefore remains unverified on any platform, and `pnpm package` (without `--dir`) has never completed here. CI is where that resolves.

The three unverified rows are the residual risk of writing CI on a machine that cannot run it, and they resolve on the first push, not before.

**`tsconfig.tools.json` was never compiled by anything.** `pnpm typecheck` was `pnpm -r typecheck`, which recurses into workspace *packages*; the root is not a package, so the config listing `scripts/**/*.ts`, `eslint.config.js`, and every `vitest.config.ts` was never handed to `tsc`. The file existed, looked like coverage, and provided none — the same "name without an implementation" shape as `check:licenses`, and worth naming separately because here the omission was one level up, in *who invokes* an otherwise-correct config.

Compiling it for the first time produced two real errors, neither of which any other gate could see: an unused `PERMITTED` import left behind when the SPDX logic was split into `scripts/licenses.ts` (whose accompanying failure text still told the reader to edit `PERMITTED` "in this file", by then the wrong file), and a `string | undefined` returned as `string` in `scripts/mutate-coord-error.mts` — in the very helper written to fix an earlier miscount in that script's summary line. Fixed with `?? ''` rather than `!`, per the quality guidelines.

`typecheck` is now `pnpm typecheck:tools && pnpm -r typecheck`, tools first so the cheap check fails fast. Proven able to fail: changing `isPermitted(field: string)` to `field: number` is reported across all three files that touch it (`licenses.ts`, `check-licenses.ts`, `test/licenses.test.ts`), exit 2. Reverted, exit 0. No workflow change was needed — CI already calls `pnpm typecheck`, which is exactly why the gap mattered: CI would have inherited the blind spot verbatim.

### R12 — Delivery verification at every stage gate (D10)
Each of the seven implementation stages ends with the same three-step gate: `trellis-check` (self-fixes conventions) → **`gomentor-verify`** (read-only, judges function) → main session acts on FAILs.

`gomentor-verify` is defined in `.claude/agents/gomentor-verify.md` with tools `Read, Bash, Glob, Grep` and **no `Write`/`Edit`**. It runs the test suite plus the stage's acceptance IDs and reports per-ID `PASS | FAIL | NOT-APPLICABLE-YET` with command output or file:line as evidence.

Three rules are mandatory, because they are how this kind of gate degrades into theatre:
- A criterion it could not test is **`NOT-APPLICABLE-YET`, never `PASS`** — silence must not read as success.
- **"Tests pass" is not evidence a criterion is met.** A5 requires the ≥20-file corpus to exist and be real; a green run over 3 synthetic fixtures is a FAIL on A5.
- **Every gate from Stage 5 on must build and launch `out/`, and a gate that does not is a FAIL on its own terms.** Added during Stage 5 under this section's own amendment rule. Stages 1–4 all passed a gate consisting of typecheck + lint + vitest, and *none of those three loads the built bundle* — so the shipped artifact had never been started once. When Stage 5 launched it for the first time it died immediately at `packages/shared/src/index.ts:5` with `SyntaxError: Unexpected token 'export'`: `externalizeDepsPlugin()` had left the workspace packages as runtime `require()`s out of a CJS bundle (see R1). Four consecutive green gates over an app that could not boot is the exact failure mode D10 exists to catch, and it slipped through because the gate's evidence was all pre-runtime. A11/A1-style manual smoke would have caught it, but a gate must not depend on the one step most likely to be skipped.

**What launching `out/` does *not* prove, added in Stage 7 under this section's amendment rule.** The rule above is right, and it bought a narrower guarantee than its wording suggests. Three limits were measured, each by mutating renderer source and finding the whole e2e suite still green:

- **The e2e specs run a production React bundle, so `StrictMode` is inert.** Verified by inspecting the built renderer: minified `react.dev/errors` URLs are present and the development warning strings are absent. Effects are therefore never double-invoked, and `App` never unmounts during a spec. Two genuine defects in `useIpcEvent` survive every test as a direct result — discarding the teardown that `subscribe` returns, and adding `handler` to the effect's dependency array. Both would leak or churn subscriptions in `pnpm dev`. **Effect-teardown correctness is not machine-covered in M1** and must be reported `NOT-APPLICABLE-YET` rather than folded into a green e2e run. Any comment or gate note claiming an e2e test catches a StrictMode-dependent bug is wrong on its face; one such comment existed and has been corrected.
- **A launch without `--user-data-dir` is not isolated, and silently couples specs.** Electron gives an unpackaged app `%APPDATA%/Electron`, one directory shared by every spec, every run, and every other unpackaged Electron app on the machine. Measured: `ipc-events.spec.ts` writes `llm.kind: 'local'` through `settings:set` to obtain a keyless provider, and `preload-boundary.spec.ts` — which asserts `LLM_NO_KEY` from default settings — then failed with `LLM_UNREACHABLE`, with the other spec's `baseUrl` port still in that file afterwards. The same directory receives imported games and `safeStorage` secrets and survives between runs, so A2's and A10's restart semantics are only meaningful against a profile no other spec can see. `launchApp` now allocates a throwaway profile whenever the caller supplies none and removes it on the app's `close` event; the explicit option remains for the one honest use, two launches that must share state.
- **A spec file's module scope executes during test *collection*, not only during the run.** Playwright imports each file twice. `playwright test --list` runs zero tests and still created two profile directories, because `makeUserDataDir()` sat in a `describe` body — and the collection-pass copy has no `afterAll` behind it. Resource creation belongs in a hook. Noted here because the first diagnosis was a Windows file lock and the "fix" was widening `rmSync`'s retry budget, which changed nothing: a leak that reproduces under `--list` is a load-time effect, and `--list` distinguishes the two in one command.

A fourth constraint, discovered while writing the same spec and binding on every future LLM test: **an e2e test that needs a `runId` cannot use the cloud provider.** With the default `kind: 'cloud'` and no key, `send` fails at provider construction with `LLM_NO_KEY` before a request exists. CI has no key and never will, so the keyless `kind: 'local'` path is the only one available — and it needs a server that *accepts* the connection, since an unreachable address fails fast enough that `failRun` clears `activeRunId` before an assertion can read it. A local HTTP server that accepts and never responds holds the run open, exercising the real provider, service, and IPC path with nothing inside the app stubbed. This does not weaken A11, which stays manual for the reasons already recorded; it constrains how A8-adjacent renderer behaviour may be tested.

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
| A9 | Every channel in `ipc.ts` accepts one valid payload and rejects ≥2 invalid ones; a meta-test asserts no channel lacks coverage, and that meta-test is itself proven non-vacuous by adding a channel to a scratch copy and asserting the coverage check fails | `packages/shared/test/ipc.test.ts` (coverage) + `packages/shared/test/ipc-meta.test.ts` (non-vacuity). The scratch copy must live inside the repo (`node_modules/.cache`), not `tmpdir()`: on a machine where the two are on different drives, the forked vitest resolves a different instance of itself than the copied tests import, so nothing registers and every file reports "No test suite found" — which looks identical to empty test files, and silently disabled this guard until Stage 4 |
| A10 | An entered API key survives restart, and appears in **neither** `settings.json` plaintext **nor** any log file | Mocked-`safeStorage` unit test, plus a scripted end-to-end check — Stage 4 established this needs no manual smoke: `SettingsFs` and `Encryptor` are both injectable, so a real key can be driven through a real `settings.json` and a real `electron-log` file headless, then the bytes on disk grepped. Must exercise the paths a field-name check alone would miss (key inside an `Error` message, nested in an object, as URL userinfo) and must be shown to fail when `redact` is bypassed |
| A11 | Asking the teacher a question streams tokens; cancel interrupts mid-stream; wrong key / down local server render legible errors | Manual smoke |
| A12 | Switching zh-CN ↔ en leaves no untranslated key visible | Manual smoke + CI key-completeness gate |
| A13 | Engine badge reads `unavailable` and the app remains fully usable | Manual smoke |
| A14 | CI green on all three OS, including the Trellis-immutability guard | CI |
| A15 | A packaged (unsigned) installer is produced on each OS | CI artifact |
| A16 | Every stage gate ran `trellis-check` then `gomentor-verify`, and every acceptance ID carries a recorded `PASS`/`NOT-APPLICABLE-YET` verdict with evidence — no ID left unjudged, no FAIL left open at the final gate | Verify agent reports (R12) |

## Final-gate verdict record (A16)

Recorded 2026-09-03. No FAIL open. Machine-verifiable IDs are PASS with the
evidence below; the manual-smoke IDs are `NOT-APPLICABLE-YET` by rule (a
criterion that has not been manually exercised is never `PASS`).

| # | Verdict | Evidence |
|---|---|---|
| A1 | NOT-APPLICABLE-YET | Manual smoke (dev-mode visual, console clean) — user |
| A2 | PASS | `apps/desktop/test/e2e/panel-resize.spec.ts`: real `page.mouse` drag (+120px, avoids `dragTo` handle-interception defect) + relaunch persistence on same profile |
| A3 | NOT-APPLICABLE-YET | Manual smoke (drag gesture, 19×19/13×13/9×9 known positions) — user |
| A4 | NOT-APPLICABLE-YET | Manual smoke (stepping feel, last-move marker, captures) — user |
| A5 | PASS | `packages/core/test/sgf/round-trip.test.ts`, 65 real SGF files: variations, CJK comments, escaped `]`, unknown properties byte-preserved |
| A6 | PASS | Typed-error unit tests: truncated / empty / non-SGF binary never hang |
| A7 | PASS | fast-check identity properties, `internal→sgf→internal` and `internal→gtp→internal`, GTP skips `I`, all board sizes |
| A8 | PASS | `packages/core/test/llm/provider.test.ts` vs mock HTTP server: delta order, cross-chunk tool-call accumulation, prompt abort, 429/500 typed errors, cloud + local factories |
| A9 | PASS | `packages/shared/test/ipc.test.ts` (every channel ≥1 valid / ≥2 invalid) + `ipc-meta.test.ts` non-vacuity proven via scratch-copy channel addition (scratch under `node_modules/.cache`, not `tmpdir()` — cross-drive vitest self-resolution defect) |
| A10 | PASS | Scripted headless check driving a real key through real `settings.json` + real `electron-log` file; Error-message / nested-object / URL-userinfo paths; shown to fail when `redact` bypassed |
| A11 | NOT-APPLICABLE-YET | Manual smoke: streaming, cancel mid-stream, wrong-key and down-server legible errors — requires a reachable LLM endpoint; user |
| A12 | PASS | `apps/desktop/test/e2e/i18n.spec.ts` (menu labels via `app.evaluate`, macOS app-menu filtered by `app.name`) + CI key-completeness gate asserting values differ across locales, not just key presence |
| A13 | NOT-APPLICABLE-YET | Manual smoke (engine badge `unavailable`, app usable) — user |
| A14 | PASS | CI run #4, commit `d32ef38`, 2026-09-03: `ubuntu-latest`, `windows-latest`, `macos-latest` all completed successfully, including the `Trellis immutability (R2)` step. <https://github.com/WASABI110/GoMentor/actions/runs/33638821552>. Fix history: repository detection via `package.json#repository` (`b423cb7`), macOS app-menu exclusion (`73046fc`), `--publish never` to bypass tokenless `GitHubPublisher` construction on CI (`d32ef38`) |
| A15 | PASS | Same run, 3 artifacts uploaded (`gomentor-ubuntu-latest`, `gomentor-windows-latest`, `gomentor-macos-latest`, each `apps/desktop/dist`): unsigned NSIS `.exe`, `.dmg`, AppImage |
| A16 | PASS | This record; per-stage `trellis-check` → `gomentor-verify` gates run through Stage 6 |

Machine-coverage caveat recorded with evidence (design.md §StrictMode): the e2e
bundle ships production React, so `StrictMode` double-invocation is inert and
`useIpcEvent` teardown correctness is not machine-covered in M1. Tracked as a
known gap, folded into the A1/A4 manual smoke.

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
