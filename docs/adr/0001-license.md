# ADR 0001: License — GPL-3.0

**Status**: Accepted
**Date**: 2026-08-04

## Context

GoMentor draws design inspiration from two existing projects by the same
author:

- `wimi321/lizzieyzy-next` — a fork of `yzyray/lizzieyzy`, **GPL-3.0**
- `wimi321/GoAgent` — original work, **MIT**

GoMentor is new code, not a fork of either. But it targets the same problem
domain, and several planned features have a plausible derivation path from the
GPL-3.0 lineage:

- Fox (野狐) game-fetching behaviour
- `readboard` physical-board protocol, where the only available reference may
  be lizzieyzy-next's bundled binary
- Engine launcher configuration and packaging conventions
- Board rendering conventions inherited from the Lizzie family

## Decision

**GPL-3.0-or-later.**

## Rationale

The moment any file, asset, or reverse-engineered protocol is _derived_ from
the lizzieyzy lineage rather than independently reimplemented, GPL-3.0 becomes
mandatory. That is not a stylistic preference — it is the license's terms.

The asymmetry is what decides it:

- **Choosing GPL now and later finding we derived nothing**: we gave up the
  option of a proprietary fork. A cost, but a bounded one, and arguably
  desirable for a tool built on a GPL-adjacent ecosystem.
- **Choosing MIT now and later finding we derived something**: relicensing
  requires the consent of **every contributor**. On a project that hopes to
  attract community knowledge-base contributions, that ranges from painful to
  impossible.

GPL-3.0 also absorbs MIT one-way, so inspiration from GoAgent (MIT) carries no
friction.

## Alternatives considered

**MIT with a clean-room policy.** Viable only if the "derive nothing from
lizzieyzy-next" constraint is genuinely enforced — including _not_
reverse-engineering the readboard protocol from its GPL binary. That constraint
is real work to honour, not a sentence in a README, and violating it silently
creates a license defect that is expensive to discover late.

**AGPL-3.0** (as Trellis itself uses). Rejected: GoMentor is a desktop
application, not a network service. AGPL §13 buys nothing here while adding
adoption friction.

## Consequences

- `LICENSE` carries the full GPL-3.0 text (verified 674 lines, not a stub)
- `NOTICE` maintains a **license provenance ledger**. Contributors add a row in
  the same commit that introduces third-party or derived material. An empty
  ledger with derived code in the tree is a license defect.
- CI runs a dependency-license gate: any transitive dependency incompatible
  with GPL-3.0 fails the build. A license conflict is cheapest to find at
  commit time.
- Bundled KataGo (MIT) needs its license text shipped alongside the binaries,
  and each neural-net weight file needs its provenance recorded separately —
  MIT on the engine does not automatically cover the weights.
- A future proprietary fork is foreclosed. Accepted.
