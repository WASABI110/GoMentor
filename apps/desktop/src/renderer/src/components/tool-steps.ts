/**
 * Pure display logic for the teacher panel's tool steps (M3 Stage 3, R5).
 *
 * In its own module — not inside `ToolSteps.tsx` — because it is the part that
 * is unit-tested, and the desktop vitest project runs in a node environment
 * with no JSX transform (`test/renderer/` holds store tests only; see the note
 * in `winrate-graph-pending.test.ts`). Importing the component would drag React
 * into tests that only need two functions.
 *
 * Both payloads a step shows — a call's arguments and its result — are stored
 * whole in `chatStore` and bounded *here*, where the bound is a display
 * decision: a preview that hides "and 400 more characters" is a layout choice,
 * while truncating in the store would make the expand control a lie about data
 * that did arrive.
 */

/** How much of a result is shown before the expand control appears. */
export const RESULT_PREVIEW_LIMIT = 120

/** How much of an arguments payload is shown inline. */
export const ARGS_PREVIEW_LIMIT = 80

/** First `max` characters, with an ellipsis only when something was cut. */
export function summariseText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

const ERROR_RESULT_PATTERN = /^[A-Z][A-Z0-9_]*: /

/**
 * Whether a result content carries the `CODE: message` shape main fails with.
 *
 * `chatChunkSchema`'s `tool_result` chunk carries no `isError` field — the
 * union predates the agent loop and gained no new field when the loop landed,
 * because keeping the IPC surface unchanged was a design constraint. The model
 * reads success from the same text the renderer has: main prefixes a failed
 * outcome with its domain code (`IPC_INVALID_REQUEST: …`, `ENGINE_UNAVAILABLE:
 * …`), so a leading code is the shape a failure has, and this reads that shape.
 * It is a presentation hint only — tinting a row — and never a control-flow
 * decision; the real `isError` travelled to main's loop, which acted on it
 * before this text was ever sent.
 */
export function looksLikeErrorResult(content: string): boolean {
  return ERROR_RESULT_PATTERN.test(content)
}
