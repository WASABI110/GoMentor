/**
 * A bounded line buffer: the last N lines pushed, oldest dropped first.
 *
 * KataGo is extremely chatty on stderr — startup banners, tuning progress,
 * per-query statistics — and that chatter is exactly what diagnoses a crash
 * after the fact. Logging it all would flood the log file
 * (`logging-guidelines.md` calibrates engine stderr as `debug` for a reason),
 * and dropping it all would leave a `failed` status carrying none of the
 * engine's own last words. So: everything lands here (bounded, so a noisy
 * engine cannot grow memory without limit), a throttled subset reaches the log
 * at debug, and the whole tail is dumped at `warn` when the process dies
 * unexpectedly (`design.md` §Operational).
 *
 * Pure by construction: no clock, no I/O, no logging. That is what makes the
 * bound itself unit-testable and mutation-covered — "the buffer is bounded" is
 * exactly the kind of claim a green suite otherwise cannot distinguish from
 * "the buffer exists".
 */

export interface LineBuffer {
  /** Adds a line, dropping the oldest when the buffer is full. */
  push(line: string): void
  /** The retained lines, oldest first. A copy — callers cannot mutate state. */
  lines(): readonly string[]
  /** Empties the buffer. */
  clear(): void
}

/**
 * `capacity` must be >= 1. That is a programmer invariant (both call sites
 * pass constants), so there is deliberately no runtime validation and no
 * failure mode to test — the type and the call sites are the whole contract.
 */
export function createLineBuffer(capacity: number): LineBuffer {
  let lines: string[] = []

  return {
    push(line) {
      lines.push(line)
      if (lines.length > capacity) {
        // `slice`, not an index write: keeping `lines` a fresh array on the
        // trim path avoids the classic ring-buffer aliasing bug where a
        // retained reference to the old array observes future writes.
        lines = lines.slice(lines.length - capacity)
      }
    },
    lines() {
      return [...lines]
    },
    clear() {
      lines = []
    },
  }
}
