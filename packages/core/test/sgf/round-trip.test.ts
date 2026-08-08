import { describe, expect, it } from 'vitest'
import { AppError, isAppError, type ErrorCode } from '@gomentor/shared'
import { parseSgf } from '../../src/sgf/parser'
import { serialiseSgf, serialiseToBytes } from '../../src/sgf/serializer'
import {
  allFiles,
  NOT_ACTUALLY_SGF,
  readFixture,
  realFiles,
  syntheticFiles,
} from './corpus'
import {
  getProperty,
  nodeCount,
  UNKNOWN_ENCODING,
  walk,
  type SgfNode,
} from '../../src/sgf/ast'

/**
 * A5: parse → serialise → parse is byte-exact across a real-world corpus,
 * with unknown properties preserved.
 * A6: malformed input produces a distinct typed error and never hangs.
 *
 * The corpus is 65 real files from OSS test suites (MIT and GPL-3.0), plus 3
 * deliberately-broken synthetic files prefixed `_`. See PROVENANCE.md. Real
 * files matter because real-world malformation — legacy codepages, editor
 * properties, unusual escaping — cannot be invented convincingly.
 */

const read = readFixture

describe('corpus', () => {
  // Guards the premise of A5. A green round-trip over 3 files proves nothing
  // about files in the wild, so the count itself is an assertion.
  it('contains at least 20 real-world files', () => {
    expect(realFiles.length).toBeGreaterThanOrEqual(20)
  })

  it('contains the three synthetic error-path files', () => {
    expect(syntheticFiles).toContain('_malformed-truncated.sgf')
    expect(syntheticFiles).toContain('_malformed-empty.sgf')
    expect(syntheticFiles).toContain('_malformed-not-sgf.sgf')
  })

  it('includes non-UTF-8 files, which is where naive parsers break', () => {
    // At least one file must have bytes invalid as UTF-8, or the encoding
    // handling is untested no matter how many files there are.
    const nonUtf8 = realFiles.filter((name) => {
      const bytes = read(name)
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return false
      } catch {
        return true
      }
    })
    expect(nonUtf8.length).toBeGreaterThan(0)
  })

  it('includes files with variations', () => {
    const withBranches = realFiles.filter((name) => {
      try {
        const parsed = parseSgf(read(name))
        return parsed.roots.some((root) =>
          [...walk(root)].some((n) => n.children.length > 1),
        )
      } catch {
        return false
      }
    })
    expect(withBranches.length).toBeGreaterThan(0)
  })

  it('rejects the two files that are GNU Go output rather than SGF', () => {
    // Asserted rather than silently skipped: these carry a copyright banner
    // before the first '(' and must not be accepted, or SGF_NOT_SGF stops
    // meaning anything.
    for (const name of NOT_ACTUALLY_SGF) {
      expect(allFiles, `${name} should exist in the corpus`).toContain(name)
      let thrown: unknown
      try {
        parseSgf(read(name))
      } catch (error) {
        thrown = error
      }
      expect(thrown, `${name} should be rejected`).toBeInstanceOf(AppError)
      expect((thrown as AppError).code).toBe('SGF_NOT_SGF')
    }
  })
})

