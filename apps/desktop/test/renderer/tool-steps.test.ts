import { describe, expect, it } from 'vitest'
import {
  ARGS_PREVIEW_LIMIT,
  RESULT_PREVIEW_LIMIT,
  looksLikeErrorResult,
  summariseText,
} from '../../src/renderer/src/components/tool-steps'

/**
 * The tool-step display helpers (M3 Stage 3).
 *
 * ## Why these are tested at all
 *
 * They are small, but each encodes a decision the e2e suite can only see the
 * *result* of. `RESULT_PREVIEW_LIMIT` is the design's "~120 characters" bound,
 * and the e2e asserts a preview is shorter than the data behind it — if the
 * constant silently became 4000, nothing in the e2e would notice and every
 * result would render in full. `looksLikeErrorResult`'s pattern is the shape
 * main's failure prefix takes; a regression there silences the one visual hint
 * that a tool errored, since the chunk union deliberately carries no `isError`
 * field.
 */

describe('summariseText', () => {
  it('returns short text verbatim, with no ellipsis', () => {
    expect(summariseText('{"moveNumber":10}', 120)).toBe('{"moveNumber":10}')
  })

  it('returns text of exactly the limit verbatim', () => {
    const exact = 'a'.repeat(RESULT_PREVIEW_LIMIT)
    // The boundary is where the expand control starts to exist; treating the
    // exact-limit case as truncated would add a control that reveals nothing.
    expect(summariseText(exact, RESULT_PREVIEW_LIMIT)).toBe(exact)
    expect(summariseText(exact, RESULT_PREVIEW_LIMIT)).not.toContain('…')
  })

  it('cuts longer text to the limit and marks it', () => {
    const long = 'b'.repeat(400)
    const shown = summariseText(long, RESULT_PREVIEW_LIMIT)

    expect(shown).toHaveLength(RESULT_PREVIEW_LIMIT + 1)
    expect(shown.endsWith('…')).toBe(true)
    // The visible prefix must be the data's own opening, not a reformatted
    // summary — the model's numbers are quoted from it.
    expect(shown.startsWith('b'.repeat(RESULT_PREVIEW_LIMIT))).toBe(true)
  })

  it('is applied per payload, so the arguments bound is independent', () => {
    const args = 'c'.repeat(ARGS_PREVIEW_LIMIT + 10)
    expect(summariseText(args, ARGS_PREVIEW_LIMIT)).toHaveLength(ARGS_PREVIEW_LIMIT + 1)
  })
})

describe('looksLikeErrorResult', () => {
  it('recognises the CODE: prefix main puts on a failed outcome', () => {
    // The prefixes `main/llm/agent/tools.ts` actually emits: a validation
    // failure, an absent record, an engine that is down, and a query that died.
    expect(looksLikeErrorResult('IPC_INVALID_REQUEST: invalid arguments []')).toBe(true)
    expect(
      looksLikeErrorResult('LIBRARY_NOT_FOUND: no game in the library has id g1'),
    ).toBe(true)
    expect(looksLikeErrorResult('ENGINE_UNAVAILABLE: the engine is not running')).toBe(
      true,
    )
    expect(looksLikeErrorResult('ENGINE_QUERY_FAILED: no response arrived')).toBe(true)
  })

  it('does not mark a successful result as an error', () => {
    // Tool success payloads are JSON objects, which open with a brace — never
    // with a code. This is the shape every healthy step row takes.
    expect(
      looksLikeErrorResult('{"gameId":"g1","winrate":0.5371,"candidates":[]}'),
    ).toBe(false)
    expect(looksLikeErrorResult('')).toBe(false)
  })

  it('does not mistake prose or nested codes for a failure prefix', () => {
    // A lowercase first word, however code-like, is not the failure shape.
    expect(looksLikeErrorResult('ipc_invalid_request: invalid arguments')).toBe(false)
    // A code appearing mid-text is content (a model quoting an error), not the
    // outcome marker.
    expect(
      looksLikeErrorResult('The call failed with IPC_INVALID_REQUEST: bad input'),
    ).toBe(false)
  })
})
