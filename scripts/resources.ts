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
    // M2 reality (was "OpenCL/CUDA/Eigen backends" from the M1 plan): the core
    // tier bundles the Eigen CPU build only, per-platform under
    // `<platform>-<arch>/` subdirectories (scope decision 1).
    holds: 'the KataGo Eigen CPU executable, per-platform under <platform>-<arch>/',
    size: '~6MB (win exe) / ~40MB (linux AppImage payload)',
  },
  {
    dir: 'weights',
    // The bundled net is the final g170 b6c96 in the legacy text format
    // (`.txt.gz`) — see research/katago-networks.md and katago-manifest.ts.
    // Swapped from b10c128 by the benchmark gate; b10c128 (bigger, stronger,
    // slower) is the recorded alternative.
    holds: 'the bundled KataGo neural network (b6c96 g170 final, .txt.gz)',
    size: '~5MB',
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