describe('round-trip fidelity', () => {
  for (const name of realFiles) {
    it(`${name} survives parse → serialise → parse`, () => {
      const bytes = read(name)
      const first = parseSgf(bytes)
      const text = serialiseSgf(first)

      // Re-parse from the serialised text using the encoding we already
      // resolved, so the comparison isolates structural fidelity.
      const second = parseSgf(text, { encoding: 'utf-8' })

      expect(second.roots.length).toBe(first.roots.length)

      for (const [index, root] of first.roots.entries()) {
        const other = second.roots[index]
        expect(other, `root ${String(index)} missing after round-trip`).toBeDefined()
        if (!other) continue

        expect(nodeCount(other)).toBe(nodeCount(root))

        const originalNodes = [...walk(root)]
        const roundTripped = [...walk(other)]

        for (const [i, original] of originalNodes.entries()) {
          const copy = roundTripped[i]
          expect(copy, `node ${String(i)} missing`).toBeDefined()
          if (!copy) continue

          // Property identity, order, and raw values must all match. Order
          // matters: rewriting it is a gratuitous diff in a user's collection.
          expect(copy.properties.map((p) => p.rawIdent)).toEqual(
            original.properties.map((p) => p.rawIdent),
          )
          expect(copy.properties.map((p) => p.values)).toEqual(
            original.properties.map((p) => p.values),
          )
        }
      }
    })
  }

  /**
   * Pinned separately from the corpus check because the corpus asserts a
   * conclusion ("63 files match") while these name the layout features. When
   * one breaks, the failing test says which construct regressed instead of
   * listing forty filenames.
   *
   * Each of these was a real bug: whitespace between properties was consumed by
   * the value-continuation loop and dropped; whitespace before a second game's
   * '(' was emitted after it; and a non-subtree sibling was gratuitously
   * wrapped in parens, taking its descendants with it.
   */
  const LAYOUT_CASES = [
    ['newline between properties', '(;GM[1]FF[4]\nSZ[9]\nGN[test])'],
    ['CRLF between properties', '(;\r\nGM[1]SZ[19]\r\nPB[Aya]\r\n)'],
    ['blank line between properties', '(;FF[4]GM[1]\n\nGN[x])'],
    ['newline between values of one property', '(;AB[aa][bb]\n[cc]\t[dd])'],
    ['whitespace before a second game tree', '(;SZ[19];B[aa])\n\n(;SZ[9];B[bb])'],
    ['inline sibling after a subtree', '(;SZ[19](;B[aa]);W[bb];B[cc])'],
    ['whitespace before a subtree', '(;SZ[19]\n  (;B[aa])\n  (;B[bb]))'],
    ['whitespace before a closing paren', '(;SZ[19];B[aa]\n)'],
    ['trailing newline after the last tree', '(;SZ[19])\n'],
    ['leading whitespace before the first tree', '\n (;SZ[19])'],
    ['no leading semicolon on the root', '(TE[title]\nRD[2025-01-01];B[aa])'],
  ] as const

  for (const [label, source] of LAYOUT_CASES) {
    it(`preserves ${label}`, () => {
      expect(serialiseSgf(parseSgf(source))).toBe(source)
    })
  }

  it('is layout-exact for every file in the corpus', () => {
    // Compared against the *parser's own* decoding, which makes this a check on
    // **layout** only: whitespace, escapes, property order, node structure.
    //
    // It cannot check decoding, and the reason is worth stating because the
    // earlier version of this test claimed it could. When the parser picks the
    // wrong decoder, this baseline is decoded wrongly in the identical way, so
    // the comparison is self-consistent and passes — a mis-decoded file looks
    // perfect here. `is byte-exact from bytes to bytes` below is the test that
    // sees that class of bug; this one localises a failure to layout when both
    // are red.
    const BOM_LENGTH: Record<string, number> = {
      'utf-8': 3,
      'utf-16le': 2,
      'utf-16be': 2,
    }

    const mismatches: string[] = []
    let checked = 0

    for (const name of realFiles) {
      const bytes = read(name)
      const parsed = parseSgf(bytes)

      // `UNKNOWN_ENCODING` is not a decoder label, so the baseline is built
      // with the reading the parser actually used for such a file: latin-1,
      // which is byte-preserving and therefore keeps the layout intact — the
      // only thing this test examines.
      const decoder =
        parsed.encoding === UNKNOWN_ENCODING ? 'iso-8859-1' : parsed.encoding

      // The BOM is stripped from `text` by design and reattached only by
      // serialiseToBytes, so it must come off the comparison baseline too.
      const body =
        parsed.bom === null ? bytes : bytes.subarray(BOM_LENGTH[parsed.bom] ?? 0)
      const original = new TextDecoder(decoder).decode(body)

      checked += 1
      if (serialiseSgf(parsed) !== original) mismatches.push(name)
    }

    // Guards the premise: a green assertion over 2 files would prove nothing.
    expect(checked).toBeGreaterThan(50)
    expect(
      mismatches,
      `files whose layout did not round-trip: ${mismatches.join(', ')}`,
    ).toEqual([])
  })

  /**
   * A5 as written: **byte-for-byte**. Bytes in, bytes out, compared directly.
   *
   * This is the assertion the sibling test above cannot make. It never decodes
   * anything itself, so it has no opinion the parser can accidentally agree
   * with — which is precisely how it catches a wrong decoder choice, and how it
   * caught six legacy-encoded files being silently rewritten (917 bytes in,
   * 1543 out, irreversibly mojibaked).
   *
   * A file whose codepage `TextEncoder` cannot emit must **throw**
   * `SGF_UNSUPPORTED_ENCODING` rather than write different bytes. Throwing is a
   * pass here; writing wrong bytes is the failure. Silent corruption of a
   * user's game record is the worst outcome available, worse than refusing it.
   */
  it('is byte-exact from bytes to bytes, or refuses to write', () => {
    const mismatches: string[] = []
    let compared = 0
    let refused = 0

    for (const name of realFiles) {
      const bytes = read(name)
      let out: Uint8Array
      try {
        out = serialiseToBytes(parseSgf(bytes))
      } catch (error) {
        // Only the documented refusal is acceptable. Any other error, typed or
        // not, is a real failure and must not be swallowed by this catch.
        if (isAppError(error) && error.code === 'SGF_UNSUPPORTED_ENCODING') {
          refused += 1
          continue
        }
        throw error
      }

      compared += 1
      const same =
        out.length === bytes.length && out.every((byte, i) => byte === bytes[i])
      if (!same) {
        mismatches.push(
          `${name} (${String(bytes.length)} bytes in, ${String(out.length)} out)`,
        )
      }
    }

    // Guards the premise from both sides. Without the first, a build where
    // every file refused would pass vacuously — "we wrote nothing wrong"
    // because we wrote nothing. The corpus is mostly UTF-8, so most files must
    // genuinely make it through the byte comparison.
    expect(compared).toBeGreaterThan(50)
    expect(compared + refused).toBe(realFiles.length)
    expect(
      mismatches,
      `files silently rewritten with different bytes: ${mismatches.join(', ')}`,
    ).toEqual([])
  })
})

