/**
 * GPU tier-2 backend selection (M5 Stage 4) — the pure ordering policy, kept
 * in core so the Electron layer cannot silently re-derive it.
 *
 * ## Why an explicit priority list and not a settings value
 *
 * The order (cuda → opencl → eigen) is a product decision about which engine
 * gives the best experience on hardware that can run more than one backend:
 * CUDA is fastest where present, OpenCL covers AMD/Intel GPUs and CUDA-less
 * machines, Eigen always works. The user's `settings.engine.backend` overrides
 * this order by naming ONE backend; when it is null ("auto"), this list is the
 * law. A plain filter over a fixed list — not a sort comparator, which would
 * let a settings value reorder what is a hardware-capability judgement.
 */

export type EngineBackend = 'cuda' | 'opencl' | 'eigen'

export const GPU_BACKENDS: readonly (Exclude<EngineBackend, 'eigen'>)[] = [
  'cuda',
  'opencl',
]

/** The auto-selection order, best-experience first. */
export const BACKEND_PRIORITY: readonly EngineBackend[] = ['cuda', 'opencl', 'eigen']

/**
 * The backends to try, highest priority first, given what is available
 * (i.e. downloaded). A user-named backend collapses the list to exactly that
 * one — an explicit choice must not be silently outranked, but it can also
 * fail: the caller falls back per `BACKEND_PRIORITY` when it does.
 */
export function selectBackend(
  available: readonly EngineBackend[],
  preference: EngineBackend | null,
): EngineBackend[] {
  if (preference !== null) {
    return available.includes(preference) ? [preference] : []
  }
  return BACKEND_PRIORITY.filter((backend) => available.includes(backend))
}
