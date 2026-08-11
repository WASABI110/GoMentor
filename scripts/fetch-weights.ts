/**
 * Fetches KataGo network weights into `apps/desktop/resources/weights`. **Stub.**
 *
 * Not implemented until M2. Paired with `fetch-katago.ts` — an engine without a
 * network cannot analyse anything, so neither script is useful alone, and both are
 * listed together in the delivery plan.
 *
 * ## What M2 has to get right here
 *
 * - **Which network, and it is a real trade-off.** b18 is ~30MB and fast; b28 is
 *   ~500MB and stronger. `design.md` §Tiered installer (D6) turns on this choice:
 *   the core download stays analysis-capable offline while the median download
 *   drops ~70%, which only works if the small network is the default and the large
 *   one is opt-in.
 * - **Checksum before use, again** — but for a different reason than the
 *   executable. A truncated `.bin.gz` is not a security problem, it is a confusing
 *   one: KataGo fails to load it with a message about the network file that reads
 *   like the wrong network was chosen.
 * - **Weights are versioned independently of the binary.** A network file and an
 *   engine build can be individually valid and mutually incompatible, so whatever
 *   this writes must record which network it fetched somewhere the engine layer
 *   can read.
 * - **Outside the asar**, same as the binary — KataGo opens this file itself, and
 *   a path inside an archive is not a path it can open.
 *
 * Run: `pnpm fetch:weights`
 */
import { RESOURCE_TARGETS, reportStub } from './resources'

const target = RESOURCE_TARGETS.find((entry) => entry.dir === 'weights')

if (target === undefined) {
  console.error("scripts/resources.ts no longer defines a 'weights' target.")
  process.exit(1)
}

process.exit(reportStub(target))