describe('unknown property preservation', () => {
  /**
   * The substance of A5. Editor-specific properties are common in the wild —
   * GK/LC/LT/RD from Nihon Ki-in records, SY from Cgoban, OS/RR from
   * Pandanet. Dropping them means a user's file degrades on every save.
   */
  const KNOWN = new Set([
    'B',
    'W',
    'AB',
    'AW',
    'AE',
    'SZ',
    'KM',
    'HA',
    'PB',
    'PW',
    'BR',
    'WR',
    'DT',
    'RE',
    'RU',
    'GM',
    'FF',
    'CA',
    'AP',
    'C',
    'N',
    'PL',
    'GN',
    'EV',
    'PC',
    'TM',
    'OT',
    'SO',
    'US',
    'AN',
    'CP',
    'ST',
    'BT',
    'WT',
    'ON',
    'GC',
  ])

  it('finds unknown properties somewhere in the corpus', () => {
    // If this fails, the corpus does not exercise the guarantee at all.
    const unknown = new Set<string>()
    for (const name of realFiles) {
      try {
        const parsed = parseSgf(read(name))
        for (const root of parsed.roots) {
          for (const node of walk(root)) {
            for (const prop of node.properties) {
              if (!KNOWN.has(prop.ident)) unknown.add(prop.ident)
            }
          }
        }
      } catch {
        // Parse failures are reported by the round-trip block.
      }
    }
    expect(unknown.size).toBeGreaterThan(0)
  })

  it('preserves every unknown property through a round-trip', () => {
    for (const name of realFiles) {
      let parsed
      try {
        parsed = parseSgf(read(name))
      } catch {
        continue
      }

      const before: string[] = []
      for (const root of parsed.roots) {
        for (const node of walk(root)) {
          for (const prop of node.properties) {
            if (!KNOWN.has(prop.ident))
              before.push(`${prop.rawIdent}=${prop.values.join('|')}`)
          }
        }
      }

      const after: string[] = []
      const reparsed = parseSgf(serialiseSgf(parsed), { encoding: 'utf-8' })
      for (const root of reparsed.roots) {
        for (const node of walk(root)) {
          for (const prop of node.properties) {
            if (!KNOWN.has(prop.ident))
              after.push(`${prop.rawIdent}=${prop.values.join('|')}`)
          }
        }
      }

      expect(after, `unknown properties changed in ${name}`).toEqual(before)
    }
  })

  it('keeps escape sequences raw rather than decoding them', () => {
    // Decoding on read and re-encoding on write is where fidelity dies: the
    // two only cancel out if they agree on every edge case, and real files
    // disagree. So `\]` stays `\]` in the AST.
    const parsed = parseSgf('(;C[bracket \\] and backslash \\\\ done])')
    const value = getProperty(parsed.roots[0]!, 'C')?.values[0]
    expect(value).toBe('bracket \\] and backslash \\\\ done')
    expect(serialiseSgf(parsed)).toBe('(;C[bracket \\] and backslash \\\\ done])')
  })

  it('preserves long-form identifiers exactly', () => {
    // Some real files write `SiZe[9]`; the spec ignores lowercase letters, so
    // it means SZ. Normalising it on write would be a gratuitous diff.
    const parsed = parseSgf('(;SiZe[9]PlayerBlack[someone])')
    const root = parsed.roots[0]!
    expect(getProperty(root, 'SZ')?.rawIdent).toBe('SiZe')
    expect(getProperty(root, 'PB')?.rawIdent).toBe('PlayerBlack')
    expect(serialiseSgf(parsed)).toBe('(;SiZe[9]PlayerBlack[someone])')
  })
})

