# `resources/katago`

Empty in M1. The KataGo executable lands here in M2, fetched by `pnpm fetch:katago`.

`electron-builder.yml` copies this directory to `resources/katago` in the packaged app through `extraResources`, which puts it **outside the asar** — deliberately, for two reasons. KataGo is spawned as a child process and an OS cannot exec a path inside an archive; and at 120MB+ with weights, keeping the payload out of the asar is what keeps auto-update blockmap diffing effective.

## Why this file exists rather than a `.gitkeep`

Git needs a file to track a directory, and this directory has to exist before packaging, because electron-builder **skips a missing `extraResources` source silently** — no warning, no error, just nothing copied. That already happened here: an unpacked build's `resources/` contained only `app.asar`, while `electron-builder.yml` claimed the structure was in place so M2 would be "purely additive".

A `.gitkeep` would satisfy git and not fix packaging: `.gitkeep` appears in electron-builder's default ignore list (see `dist/builder-debug.yml`), so a directory containing only a `.gitkeep` is still empty as far as the packager is concerned. This README is a file it will actually copy.

Deleting this file re-breaks packaging in a way nothing reports. `scripts/test/resources.test.ts` fails if it goes missing.
