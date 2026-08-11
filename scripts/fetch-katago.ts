/**
 * Fetches the KataGo executable into `apps/desktop/resources/katago`. **Stub.**
 *
 * Not implemented until M2, which is when the engine is introduced (`M1` ships
 * `engine:status: 'unavailable'` permanently and every feature works without an
 * engine). This file exists now so the command name, the destination path, and
 * the failure behaviour are settled, and so M2 is an implementation rather than a
 * design question.
 *
 * ## What M2 has to get right here
 *
 * Recorded now because these are the parts that are easy to discover late:
 *
 * - **Platform × backend, not just platform.** KataGo ships separate builds for
 *   OpenCL, CUDA, TensorRT, and Eigen (CPU). The right one depends on the user's
 *   GPU, not on their OS, and `design.md` specifies that the backend is *measured*
 *   by benchmarking candidates rather than inferred from configuration.
 * - **Verify a checksum before trusting the download.** This is an executable that
 *   will be spawned as a child process. An unverified binary from a redirect is a
 *   code-execution path, and the check belongs here rather than at spawn time.
 * - **The file must land outside the asar.** That is already arranged —
 *   `electron-builder.yml` copies this directory through `extraResources` — but a
 *   future refactor that moves it inside makes the engine unspawnable.
 * - **Resume and re-run.** At 30-80MB on a bad connection, a partial download must
 *   not leave a truncated executable that passes an existence check.
 *
 * Run: `pnpm fetch:katago`
 */
import { RESOURCE_TARGETS, reportStub } from './resources'

const target = RESOURCE_TARGETS.find((entry) => entry.dir === 'katago')

if (target === undefined) {
  // Narrowed rather than asserted with `!`: if the entry is ever renamed, this
  // says so instead of failing later on an undefined property read.
  console.error("scripts/resources.ts no longer defines a 'katago' target.")
  process.exit(1)
}

process.exit(reportStub(target))