describe('malformed input', () => {
  /**
   * A6: each failure mode gets a distinct code, and nothing hangs. The
   * timeouts are the point — a parser that loops on truncated input freezes
   * the import flow with no recovery path, and that failure looks like a
   * pass if you only assert on error type.
   */

  function expectCode(fn: () => unknown, code: ErrorCode): void {
    try {
      fn()
      throw new Error(`expected ${code} but no error was thrown`)
    } catch (error) {
      expect(error, 'should be an AppError').toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe(code)
    }
  }

  it('rejects an empty file as SGF_EMPTY', { timeout: 2000 }, () => {
    expectCode(() => parseSgf(read('_malformed-empty.sgf')), 'SGF_EMPTY')
    expectCode(() => parseSgf(new Uint8Array(0)), 'SGF_EMPTY')
  })

  it('rejects whitespace-only input as SGF_EMPTY', { timeout: 2000 }, () => {
    expectCode(() => parseSgf('   \n\t  '), 'SGF_EMPTY')
  })

  it('rejects non-SGF content as SGF_NOT_SGF', { timeout: 2000 }, () => {
    expectCode(() => parseSgf(read('_malformed-not-sgf.sgf')), 'SGF_NOT_SGF')
    expectCode(() => parseSgf('this is plain text'), 'SGF_NOT_SGF')
  })

  it('rejects a truncated file as SGF_TRUNCATED', { timeout: 2000 }, () => {
    expectCode(() => parseSgf(read('_malformed-truncated.sgf')), 'SGF_TRUNCATED')
  })

  it('rejects an unterminated property value', { timeout: 2000 }, () => {
    expectCode(() => parseSgf('(;C[never closed'), 'SGF_TRUNCATED')
  })

  it('rejects an unterminated game tree', { timeout: 2000 }, () => {
    expectCode(() => parseSgf('(;B[aa]'), 'SGF_TRUNCATED')
  })

  it('rejects a property with no value', { timeout: 2000 }, () => {
    expectCode(() => parseSgf('(;B)'), 'SGF_INVALID_PROPERTY')
  })

  it('terminates on adversarial input rather than hanging', { timeout: 5000 }, () => {
    // Each of these has previously hung a naive implementation. The assertion
    // is termination; whether it parses or throws is secondary.
    const inputs = [
      '(',
      '()',
      '(;',
      '(((((((((((',
      '(;C[' + '\\'.repeat(1000),
      '(;' + 'B[aa]'.repeat(5000),
      '(' + '(;B[aa])'.repeat(2000) + ')',
      '(;C[' + ']'.repeat(1000),
    ]

    for (const input of inputs) {
      try {
        parseSgf(input)
      } catch (error) {
        expect(error, `${input.slice(0, 20)} should throw AppError`).toBeInstanceOf(
          AppError,
        )
      }
    }
  })

  it('rejects a variation before any node', { timeout: 2000 }, () => {
    expectCode(() => parseSgf('((;B[aa]))'), 'SGF_NOT_SGF')
  })

  /**
   * Recursion depth is its own failure mode, and the one a test asserting only
   * on error *type* misses: an unguarded recursive-descent parser throws a bare
   * `RangeError`, which carries no `code`. The caller cannot branch on it, the
   * UI cannot translate it, and it is indistinguishable from a real crash — so
   * "it throws" is not sufficient here, the *code* is the assertion.
   */
  it('rejects nesting too deep to parse with a typed code', { timeout: 5000 }, () => {
    for (const depth of [513, 3000, 20000]) {
      const source = '(;B[aa]'.repeat(depth) + ')'.repeat(depth)
      expectCode(() => parseSgf(source), 'SGF_TOO_DEEP')
      // Specifically not a stack overflow: that is the bug this guards.
      let thrown: unknown
      try {
        parseSgf(source)
      } catch (error) {
        thrown = error
      }
      expect(
        thrown,
        `depth ${String(depth)} must not be a RangeError`,
      ).not.toBeInstanceOf(RangeError)
    }
  })

  it('still accepts nesting deeper than any real file', { timeout: 5000 }, () => {
    // The guard must not be so tight that it rejects genuine records. The
    // deepest file in the corpus nests 113; this asserts real headroom above it,
    // and that anything accepted can also be written back — a parser that
    // accepted a tree the serialiser cannot emit would lose data on save.
    const source = '(;B[aa]'.repeat(400) + ')'.repeat(400)
    const parsed = parseSgf(source)
    expect(serialiseSgf(parsed)).toBe(source)
  })

  it(
    'traverses a very long linear game without overflowing',
    { timeout: 10000 },
    () => {
      // `walk` recurses once per mainline node if written the obvious way, so a
      // long record overflows the stack at the *consumer's* `for...of` with an
      // untyped RangeError. Real records are long; 20000 is well past any of them.
      const moves = 20_000
      const parsed = parseSgf('(' + ';B[aa]'.repeat(moves) + ')')
      const root = parsed.roots[0]
      expect(root).toBeDefined()
      if (!root) return
      expect(nodeCount(root)).toBe(moves)
      expect([...walk(root)]).toHaveLength(moves)
    },
  )
})

