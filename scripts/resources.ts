/**
 * Where the M2 engine payload lands, and what is true about it in M1.
 *
 * Split out from the two `fetch-*.ts` stubs so it can be tested and so the two
 * scripts cannot drift on the one fact that matters — the destination path.
 * `check-licenses.ts` / `licenses.ts` follow the same split for the same reason:
 * a top-level program cannot be imported by a test without running.
 *
 * ## The measured reason these directories contain a README
 *
 * `electron-builder.yml` copies three directories out of `apps/desktop/resources`
 * via `extraResources`, and its comment says the structure exists in M1 "so M2 is
 * purely additive". That was not true when it was written. The directories did not
 * exist, and electron-builder **skips a missing `from` silently** — the last
 * unpacked build's `resources/` held nothing but `app.asar`. Nothing failed;
 * nothing warned. M2 would have discovered it when the engine did not launch.
 *
 * A `.gitkeep` does not fix it either, and this is the part that is easy to get
 * wrong: `.gitkeep` is in electron-builder's own default ignore list (visible in
 * `dist/builder-debug.yml`), so a directory holding only a `.gitkeep` is still
 * empty as far as packaging is concerned. The placeholder has to be a file
 * electron-builder will actually copy, which is why it is a `README.md` with
 * content rather than an empty marker.
 *
 * And it has to be a file **git tracks**, which is a second trap and was not
 * satisfied by writing the README. `.gitignore` excluded
 * `apps/desktop/resources/katago/` — the directory itself — and git will not
 * re-include a file whose parent directory is excluded, so the README negation
 * was dead and two of the three READMEs were untracked. Locally the packaging
 * check passed; a fresh clone would have had no directory to copy. The pattern now
 * ends in a `*` rather than a slash, and `scripts/test/resources.test.ts` asks
 * `git ls-files` rather than the filesystem.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Repository root, from `scripts/`. */
export const REPO_ROOT = resolve(import.meta.dirname, '..')

/** The `extraResources` source root in `electron-builder.yml`. */
export const RESOURCES_ROOT = join(REPO_ROOT, 'apps', 'desktop', 'resources')

export interface ResourceTarget {
  /** Directory name under `resources/`, and the `from` in electron-builder.yml. */
  readonly dir: string
  /** What M2 will put there. */
  readonly holds: string
  /** Roughly how large, so a reader can judge the download before starting it. */
  readonly size: string
}

/**
 * The three `extraResources` directories, named here rather than in each script.
 *
 * `knowledge` has no fetch script: it is authored content that ships with the
 * repository rather than a download, so it is listed for the packaging check and
 * deliberately has no fetcher.
 */
export const RESOURCE_TARGETS: readonly ResourceTarget[] = [
  {
    dir: 'katago',
    holds: 'the KataGo executable and its OpenCL/CUDA/Eigen backends',
    size: '~30-80MB depending on backend',
  },
  {
    dir: 'weights',
    holds: 'one or more KataGo neural network files (.bin.gz)',
    size: '~30MB (b18) to ~500MB (b28)',
  },
  {
    dir: 'knowledge',
    holds: 'the curated joseki and teaching corpus (authored, not downloaded)',
    size: 'small',
  },
]

export function resourceDir(dir: string): string {
  return join(RESOURCES_ROOT, dir)
}

/**
 * Reports the stub's status and returns the exit code the script should use.
 *
 * ## Why this fails rather than succeeding quietly
 *
 * A stub that exits 0 tells its caller the resource is present. `pnpm package`
 * would then produce an installer with no engine in it and no indication that
 * anything was missing — which is precisely the failure mode the packaging note
 * above already caused once. So the contract is: this command exits non-zero
 * until it can actually deliver the binary. A caller wiring it into a pipeline
 * gets a loud stop, not a build that looks finished.
 *
 * It prints the destination and whether it exists, because "not implemented" on
 * its own leaves the reader unsure whether the directory question is also
 * unresolved.
 */
export function reportStub(target: ResourceTarget, milestone = 'M2'): number {
  const dir = resourceDir(target.dir)
  const present = existsSync(dir)

  console.error(`fetch-${target.dir}: not implemented until ${milestone}.`)
  console.error('')
  console.error(`  Destination : ${dir}`)
  console.error(`  Status      : ${present ? 'exists (empty of payload)' : 'MISSING'}`)
  console.error(`  Will hold   : ${target.holds}`)
  console.error(`  Size        : ${target.size}`)
  console.error('')

  if (!present) {
    // Worth separating: a missing directory is a packaging defect right now,
    // independent of the download being unimplemented. `extraResources` skips a
    // missing `from` without warning.
    console.error(
      '  The directory is absent, so electron-builder will silently copy nothing',
    )
    console.error(
      '  for it. Restore it with a README.md inside — see scripts/resources.ts.',
    )
    console.error('')
  }

  console.error(`Exiting non-zero on purpose: nothing was downloaded, and a zero exit`)
  console.error(`here would let a build report success while shipping no engine.`)

  return 1
}
