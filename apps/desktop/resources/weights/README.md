# `resources/weights`

Empty in M1. KataGo neural network files (`.bin.gz`) land here in M2, fetched by `pnpm fetch:weights`.

Copied outside the asar by `electron-builder.yml` through `extraResources`: KataGo opens the network file itself, and a path inside an archive is not a path it can open.

Which network ships is a real trade-off, not a default to pick later — b18 is ~30MB and fast, b28 is ~500MB and stronger. The tiered installer decision (D6) depends on the small network being the default and the large one opt-in; that is what keeps the core download analysis-capable offline while cutting the median download by roughly 70%.

## Why this file exists rather than a `.gitkeep`

See [`../katago/README.md`](../katago/README.md). Short version: electron-builder silently copies nothing for a missing source directory, and it ignores `.gitkeep`, so the placeholder has to be a real file. `scripts/test/resources.test.ts` fails if it goes missing.