describe('structural parsing', () => {
  it('reads a linear game', () => {
    const parsed = parseSgf('(;GM[1]FF[4]SZ[19];B[pd];W[dp];B[pq])')
    expect(parsed.roots).toHaveLength(1)
    expect(nodeCount(parsed.roots[0]!)).toBe(4)
  })

  it('reads variations as separate children', () => {
    const parsed = parseSgf('(;SZ[19];B[aa](;W[bb])(;W[cc]))')
    const root = parsed.roots[0]!
    const first = root.children[0]!
    expect(first.children).toHaveLength(2)
  })

  it('handles a root node with no leading semicolon', () => {
    // Real Nihon Ki-in records do this.
    const parsed = parseSgf('(TE[title]RD[2025-01-01];B[aa])')
    expect(parsed.roots).toHaveLength(1)
  })

  it('reads multiple games from one file', () => {
    const parsed = parseSgf('(;SZ[19];B[aa])(;SZ[9];B[bb])')
    expect(parsed.roots).toHaveLength(2)
  })

  it('records the detected encoding', () => {
    const parsed = parseSgf('(;CA[UTF-8]SZ[19])')
    expect(parsed.encoding).toBe('utf-8')
  })

  it('assigns every node a distinct id', () => {
    const parsed = parseSgf('(;SZ[19];B[aa](;W[bb])(;W[cc]))')
    const ids = [...walk(parsed.roots[0]!)].map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('links parents so a path back to the root exists', () => {
    const parsed = parseSgf('(;SZ[19];B[aa];W[bb])')
    const nodes = [...walk(parsed.roots[0]!)]
    const last = nodes[nodes.length - 1]!
    expect(last.parent).not.toBeNull()
    expect(last.parent?.parent).toBe(parsed.roots[0])
  })

  it('walks depth-first pre-order, matching a recursive reference', () => {
    // `walk` is iterative to survive long games, so the order it produces is no
    // longer guaranteed by its shape. Pinned against the recursive definition
    // over a branching tree, because the move-tree UI and the round-trip
    // comparisons both index nodes positionally — a silent reordering would
    // make them compare the wrong pairs while still passing a length check.
    function* reference(node: SgfNode): Generator<SgfNode> {
      yield node
      for (const child of node.children) yield* reference(child)
    }

    const parsed = parseSgf(
      '(;SZ[19];B[aa](;W[bb](;B[cc])(;B[dd]))(;W[ee];B[ff])(;W[gg]))',
    )
    const root = parsed.roots[0]!

    const actual = [...walk(root)].map((n) => n.id)
    const expected = [...reference(root)].map((n) => n.id)

    expect(actual).toEqual(expected)
    // Guards the premise: a linear tree would satisfy the above trivially.
    expect(actual.length).toBeGreaterThan(5)
    expect([...walk(root)].some((n) => n.children.length > 1)).toBe(true)
  })
})

describe('byte serialisation', () => {
  it('round-trips a UTF-8 file through bytes, BOM included', () => {
    const source = '(;GM[1]FF[4]CA[UTF-8]SZ[19];B[pd]C[コメント])'
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(source),
    ])
    const parsed = parseSgf(bytes)
    expect(parsed.bom).toBe('utf-8')
    expect([...serialiseToBytes(parsed)]).toEqual([...bytes])
  })

  it('omits the BOM on request without disturbing the body', () => {
    const source = '(;SZ[19];B[aa])'
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(source),
    ])
    const parsed = parseSgf(bytes)
    expect([...serialiseToBytes(parsed, { includeBom: false })]).toEqual([
      ...new TextEncoder().encode(source),
    ])
  })

  it('refuses a codepage TextEncoder cannot emit, with a typed code', () => {
    // TextEncoder only produces UTF-8, so a Shift-JIS file cannot be written
    // back byte-exactly. Refusing is the correct behaviour -- silently writing
    // UTF-8 bytes under a CA[Shift_JIS] header would corrupt the file for every
    // other reader. Asserting on the code because a bare toThrow() would also
    // pass for an untyped Error, and the renderer needs to translate this one.
    //
    // Parsed from *bytes*, not a string: a string source is already-decoded
    // text, so parseSgf fixes its encoding to utf-8 and CA is not consulted.
    // Passing a string here would make the test assert nothing.
    const source = '(;GM[1]FF[4]CA[Shift_JIS]SZ[19];B[pd])'
    const parsed = parseSgf(Uint8Array.from(source, (c) => c.charCodeAt(0)))
    expect(parsed.encoding).toBe('shift_jis')

    let caught: unknown
    try {
      serialiseToBytes(parsed)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code satisfies ErrorCode).toBe(
      'SGF_UNSUPPORTED_ENCODING',
    )
    // The text path stays available -- refusal is about bytes, not about
    // making the document unreachable.
    expect(serialiseSgf(parsed)).toContain('CA[Shift_JIS]')
  })
})

