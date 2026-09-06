/**
 * Fetches the KataGo network weights into `apps/desktop/resources/weights`. **Real.**
 *
 * Replaces the M1 stub. Paired with `fetch-katago.ts` — an engine without a
 * network cannot analyse anything, so neither script is useful alone.
 *
 * ## Which network, and it is a real trade-off
 *
 * The bundled core-tier net is the final g170 **b6c96** (`research/katago-networks.md`):
 * 4.97 MiB, CC0. The original recommendation was the stronger b10c128
 * (13.79 MiB, site Elo 11521.7), but the Stage-2 benchmark gate measured it
 * outside the live-analysis latency envelope on the reference CPU (500-visit
 * reads in ~8.1s vs b6c96's ~3.4s — the pre-agreed contingency in the task's
 * implement.md), and b6c96 additionally cuts the bundled net by ~9MB. b10c128
 * remains the recorded stronger-but-slower alternative in the manifest. Both
 * are `.txt.gz`: the g170 imports return 403 for `.bin.gz` (verified) and
 * KataGo v1.18 loads the text format.
 *
 * ## Checksum before use
 *
 * A truncated `.txt.gz` is not a security problem, it is a confusing one: KataGo
 * fails to load it with a message about the network file that reads like the
 * wrong network was chosen. sha256 is recorded TOFU (see katago-manifest.ts).
 *
 * ## Weights are versioned independently of the binary
 *
 * A network file and an engine build can be individually valid and mutually
 * incompatible. The manifest records which net ships (`weights.name`), so the
 * engine layer can read it rather than guess.
 *
 * Run: `pnpm fetch:weights`
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KATAGO_MANIFEST,
  applyRecordedChecksums,
  persistRecordedChecksums,
  readRecordedChecksums,
} from './katago-manifest'
import { ensureFetched, weightsDir } from './fetch-engine'
import { RESOURCES_ROOT } from './resources'

/**
 * Nets are weight archives; READMEs and sidecars are not. The weights dir ships
 * verbatim through `extraResources` (no per-file manifest knowledge in the
 * packager), so anything archive-shaped that is not the pinned primary would
 * ride into every installer — measured hazard: after swapping the bundled net
 * in the manifest, the previous primary stayed on disk and silently grew the
 * tier by its size. Pruned here, at the one place that knows the pin.
 */
const WEIGHT_ARCHIVE = /\.(txt|bin)(\.gz)?$/

async function pruneNonPrimaryWeights(dir: string, primary: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (entry === primary || !WEIGHT_ARCHIVE.test(entry)) continue
    await rm(join(dir, entry), { force: true })
    console.log(`weights: pruned ${entry} (not the pinned primary)`)
  }
}

async function main(): Promise<void> {
  // Sidecar first: once a recorded hash exists, this run verifies against it
  // instead of recording a fresh one (TOFU — see katago-manifest.ts).
  applyRecordedChecksums(readRecordedChecksums())

  const net = KATAGO_MANIFEST.weights
  const wasUnpinned = net.sha256 === null
  const result = await ensureFetched(net, net.url, weightsDir(RESOURCES_ROOT))
  persistRecordedChecksums()
  await pruneNonPrimaryWeights(weightsDir(RESOURCES_ROOT), net.name)

  const verb = result.reused ? 'reused' : 'fetched'
  console.log(`weights: ${verb} ${net.name} (${net.license}) -> ${result.path}`)
  console.log(
    `weights: sha256 ${result.sha256}${wasUnpinned ? ' (recorded TOFU -> scripts/katago-checksums.json)' : ' (verified)'}`,
  )
}

main().catch((error: unknown) => {
  console.error('fetch-weights failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
