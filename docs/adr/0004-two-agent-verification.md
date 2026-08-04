# ADR 0004: Two-agent verification — separate the fixer from the judge

**Status**: Accepted
**Date**: 2026-08-04

## Context

Trellis ships a `trellis-check` sub-agent that reviews the git diff against the
task artifacts and `.trellis/spec/`, **self-fixes** what it finds, and runs
typecheck and lint. That is genuinely useful and covers convention conformance
well.

The requirement was to add a check on delivered code and functionality. The
naive response is to add a second agent that does the same thing. Before doing
that, we looked at what `trellis-check` actually leaves uncovered.

Two gaps, both real:

**1. It verifies conformance, not function.** It runs typecheck and lint. It
does not run the test suite, does not launch the app, and does not read the
acceptance criteria. So the R2 Trellis-immutability guard, A10's "the API key
must not appear in any log file", and A3's board-rendering correctness are all
outside its loop entirely.

**2. It self-fixes, so finding and judging are the same agent.** This is
efficient, and for convention violations it is the right design — an unused
import should just be removed. But it means no independent review of whether a
fix is correct.

That second gap matters specifically because of _this_ project's failure modes.
Several things here can be wrong while every test appears green:

- SGF unknown-property preservation (drop them silently and round-trip tests still pass)
- The GTP `I`-skip in coordinate conversion (a test that never crosses `I` proves nothing)
- The `safeStorage` unavailable path (a plaintext fallback "works")
- The preload sandbox boundary (a leak is invisible until exploited)
- A meta-test that passes vacuously

For failure modes that look right, a self-graded fix is the wrong shape.

## Decision

Add **`gomentor-verify`**, a read-only verification agent, at every stage gate,
running _after_ `trellis-check`.

|                   | `trellis-check`                              | `gomentor-verify`                                               |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------- |
| Question          | Does this follow our conventions and design? | Does this actually work, per the acceptance criteria?           |
| Runs              | typecheck, lint                              | full test suite, R2 guard, license/i18n gates, targeted smoke   |
| **May edit code** | **Yes — self-fixes**                         | **No — `Read, Bash, Glob, Grep` only**                          |
| Output            | fixes applied                                | per-acceptance-ID `PASS`/`FAIL`/`NOT-APPLICABLE-YET` + evidence |

Gate order: implement → `trellis-check` → `gomentor-verify` → main session acts
on FAILs. Verify runs last so it judges the post-fix state.

## Rationale for read-only

**The absence of `Write` and `Edit` is the load-bearing part of this design.**

An agent that can fix what it finds will rationalise its own fix as correct —
which is precisely the conflation this role exists to break. Denying it write
access forces every finding to surface as a verdict the main session has to act
on. A failure cannot be quietly absorbed into a fix that was never reviewed.

This costs a round-trip on every real finding. That cost is the feature.

## Verdict discipline

Two rules in the agent definition exist because they are how this kind of gate
degrades into theatre:

1. **A criterion it could not test is `NOT-APPLICABLE-YET`, never `PASS`.**
   Silence must not read as success.
2. **"Tests pass" is not evidence a criterion is met.** A5 requires a real
   ≥20-file corpus; a green run over 3 synthetic fixtures is a FAIL on A5.

And a third, on scope: if the verifier believes a criterion is itself wrong, it
reports that for the main session to resolve by **amending the PRD explicitly**.
It never reinterprets a criterion into something easier and passes it.

## Alternatives considered

**Strengthen `trellis-check` via spec instead.** Write the test-running and
acceptance-checking requirements into `.trellis/spec/backend/quality-guidelines.md`
and let the built-in agent do it all. Cheapest option, and we did write those
requirements into the spec regardless — they are useful there. Rejected as the
_only_ measure because it leaves finding and judging in the same agent, which
is gap 2 unaddressed.

**Adversarial panel** — 2–3 agents per high-risk item, each prompted to refute
the implementation, majority-refute to fail. Meaningfully stronger for the
"wrong but looks right" cases. Deferred: substantially higher token cost, and
the read-only verifier plus the substance rules in the spec address the same
failure modes at a fraction of the price. Revisit if verified-then-broken
regressions actually occur.

## Consequences

- Every stage gate has two agent passes, so gates cost more wall-clock
- `.claude/agents/gomentor-verify.md` lives under a path R2 declares immutable
  to _app code and CI_. Authoring an agent definition is a workflow action, not
  app code, so this is permitted — but it must sit outside any Trellis-managed
  block, and the R2 guard is re-run after adding it
- Acceptance IDs are scoped per stage; the full A1–A16 sweep runs at the final
  gate, re-confirming earlier IDs since a Stage 3 PASS can regress by Stage 6
- A16 was added to the PRD: every ID must carry a recorded verdict with
  evidence, and no FAIL may be open at the final gate