describe('undeterminable encoding', () => {
  /**
   * A file whose bytes are not valid UTF-8 and which declares no `CA`. This is
   * the shape of the six real corpus files that were silently rewritten before
   * the sentinel existed. `0x82 0xa0` is Shift-JIS ぁ, and also a legal GBK and
   * Big5 sequence — which is the whole reason the encoding cannot be guessed.
   */
  const undeterminable = () =>
    new Uint8Array([
      ...Uint8Array.from('(;GM[1]FF[4]SZ[19]C[', (c) => c.charCodeAt(0)),
      0x82,
      0xa0,
      ...Uint8Array.from(']', (c) => c.charCodeAt(0)),
      ...Uint8Array.from(';B[pd])', (c) => c.charCodeAt(0)),
    ])

  it('reports an unrecognised CA label as unknown, not as itself', () => {
    // The failure this prevents is downstream, not here: a label no decoder
    // accepts sitting in `collection.encoding` makes `new TextDecoder(encoding)`
    // throw a bare RangeError in every consumer that trusts the field.
    //
    // The invariant is not "always a decoder label" -- the sentinel is not one,
    // deliberately, so that a caller cannot pass it to `TextDecoder` by
    // accident and get plausible-looking mojibake. It is: *either* a valid
    // label *or* exactly this one sentinel, which is the single value callers
    // have to branch on.
    const source = '(;GM[1]FF[4]CA[X-MADE-UP]SZ[19];B[pd])'
    const parsed = parseSgf(Uint8Array.from(source, (c) => c.charCodeAt(0)))

    expect(parsed.encoding).toBe(UNKNOWN_ENCODING)
  })

  it('passes through a valid label the alias table does not list', () => {
    // The counterweight: normalisation must not collapse to `unknown` whenever
    // it does not recognise a name. windows-1252 is absent from the alias table
    // and perfectly decodable, so it has to survive -- otherwise the test above
    // would also pass for an implementation that rejected every unlisted label.
    const source = '(;GM[1]FF[4]CA[windows-1252]SZ[19];B[pd])'
    const parsed = parseSgf(Uint8Array.from(source, (c) => c.charCodeAt(0)))

    expect(parsed.encoding).toBe('windows-1252')
    // The contract the two tests together establish: the field is *either* the
    // sentinel *or* a label `TextDecoder` accepts. Never a third thing.
    expect(() => new TextDecoder(parsed.encoding)).not.toThrow()
  })

  it('refuses to write bytes for a file it could not decode', () => {
    // The guard that turns unavoidable mojibake into a refusal instead of
    // corruption. Without it the mojibake is re-encoded as UTF-8 and written
    // over the original -- the 917-to-1543-byte rewrite that A5 exists to catch.
    const parsed = parseSgf(undeterminable())
    expect(parsed.encoding).toBe(UNKNOWN_ENCODING)

    let caught: unknown
    try {
      serialiseToBytes(parsed)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code satisfies ErrorCode).toBe(
      'SGF_UNSUPPORTED_ENCODING',
    )
    // Asserting the message, not just the code, and the reason is specific: the
    // "not UTF-8" guard further down throws the *same* code, so a build with
    // this guard deleted still refuses and a code-only assertion still passes.
    // It refuses for the wrong reason and tells the user to do the wrong thing
    // -- "convert the file on import" cannot work when the source encoding is
    // what is unknown. The remedy is the part worth pinning.
    expect((caught as AppError).message).toContain('could not be determined')
  })

  it('still parses the tree, because the fallback reading keeps ASCII fixed', () => {
    // Refusing to *write* must not mean refusing to *read*: the user should
    // still see the game. This holds only because the sentinel's decoding is
    // identity on ASCII, so the structural bytes stay where they are.
    const parsed = parseSgf(undeterminable())

    expect(parsed.roots).toHaveLength(1)
    const root = parsed.roots[0]
    expect(root).toBeDefined()
    if (root === undefined) return
    const move = root.children[0]
    expect(move).toBeDefined()
    if (move === undefined) return
    expect(getProperty(root, 'SZ')?.values).toEqual(['19'])
    expect(getProperty(move, 'B')?.values).toEqual(['pd'])
  })

  it('loses no byte in the fallback reading, so the mojibake is reversible', () => {
    // The property the sentinel's decoder is chosen for, asserted through
    // `parseSgf` over the whole byte range -- not against `TextDecoder`
    // directly, which would test the platform instead of this parser.
    //
    // Note the property is *not* byte-preservation. WHATWG aliases iso-8859-1
    // to windows-1252, so 0x82 reads as U+201A. What has to hold is weaker and
    // sufficient: identity on ASCII, so the structure is untouched, and
    // injective everywhere, so no byte is lost to U+FFFD or merged with
    // another. Together those make the mojibake recoverable in principle
    // rather than destructive. A UTF-8 fallback satisfies neither -- every
    // stray high byte becomes U+FFFD, and all of them become the *same*
    // U+FFFD.
    const body = Uint8Array.from({ length: 256 - 0x20 }, (_, i) => i + 0x20)
    const bytes = new Uint8Array([
      ...Uint8Array.from('(;SZ[19]C[', (c) => c.charCodeAt(0)),
      // `]` and `\` would close or escape the value; keep the sweep to bytes
      // that are legal inside one, which still covers all of 0x80-0xff.
      ...[...body].filter((b) => b !== 0x5d && b !== 0x5c),
      ...Uint8Array.from('])', (c) => c.charCodeAt(0)),
    ])

    const parsed = parseSgf(bytes, { encoding: UNKNOWN_ENCODING })
    const root = parsed.roots[0]
    expect(root).toBeDefined()
    if (root === undefined) return
    const raw = getProperty(root, 'C')?.values[0]
    expect(raw).toBeDefined()
    if (raw === undefined) return

    const expected = [...body].filter((b) => b !== 0x5d && b !== 0x5c)
    // Indexed by UTF-16 code unit rather than spread into code points, and here
    // the two coincide: every character this decoder can produce is in the BMP
    // and none is a surrogate, so `length` is the character count. That is also
    // the first thing asserted -- if a byte had decoded to something outside the
    // BMP, the length check would fail rather than the comparison silently
    // sliding out of alignment.
    const codes = Array.from({ length: raw.length }, (_, i) => raw.charCodeAt(i))
    expect(codes).toHaveLength(expected.length)
    // No byte was dropped, and no two bytes became the same character.
    expect(codes).not.toContain(0xfffd)
    expect(new Set(codes).size).toBe(expected.length)
    // ASCII in particular is untouched, which is why the tree still parses.
    expected.forEach((byte, i) => {
      if (byte < 0x80) expect(codes[i]).toBe(byte)
    })
  })
})
