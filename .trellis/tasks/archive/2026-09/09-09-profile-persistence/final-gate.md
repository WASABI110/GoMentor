# Final Gate — Student Profile & Persistence (M4)

Per-criterion verification of PRD acceptance C1–C8 against the delivered
code, recorded by the main session (read-only adversarial pass; sub-agent
dispatch unavailable this session — quota limits — so every verdict below
names the concrete evidence instead).

**Verdict: PASS on all eight criteria.** Evidence frozen at commit
`975afb9` + the Stage 4 working tree (all gates re-run on the final tree
before this record was written; numbers below are those runs).

---

## C1 — Library persistence (R1)

**PASS.**

- e2e `library-persistence.spec.ts`: import → real quit → relaunch on the
  same `userDataDir` → the game is listed and opens through the real
  `sgf:serialize` round-trip (43/45-test suite run: green).
- The store swap preserved the `GameStore` interface method-for-method; the
  interface-equivalence tests (same suite against Map and SQLite backends
  during Stage 1) are the proof the swap is behaviour-neutral.
- Damaged-database quarantine and the WAL-downgrade signal are covered by
  `db.test.ts` (including the user_version 9000 preservation case).

## C2 — Batch analysis (R2)

**PASS.**

- `test/integration/batch.test.ts` (14 tests, real engine service + real
  fake child + real database file): progress events, cancel → pending,
  crash + reopen resumes without re-analysing done games (byte-identical
  rows), threshold-flush crash keeps exactly the committed prefix, mid-game
  winrate seed from the persisted row, mine scope, changed-content
  invalidation, per-game failure retry.
- `scripts/mutate-profile.mts` D-series (23 driver mutants): ledger state
  machine, wave/window arithmetic, chunk flush threshold, abort policy,
  run accounting — all caught, 0 escaped.

## C3 — Profile purity (R3)

**PASS.**

- The classifier's signature is the boundary, at the type level:
  `classifyGame(game, rows)` takes a replayable record and analysis rows —
  no prompt, no model output, no settings can enter it
  (`packages/core/src/profile/categories.ts`).
- The profile assembly (`profile.ts`) takes marks + ids + timestamps only.
- Pure-core latency is pinned by test (a 300-move record classifies well
  under the generous 500 ms bound; measured ~single-digit ms).
- Mutation: C-series (14) and F-series (12) mutants — every threshold
  boundary on both sides, Chebyshev-vs-Manhattan geometry, band edges, EMA
  decay direction and half-life, trend epsilon, weakness/evidence caps —
  80/80 harness run caught, 0 escaped.

## C4 — "My games" predicate (R3/R2)

**PASS.**

- `packages/core/src/profile/mine.ts`: tri-state override outranks the
  professional exclusion, which outranks the case-insensitive
  either-colour name match; empty names list claims nothing; absent ranks
  never read as professional.
- One predicate is shared by the batch `mine` scope and the profile
  derivation — they cannot disagree by construction.
- Professional exclusion (C4's "职业棋默认不入画像"): pattern-tested
  (`9p`, `9 p`, `pro`, `professional` vs `7d`, `5 kyu`, `proud amateur`,
  `champion`), and asserted through the real store in
  `handlers.test.ts` (a named pro game contributes nothing).
- Mutation: G-series (13 mutants) caught, 0 escaped — including the
  precedence break that initially escaped as a no-op and was replaced with
  a discriminating mutant rather than a loosened test.

## C5 — Weakness presentation & evidence click-through (R4)

**PASS.**

- e2e `profile.spec.ts` drives the whole real path: generated SGF import →
  settings name → the panel's own batch button → the production scheduler
  analysing against the spawned fake engine → the terminal refetch
  rendering a weakness card → clicking an evidence row opens the record and
  the board's move readout lands on exactly the evidence move.
- No direct database seeding in the spec (documented in the spec header:
  the e2e runner's binding is the Electron ABI mid-gate, and a hand-seeded
  row would test the panel, not the pipeline).

## C6 — The teacher reads the profile (R4)

**PASS.**

- e2e `teacher-agent.spec.ts` C6 describe: rows produced by the real batch
  run, the teacher asks, the scripted model calls `get_profile`, and the
  grounded answer cites `at <score>.` — the same digits read back from
  `profile:get` (the exact derivation the panel shows), cross-checked on
  the wire (`tool_call_id` + the score digits in the request body).
- The prompt constraint is pinned by `teacher.test.ts`: the profile's
  categories and numbers come only from the tool; inventing either is
  forbidden (en + zh-CN authored strings).
- Degradation unchanged: a tools-unsupported model never sees the profile
  (the tool registry is not offered), and the profile panel itself needs
  no LLM.

## C7 — Gates (cross-cutting)

**PASS.**

- A9 meta-coverage: `handlers.test.ts` asserts a registered handler for
  every `CHANNEL_NAMES` entry and an explicit per-channel exercise ledger;
  `packages/shared/test/ipc.test.ts` validates every envelope both
  directions (batch + profile included, with the closed-category-enum and
  count/refine violations as invalid cases); `scripts/test/ipc-doc.test.ts`
  fails the build when a channel is undocumented (`profile:get` was caught
  by exactly this test during Stage 4 — measured, not hypothetical).
- Mutation harnesses: `mutate-katago.mts` 95/95, `mutate-llm.mts` 38/38
  (including the M4 `get_profile` registry/fidelity anchors),
  `mutate-profile.mts` 80/80 — 0 escaped, 0 invalid in each.
- Full battery on the final tree: `pnpm lint` clean · `pnpm typecheck`
  clean (all five desktop tsconfigs + core + shared + scripts) ·
  `pnpm test` 1600 passed · `pnpm e2e` 45 passed · `format:check` /
  `check:i18n` / `check:licenses` / `check:trellis` green ·
  `pnpm build` + smoke launch of `out/` with an isolated profile (alive,
  `library.db` created) · `sqlite-abi` probe green.

## C8 — Packaging & platform (cross-cutting)

**PASS.**

- CI three-platform runs green on both stage commits this milestone
  (`0249a90` Stage 2, `975afb9` Stage 3): ubuntu-latest, windows-latest,
  macos-latest all `success` including the native `better-sqlite3` build
  leg and the packaged-launch gate.
- The ABI probe (`scripts/sqlite-abi.ts`) gates dev/e2e/package entries and
  the vitest globalSetup; the node-vs-electron binding flip is handled by
  the entry points themselves (measured again at the final gate: a smoke
  launch right after a vitest run fails on ABI until the entry script
  flips it — by design, and the reason every entry runs the probe first).
- Engine packaging unchanged (no regression surface): provenance test and
  checksum sidecar untouched and green in CI.

---

## Residual risks (recorded, accepted)

- **Category calibration is principle-led, not empirically validated**
  (M1 risk, accepted in scope): the four categories' thresholds are
  recorded constants with boundary tests, but no external strong-player
  validation has occurred. The evidence click-through exists precisely so
  real use can judge them.
- **Professional-rank detection is a pattern, not a parser.** SGF ranks are
  free text; an unrecognised pro notation lands in the profile until the
  user marks the game "not mine" — the documented escape hatch.
- **The e2e C5/C6 dependence on the fake engine's hash-seeded winrates**
  is deterministic (same content → same numbers on every platform) but the
  magnitude profile is a hash artifact; the specs deliberately assert the
  click-through and the citation digits rather than a specific category.
