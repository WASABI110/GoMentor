# ADR 0003: Tiered installer, not a single 500MB bundle

**Status**: Accepted
**Date**: 2026-08-04

## Context

GoMentor bundles KataGo so analysis works without the user hunting down an
engine, a config file, and a neural net — the setup friction that keeps most
players from ever using engine analysis. The promise is **zero configuration on
first launch**.

Delivering that literally means shipping every KataGo backend (TensorRT, CUDA,
OpenCL, Eigen) plus several neural nets. That is a **500MB+ installer**.

The initial decision was to do exactly that. On review, the cost landed harder
than expected:

- 500MB is a real download-abandonment rate, not a rounding error
- Auto-update blockmap diffing gets much less effective at that size
- The primary audience is in mainland China, where GitHub Releases bandwidth is
  poor — a 500MB download there is genuinely painful
- Most of the payload is **dead weight on any given machine**: a user with an
  RTX card never runs the OpenCL build, and a CPU-only user never touches CUDA

## Decision

**Tiered installer.**

| Tier               | Contents                                                 | Size    |
| ------------------ | -------------------------------------------------------- | ------- |
| **Core** (default) | App + Eigen (CPU) backend + one small net (b6/b10)       | ~120MB  |
| **On-demand**      | The one accelerated backend the machine can actually use | ~180MB  |
| **Full offline**   | Everything, as a separate release asset                  | ~500MB+ |

On first run, backend detection reports what the machine supports and offers the
accelerated download — with checksum verification and resumable transfer.

## Rationale

The core tier is **analysis-capable offline on first launch**. That is what
makes this a real tiering rather than a bait-and-switch: the zero-config promise
holds _literally_, because a fresh install can analyse a game with no network
and no configuration. The GPU download is an optimisation ("~40x faster"), not
an unlock.

This is the distinction that decides it. A core installer that could not analyse
until it downloaded something would break the promise; one that analyses slowly
until you opt into speed does not.

Secondary effects:

- Median download drops roughly 70%
- Auto-update blockmaps stay small, since the frequently-changing part (app
  code) is separated from the static part (engine binaries)
- The full offline bundle covers users behind restrictive networks — a real
  constraint for this audience, not a hypothetical

## Alternatives considered

**Single 500MB bundle.** Simplest to build and reason about, and genuinely the
best first-run experience for someone with fast bandwidth. Rejected on download
abandonment and update-size grounds.

**No bundling — user supplies KataGo** (the lizzieyzy-next approach). ~10MB app,
maximum user control, and a natural fit for pointing at a remote engine.
Rejected because it reintroduces exactly the setup friction this project exists
to remove. Kept as an _advanced option_: users may point at their own KataGo
binary or a remote engine.

**Cloud-first with local as fallback.** Rejected as a default: it makes a
private, local-first study tool depend on someone else's uptime and puts the
user's game records on a third-party server.

## Consequences

- `electron-builder.yml` places engine binaries and weights in
  `extraResources` (outside the asar) so they can be spawned as child processes
  and so blockmap diffing stays effective
- `scripts/fetch-katago.ts` and `scripts/fetch-weights.ts` handle build-time
  population and first-run download, both with checksum manifests
- Engine state must be a first-class enum including `downloading` — the download
  is a normal state with UI, not an error path
- **Download hosting is an open question.** GitHub Releases works initially, but
  a mainland-China CDN or mirror should be planned during M2
- The full-offline release asset is extra release-engineering work per version
- Backend detection becomes load-bearing: it decides what the user is offered,
  so probing by actually launching each candidate with a benchmark query (rather
  than parsing GPU vendor strings) is the reliable approach
