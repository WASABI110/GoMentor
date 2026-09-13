import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KATAGO_MANIFEST } from '../katago-manifest'
import { REPO_ROOT } from '../resources'

/**
 * The manifest's provenance obligations, the two a manifest exists to carry:
 *
 * 1. **NOTICE must name what we ship** (D4). The KataGo engine and net are not
 *    npm packages, so `check:licenses` never sees them — this ledger line is
 *    the only provenance record for the largest binaries in the installer.
 *    Anchoring the test to the manifest (not hardcoded strings) means a rename
 *    or license change on either side fails here instead of drifting.
 * 2. **No URL ships on inference** (implement.md Stage 1). The research was
 *    written from a network that blocked release-asset downloads, so every URL
 *    is probed live with a `Range: 0-0` request. A probe that cannot connect
 *    (offline, or a network that blocks the host — both measured at planning
 *    time) skips; a reachable URL that does not answer 200/206 fails.
 */

const NOTICE_PATH = join(REPO_ROOT, 'NOTICE')

describe('NOTICE names the bundled binary payloads (D4)', () => {
  const notice = readFileSync(NOTICE_PATH, 'utf8')

  it('names the pinned engine version and its license', () => {
    expect(notice).toContain('KataGo')
    expect(notice).toContain(KATAGO_MANIFEST.engine.version)
    expect(notice).toContain(KATAGO_MANIFEST.engine.license) // MIT
  })

  it('names the bundled net file and its license', () => {
    expect(notice).toContain(KATAGO_MANIFEST.weights.name)
    expect(notice).toContain(KATAGO_MANIFEST.weights.license) // CC0-1.0
  })

  it('targets exactly the platforms the tooling supports', () => {
    // M5: darwin joined as CI source builds (upstream publishes no macOS
    // binaries, so those payloads come from GoMentor's own release — pinned in
    // `sourceBuilds`). Every target the manifest declares must appear here; a
    // new platform is a deliberate act that touches this assertion.
    expect(Object.keys(KATAGO_MANIFEST.engine.targets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64',
    ])
    // The darwin payloads must never point at upstream: no official macOS
    // release exists, so a URL resolved from upstream's downloadBase would 404
    // (or worse, start resolving if upstream ever ships one — the source-built
    // bytes would then differ from the pinned hash).
    for (const target of ['darwin-arm64', 'darwin-x64'] as const) {
      expect(KATAGO_MANIFEST.engine.sourceBuilds.builds[target]).toBeDefined()
    }
    expect(KATAGO_MANIFEST.engine.sourceBuilds.buildRef).toBe(
      KATAGO_MANIFEST.engine.version,
    )
  })
})

describe('manifest URLs resolve (live probe, skipped offline)', () => {
  const urls = [
    ...(
      Object.keys(
        KATAGO_MANIFEST.engine.targets,
      ) as readonly (keyof typeof KATAGO_MANIFEST.engine.targets)[]
    ).map(
      (target) =>
        // darwin assets resolve against GoMentor's source-build release, not
        // upstream's — same resolution the fetcher uses (engineDownloadBase),
        // asserted here rather than imported so the test cannot share a bug
        // with the code it tests.
        `${
          target.startsWith('darwin-')
            ? KATAGO_MANIFEST.engine.sourceBuilds.downloadBase
            : KATAGO_MANIFEST.engine.downloadBase
        }/${KATAGO_MANIFEST.engine.targets[target].file}`,
    ),
    KATAGO_MANIFEST.weights.url,
    KATAGO_MANIFEST.fallbackWeights.url,
  ]

  it.each(urls)('%s', { timeout: 20_000 }, async (url) => {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      // Offline, or a network that blocks the host (GitHub release assets were
      // measured blocked from the planning network). Nothing to assert.
      return
    }
    try {
      expect(
        response.status === 200 || response.status === 206,
        `GET ${url} answered HTTP ${String(response.status)}`,
      ).toBe(true)
    } finally {
      // Release the socket whether or not the server honoured the 1-byte range.
      await response.body?.cancel().catch(() => undefined)
    }
  })
})
