import { describe, expect, it } from 'vitest'
import { AppError, isAppError } from '@gomentor/shared'
import { parseSgf } from '../../src/sgf/parser'
import { serialiseSgf } from '../../src/sgf/serializer'
import { getProperty, walk, type SgfNode } from '../../src/sgf/ast'
import { readFixture, realFiles } from './corpus'
import {
  decodePointList,
  decodeSimpleText,
  decodeText,
  getBoardSize,
  getComment,
  getDate,
  getEvent,
  getHandicap,
  getKomi,
  getMove,
  getNodeName,
  getPlace,
  getPlayerName,
  getPlayerRank,
  getPlayerToMove,
  getResult,
  getRuleset,
  getSetup,
} from '../../src/sgf/props'

/**
 * Typed accessors. The through-line of every test here is the A5 boundary:
 * decoding is a *read*, so it must never change what serialisation produces,
 * and it must not throw on the metadata sludge real files carry.
 */

function rootOf(source: string): SgfNode {
  const root = parseSgf(source).roots[0]
  expect(root).toBeDefined()
  if (!root) throw new Error('unreachable')
  return root
}

function childOf(node: SgfNode): SgfNode {
  const child = node.children[0]
  expect(child).toBeDefined()
  if (!child) throw new Error('unreachable')
  return child
}

/**
 * The `code` of the error a thunk throws, or undefined if it threw an untyped
 * error or did not throw at all. Returning the code rather than asserting
 * `toThrow()` keeps the distinction that matters here: an untyped CoordError
 * and a typed AppError both satisfy "it throws".
 */
function codeOfThrow(thunk: () => unknown): string | undefined {
  try {
    thunk()
  } catch (error) {
    return isAppError(error) ? error.code : undefined
  }
  return undefined
}

describe('text decoding', () => {
  it('unescapes a closing bracket and a backslash', () => {
    expect(decodeText('bracket \\] and backslash \\\\ done')).toBe(
      'bracket ] and backslash \\ done',
    )
  })

  it('removes a soft line break entirely', () => {
    // The rule implementations get wrong: backslash-newline joins the lines
    // rather than producing a newline or a space.
    expect(decodeText('one\\\ntwo')).toBe('onetwo')
  })

  it('keeps a hard line break in Text', () => {
    expect(decodeText('one\ntwo')).toBe('one\ntwo')
  })

  it('converts a hard line break to a space in SimpleText', () => {
    expect(decodeSimpleText('one\ntwo')).toBe('one two')
  })

  it('treats CRLF and LFCR as a single break', () => {
    expect(decodeText('one\r\ntwo')).toBe('one\ntwo')
    expect(decodeText('one\n\rtwo')).toBe('one\ntwo')
    // Two separate breaks stay two.
    expect(decodeText('one\n\ntwo')).toBe('one\n\ntwo')
  })

  it('removes a soft line break spelled CRLF', () => {
    expect(decodeText('one\\\r\ntwo')).toBe('onetwo')
  })

  it('converts tabs to spaces without collapsing them', () => {
    expect(decodeText('a\tb')).toBe('a b')
    expect(decodeSimpleText('a\t\tb')).toBe('a  b')
  })

  /**
   * FF[4] §3.2 and §3.3, verbatim: *"Any char following `\` is inserted
   * verbatim (exception: whitespaces still have to be converted to space!)"*.
   *
   * The parenthesised exception is the whole test. An implementation that reads
   * only the word "verbatim" — as this one did — passes every unescaped-tab
   * test above while getting the escaped case wrong, because the two go through
   * different branches. Quoted from the spec rather than paraphrased, since the
   * previous version of this rule was pinned by assertions that agreed with the
   * implementation instead of with red-bean.com.
   */
  it('converts escaped whitespace to a space, per the §3.2 exception', () => {
    expect(decodeText('a\\\tb')).toBe('a b')
    expect(decodeSimpleText('a\\\tb')).toBe('a b')
    // Vertical tab and form feed are whitespace too — the spec says
    // "whitespaces", not "tabs".
    expect(decodeText('a\\\u000bb')).toBe('a b')
    expect(decodeText('a\\\fb')).toBe('a b')
    // An escaped *space* is already a space; it must stay one, not vanish.
    expect(decodeText('a\\ b')).toBe('a b')
  })

  /**
   * The canonical example from FF[4] §3.2.1, with the spec's own stated
   * rendering as the expectation.
   *
   * This is the strongest check available for the text rules, because the
   * expected output is not my interpretation — the spec prints it. It exercises
   * two soft line breaks, an escaped `)`, an escaped `]`, and hard line breaks,
   * all in one value.
   */
  it('decodes the specification §3.2.1 example to its documented rendering', () => {
    const raw =
      'Meijin NR: yeah, k4 is won\\\nderful\n' +
      'sweat NR: thank you! :\\)\n' +
      "dada NR: yup. I like this move too. It's a move only to be expected from a pro. I really like it :)\n" +
      'jansteen 4d: Can anyone\\\n explain [me\\] k4?'

    expect(decodeText(raw)).toBe(
      'Meijin NR: yeah, k4 is wonderful\n' +
        'sweat NR: thank you! :)\n' +
        "dada NR: yup. I like this move too. It's a move only to be expected from a pro. I really like it :)\n" +
        'jansteen 4d: Can anyone explain [me] k4?',
    )
  })

  it('preserves an escaped character that needs no escaping', () => {
    // `\a` is just `a`. Notably `\n` inside the *raw* value is backslash-n,
    // not a newline, so it must not become one.
    expect(decodeText('\\a\\b')).toBe('ab')
  })

  it('drops a trailing lone backslash rather than throwing', () => {
    expect(decodeText('unterminated \\')).toBe('unterminated ')
  })

  it('leaves an escaped colon intact', () => {
    // Colons are only special in composed values, but `\:` appears in the wild.
    expect(decodeSimpleText('a\\:b')).toBe('a:b')
  })
})

describe('point lists', () => {
  it('reads single points', () => {
    expect(decodePointList(['aa', 'bb'], 19)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ])
  })

  it('expands a compressed rectangle', () => {
    // FF[4] `[aa:bb]` is a 2x2 block. A reader that treats it as one point
    // silently loses most of a problem diagram.
    expect(decodePointList(['aa:bb'], 19)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ])
  })

  it('accepts a rectangle whose corners are given in reverse order', () => {
    expect(decodePointList(['bb:aa'], 19)).toEqual(decodePointList(['aa:bb'], 19))
  })

  it('expands a single-row rectangle', () => {
    expect(decodePointList(['aa:ca'], 19)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
  })

  it('deduplicates points that appear in more than one entry', () => {
    expect(decodePointList(['aa', 'aa:ba'], 19)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ])
  })

  it('rejects a rectangle that leaves the board', () => {
    // Asserting on the code, not just "it throws". `fromSgf` raises an untyped
    // CoordError, so a bare toThrow() passes whether or not the failure is
    // translated into the SGF domain -- which is the whole point of the check.
    expect(codeOfThrow(() => decodePointList(['aa:zz'], 9))).toBe(
      'SGF_INVALID_PROPERTY',
    )
  })

  it('rejects a single off-board point with the same code as an off-board move', () => {
    // `AB[rs]` on 9x9 is the setup-stone twin of `B[rs]`; both are the same
    // malformed-file condition and must be indistinguishable to a caller
    // branching on the code.
    const moveNode = childOf(rootOf('(;SZ[9];B[rs])'))
    expect(codeOfThrow(() => decodePointList(['rs'], 9))).toBe('SGF_INVALID_PROPERTY')
    expect(codeOfThrow(() => getMove(moveNode, 9))).toBe('SGF_INVALID_PROPERTY')
  })

  it('skips an empty value rather than yielding a pass coordinate', () => {
    // `AE[]` is meaningless but occurs; it must not become a stone at (0,0).
    expect(decodePointList([''], 19)).toEqual([])
  })
})

describe('board size', () => {
  it('defaults to 19 when SZ is absent', () => {
    expect(getBoardSize(rootOf('(;GM[1])'))).toBe(19)
  })

  it('reads 9 and 13', () => {
    expect(getBoardSize(rootOf('(;SZ[9])'))).toBe(9)
    expect(getBoardSize(rootOf('(;SZ[13])'))).toBe(13)
  })

  it('reads a long-form identifier', () => {
    expect(getBoardSize(rootOf('(;SiZe[9])'))).toBe(9)
  })

  it('accepts a square value written in composed form', () => {
    expect(getBoardSize(rootOf('(;SZ[9:9])'))).toBe(9)
  })

  it('rejects an unsupported size with a typed error', () => {
    // 7x7 is in the corpus (katago-sampletest7x7.sgf) and is genuinely
    // unsupported — better a clear error than a board rendered at the wrong
    // size.
    for (const source of ['(;SZ[7])', '(;SZ[21])', '(;SZ[0])']) {
      let thrown: unknown
      try {
        getBoardSize(rootOf(source))
      } catch (error) {
        thrown = error
      }
      expect(thrown, `${source} should be rejected`).toBeInstanceOf(AppError)
      expect((thrown as AppError).code).toBe('SGF_UNSUPPORTED_BOARD_SIZE')
    }
  })

  it('rejects a rectangular board', () => {
    let thrown: unknown
    try {
      getBoardSize(rootOf('(;SZ[19:9])'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('SGF_UNSUPPORTED_BOARD_SIZE')
  })

  it('rejects non-numeric text rather than defaulting to 19', () => {
    // Defaulting here would decode every coordinate in the file against a size
    // the file never stated.
    expect(() => getBoardSize(rootOf('(;SZ[big])'))).toThrow(AppError)
  })
})

describe('numeric metadata', () => {
  it('reads komi in the several forms real files use', () => {
    expect(getKomi(rootOf('(;KM[6.5])'))).toBe(6.5)
    expect(getKomi(rootOf('(;KM[0.500000])'))).toBe(0.5)
    expect(getKomi(rootOf('(;KM[7])'))).toBe(7)
    expect(getKomi(rootOf('(;KM[-59.5])'))).toBe(-59.5)
  })

  it('reads an absent or unreadable komi as undefined', () => {
    expect(getKomi(rootOf('(;GM[1])'))).toBeUndefined()
    expect(getKomi(rootOf('(;KM[])'))).toBeUndefined()
    expect(getKomi(rootOf('(;KM[unknown])'))).toBeUndefined()
  })

  it('does not read an empty komi as zero', () => {
    // Number('') is 0, so this is the specific trap.
    expect(getKomi(rootOf('(;KM[ ])'))).not.toBe(0)
  })

  it('reads handicap and rejects out-of-range values', () => {
    expect(getHandicap(rootOf('(;HA[6])'))).toBe(6)
    expect(getHandicap(rootOf('(;HA[0])'))).toBe(0)
    expect(getHandicap(rootOf('(;HA[27])'))).toBeUndefined()
    expect(getHandicap(rootOf('(;HA[2.5])'))).toBeUndefined()
  })
})

describe('result', () => {
  it('reads a points win', () => {
    expect(getResult(rootOf('(;RE[B+13.5])'))).toEqual({
      winner: 'black',
      score: 13.5,
      by: 'points',
    })
    expect(getResult(rootOf('(;RE[W+2.0])'))).toEqual({
      winner: 'white',
      score: 2,
      by: 'points',
    })
  })

  it('reads resignation, timeout, and forfeit', () => {
    expect(getResult(rootOf('(;RE[B+R])'))).toEqual({
      winner: 'black',
      by: 'resignation',
    })
    expect(getResult(rootOf('(;RE[W+Resign])'))).toEqual({
      winner: 'white',
      by: 'resignation',
    })
    expect(getResult(rootOf('(;RE[B+T])'))).toEqual({ winner: 'black', by: 'timeout' })
    expect(getResult(rootOf('(;RE[W+F])'))).toEqual({ winner: 'white', by: 'forfeit' })
  })

  it('reads a draw and an explicitly unknown result', () => {
    expect(getResult(rootOf('(;RE[0])'))).toEqual({ winner: 'draw', by: 'points' })
    expect(getResult(rootOf('(;RE[Draw])'))).toEqual({ winner: 'draw', by: 'points' })
    expect(getResult(rootOf('(;RE[?])'))).toEqual({ winner: 'unknown', by: 'unknown' })
    expect(getResult(rootOf('(;RE[Void])'))).toEqual({
      winner: 'unknown',
      by: 'unknown',
    })
  })

  it('distinguishes an unreadable result from an unknown one', () => {
    // `RE[?]` means the file says the outcome is unknown; mojibake means the
    // field cannot be read. A caller may want to show those differently, so
    // they must not collapse to the same value.
    expect(getResult(rootOf('(;RE[garbled nonsense])'))).toBeUndefined()
    expect(getResult(rootOf('(;RE[?])'))).not.toBeUndefined()
  })

  it('keeps the winner when only the margin is unreadable', () => {
    expect(getResult(rootOf('(;RE[W+lots])'))).toEqual({
      winner: 'white',
      by: 'unknown',
    })
  })

  it('is case-insensitive on the winner letter', () => {
    expect(getResult(rootOf('(;RE[b+3.5])'))).toEqual({
      winner: 'black',
      score: 3.5,
      by: 'points',
    })
  })
})

describe('text metadata', () => {
  it('reads player names and ranks', () => {
    const root = rootOf('(;PB[Black Player]PW[White Player]BR[5d]WR[3k])')
    expect(getPlayerName(root, 'black')).toBe('Black Player')
    expect(getPlayerName(root, 'white')).toBe('White Player')
    expect(getPlayerRank(root, 'black')).toBe('5d')
    expect(getPlayerRank(root, 'white')).toBe('3k')
  })

  it('reads a long-form identifier', () => {
    expect(getPlayerName(rootOf('(;PlayerBlack[someone])'), 'black')).toBe('someone')
  })

  it('reads an empty value as absent', () => {
    expect(getPlayerName(rootOf('(;PB[])'), 'black')).toBeUndefined()
    expect(getPlayerName(rootOf('(;PB[   ])'), 'black')).toBeUndefined()
  })

  it('reads place and event', () => {
    const root = rootOf('(;EV[Some Cup]PC[Tokyo])')
    expect(getEvent(root)).toBe('Some Cup')
    expect(getPlace(root)).toBe('Tokyo')
  })

  it('accepts a partial date and rejects free text', () => {
    expect(getDate(rootOf('(;DT[2005-04-10])'))).toBe('2005-04-10')
    expect(getDate(rootOf('(;DT[2005-04])'))).toBe('2005-04')
    expect(getDate(rootOf('(;DT[2005])'))).toBe('2005')
    expect(getDate(rootOf('(;DT[last tuesday])'))).toBeUndefined()
  })
})

describe('moves', () => {
  it('reads a black and a white move', () => {
    const root = rootOf('(;SZ[19];B[pd];W[dp])')
    const nodes = [...walk(root)]
    expect(getMove(nodes[1]!, 19)).toEqual({ player: 'black', coord: { x: 15, y: 3 } })
    expect(getMove(nodes[2]!, 19)).toEqual({ player: 'white', coord: { x: 3, y: 15 } })
  })

  it('reads no move on a node that has none', () => {
    expect(getMove(rootOf('(;SZ[19]C[just a comment])'), 19)).toBeNull()
  })

  it('reads an empty value as a pass', () => {
    const node = [...walk(rootOf('(;SZ[19];B[])'))][1]!
    expect(getMove(node, 19)).toEqual({ player: 'black', coord: null })
  })

  it('reads legacy tt as a pass', () => {
    const node = [...walk(rootOf('(;SZ[19];W[tt])'))][1]!
    expect(getMove(node, 19)).toEqual({ player: 'white', coord: null })
  })

  it('throws on an off-board move rather than dropping it', () => {
    // gogui-invalidmove.sgf: `B[rs]` on a 9x9 board. Dropping the move would
    // replay every later move onto the wrong position; treating it as a pass
    // would flip whose turn it is. Both look valid on screen.
    const node = [...walk(rootOf('(;SZ[9];B[rs])'))][1]!
    let thrown: unknown
    try {
      getMove(node, 9)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('SGF_INVALID_PROPERTY')
  })

  it('does not leak a cause chain into the envelope', () => {
    // The envelope crosses to the renderer; `cause` must not come with it.
    const node = [...walk(rootOf('(;SZ[9];B[rs])'))][1]!
    try {
      getMove(node, 9)
      expect.unreachable('should have thrown')
    } catch (error) {
      const envelope = (error as AppError).toEnvelope()
      expect(envelope).not.toHaveProperty('cause')
      expect(envelope).not.toHaveProperty('stack')
    }
  })

  it('prefers black when a node illegally carries both B and W', () => {
    const node = [...walk(rootOf('(;SZ[19];B[aa]W[bb])'))][1]!
    expect(getMove(node, 19)?.player).toBe('black')
  })
})

describe('setup and node contents', () => {
  it('reads setup stones and erasures', () => {
    const root = rootOf('(;SZ[19]AB[aa][bb]AW[cc]AE[dd])')
    expect(getSetup(root, 19)).toEqual({
      black: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      white: [{ x: 2, y: 2 }],
      erase: [{ x: 3, y: 3 }],
    })
  })

  it('reads empty setup lists as empty arrays', () => {
    expect(getSetup(rootOf('(;SZ[19])'), 19)).toEqual({
      black: [],
      white: [],
      erase: [],
    })
  })

  it('reads the player to move', () => {
    expect(getPlayerToMove(rootOf('(;PL[B])'))).toBe('black')
    expect(getPlayerToMove(rootOf('(;PL[W])'))).toBe('white')
    expect(getPlayerToMove(rootOf('(;PL[1])'))).toBe('black')
    expect(getPlayerToMove(rootOf('(;GM[1])'))).toBeUndefined()
  })

  it('reads a comment with escapes resolved', () => {
    expect(getComment(rootOf('(;C[a \\] bracket])'))).toBe('a ] bracket')
  })

  it('reads a node name', () => {
    expect(getNodeName(rootOf('(;N[Variation 1])'))).toBe('Variation 1')
  })
})

describe('decoding does not disturb the AST', () => {
  /**
   * The substance of the A5 boundary. `decodeText` resolving `\]` to `]` is
   * only safe if the AST still holds `\]`, so a read followed by a write
   * reproduces the original bytes.
   */
  it('leaves the raw value untouched after decoding', () => {
    const parsed = parseSgf('(;C[bracket \\] and \\\\ done])')
    const root = parsed.roots[0]!
    const before = getProperty(root, 'C')?.values[0]

    expect(getComment(root)).toBe('bracket ] and \\ done')
    expect(getProperty(root, 'C')?.values[0]).toBe(before)
    expect(serialiseSgf(parsed)).toBe('(;C[bracket \\] and \\\\ done])')
  })

  it('serialises byte-identically after reading every accessor on the corpus', () => {
    // Runs the full accessor surface over every real file, then asserts the
    // round-trip still holds. If any accessor mutated the tree — normalising a
    // value, sorting a property, filling in a default — this fails.
    //
    // The file list comes from the shared corpus module rather than a local
    // filter, so it cannot drift from the round-trip test's idea of which files
    // are real SGF.

    const mismatches: string[] = []
    let read = 0

    for (const name of realFiles) {
      const bytes = readFixture(name)
      const parsed = parseSgf(bytes)

      for (const root of parsed.roots) {
        let size: 9 | 13 | 19
        try {
          size = getBoardSize(root)
        } catch {
          // 7x7 and rectangular boards are rejected by design; the point of
          // this test is mutation, so skip to the next tree.
          continue
        }

        getKomi(root)
        getHandicap(root)
        getResult(root)
        getDate(root)
        getEvent(root)
        getPlace(root)
        getRuleset(root)
        getPlayerName(root, 'black')
        getPlayerName(root, 'white')
        getPlayerRank(root, 'black')
        getPlayerRank(root, 'white')

        for (const node of walk(root)) {
          try {
            getMove(node, size)
          } catch {
            // gogui-invalidmove.sgf has a genuinely off-board move.
          }
          try {
            getSetup(node, size)
          } catch {
            // A setup point outside the declared size, same reasoning.
          }
          getComment(node)
          getNodeName(node)
          getPlayerToMove(node)
          read += 1
        }
      }

      // Compared against a *second parse of the same bytes*, not a decoding
      // this test derives itself. Two reasons: `UNKNOWN_ENCODING` is not a
      // decoder label, so `new TextDecoder(parsed.encoding)` throws on a file
      // whose codepage could not be determined; and this test is about whether
      // *reading* mutated the tree, so the right baseline is the same file
      // parsed and serialised without any accessor being called on it.
      if (serialiseSgf(parsed) !== serialiseSgf(parseSgf(bytes))) {
        mismatches.push(name)
      }
    }

    // Guards the premise: this must actually have read something. The file
    // count is checked as well as the node count, because the list now comes
    // from a shared module — a change there that narrowed it would quietly
    // shrink this test's reach rather than fail it.
    expect(realFiles.length).toBeGreaterThan(50)
    expect(read).toBeGreaterThan(1000)
    expect(mismatches, `mutated by reading: ${mismatches.join(', ')}`).toEqual([])
  })
})

describe('real files decode to sensible values', () => {
  /**
   * Asserted against files rather than constructed strings, because the point
   * is that the accessors survive real formatting — newlines mid-property,
   * legacy codepages, editor quirks.
   */
  it('reads a KGS game record', () => {
    const bytes = readFixture('gnugo-kgs-20050407-tfujii.sgf')
    const root = parseSgf(bytes).roots[0]!
    expect(getBoardSize(root)).toBe(19)
    expect(getPlayerName(root, 'black')).toBeDefined()
    expect(getPlayerName(root, 'white')).toBeDefined()
  })

  it('reads a CJK comment from a legacy-encoded file', () => {
    // Shift-JIS. If the encoding path were wrong this would be mojibake, and
    // the assertion is that it is *not* — a decoded string with no replacement
    // characters.
    const bytes = readFixture('sabaki-sgf-japanese.sgf')
    const parsed = parseSgf(bytes)
    const root = parsed.roots[0]!
    const name = getPlayerName(root, 'black')
    expect(name).toBeDefined()
    expect(name).not.toContain('�')
  })

  it('counts moves across the mainline of a pro game', () => {
    const bytes = readFixture('sabaki-app-pro_game.sgf')
    const parsed = parseSgf(bytes)
    const root = parsed.roots[0]!
    const size = getBoardSize(root)
    const moves = [...walk(root)].filter((node) => getMove(node, size) !== null)
    expect(moves.length).toBeGreaterThan(50)
  })
})

/**
 * What a parse failure is allowed to say about the file.
 *
 * Two independent requirements, and a test that checks only one passes while
 * the other is violated:
 *
 * - **Bounded.** `toEnvelope()` forwards `context` and cannot strip `message`,
 *   and `logging-guidelines.md:54` says error `context` is logged. A property
 *   value has no length limit in a malformed file.
 * - **Content-free.** `logging-guidelines.md:76` puts SGF content out of bounds
 *   for logging. A coordinate is a board position and is safe to name; text
 *   from a file that is not SGF at all is not.
 *
 * The assertions are on the *serialised envelope*, because that is the object
 * that crosses to the renderer and reaches a log call — asserting on the
 * `context` field alone would miss everything carried in `message`.
 */
describe('diagnostics do not leak file content', () => {
  function envelopeOf(thunk: () => unknown): string {
    try {
      thunk()
    } catch (error) {
      if (isAppError(error)) return JSON.stringify(error.toEnvelope())
      throw error
    }
    throw new Error('expected a throw')
  }

  it('bounds the envelope for an oversized move value', () => {
    // 5000 characters in one property. Before the cap this produced a ~10 kB
    // envelope, since the value appeared in both `message` and `context`.
    const huge = 'Z'.repeat(5000)
    const envelope = envelopeOf(() => getMove(rootOf(`(;FF[4]SZ[19]B[${huge}])`), 19))
    expect(envelope.length).toBeLessThan(200)
    // Not merely short — the run itself must be absent, not truncated to a
    // prefix that still carries file bytes.
    expect(envelope).not.toContain('ZZZ')
    // The length is what is useful at that size, so it is reported.
    expect(envelope).toContain('5000')
  })

  it('bounds the envelope for an oversized setup value', () => {
    const huge = 'Q'.repeat(5000)
    const envelope = envelopeOf(() => getSetup(rootOf(`(;FF[4]SZ[19]AB[${huge}])`), 19))
    expect(envelope.length).toBeLessThan(200)
    expect(envelope).not.toContain('QQQ')
  })

  it('does not quote a short value that is not coordinate-shaped', () => {
    // The gap every other test in this block missed. They all use 5000-character
    // values, so they prove the *length* cap works and say nothing about short
    // values — and the cap was 16, chosen as "several times the longest legal
    // coordinate", which is also long enough to hold a phrase. A 13-character
    // password in `B[…]` came back verbatim in both `message` and `context`.
    //
    // Two values, because the two branches differ and only one of them existed
    // before: over the cap the length is reported, and under it the shape test
    // now refuses. Length alone was the wrong test — what makes a value safe to
    // quote is that it could *be* a coordinate, not that it is short.
    const long = 'MyPasswrd1234'
    expect(long.length).toBeLessThanOrEqual(16)
    const longEnvelope = envelopeOf(() =>
      getMove(rootOf(`(;FF[4]SZ[19]B[${long}])`), 19),
    )
    expect(longEnvelope).not.toContain('MyPasswrd')
    expect(longEnvelope).not.toContain('1234')
    expect(longEnvelope).toContain('13 characters')

    // Short enough to clear the cap, and under the old length-only rule it was
    // returned verbatim.
    const short = 'pw12'
    const shortEnvelope = envelopeOf(() =>
      getMove(rootOf(`(;FF[4]SZ[19]B[${short}])`), 19),
    )
    expect(shortEnvelope).not.toContain('pw12')
    expect(shortEnvelope).toContain('not coordinate-shaped')
  })

  it('still quotes a value that really is coordinate-shaped', () => {
    // The counterweight: refusing to quote must not extend to the case the
    // diagnostic exists for. `zz` is off-board on a 19x19 and naming it is the
    // entire point — a test that only checked the negative above would pass on an
    // implementation that redacted everything.
    const envelope = envelopeOf(() => getMove(rootOf('(;FF[4]SZ[19]B[zz])'), 19))
    expect(envelope).toContain('zz')
  })

  it('does not quote a short value that mixes coordinate characters with others', () => {
    // `ab@cd` is short and starts like a point, so a naive prefix check would
    // pass it. The shape test has to apply to the whole value.
    const envelope = envelopeOf(() => getMove(rootOf('(;FF[4]SZ[19]B[ab@cd])'), 19))
    expect(envelope).not.toContain('@')
    expect(envelope).toContain('not coordinate-shaped')
  })

  it('bounds the envelope for an oversized property identifier', () => {
    // `readIdent` consumes an unbounded run of letters, so the identifier is a
    // second unbounded channel — distinct from the value, and it was missed
    // when only values were capped.
    const ident = 'A'.repeat(5000)
    const envelope = envelopeOf(() => parseSgf(`(;FF[4]${ident})`))
    expect(envelope.length).toBeLessThan(200)
    expect(envelope).not.toContain('AAAA')
  })

  it('bounds the envelope for an oversized board size', () => {
    const huge = '9'.repeat(5000)
    const envelope = envelopeOf(() => getBoardSize(rootOf(`(;FF[4]SZ[${huge}])`)))
    expect(envelope.length).toBeLessThan(200)
    expect(envelope).not.toContain('999999')
  })

  it('quotes no file text at all for a short non-numeric board size', () => {
    // `describeValue` is the wrong tool for a number field even now that it
    // shape-checks: `SZ[19]` is not coordinate-shaped either, so routing `SZ`
    // through it would describe legal sizes instead of naming them. `SZ` reports
    // numerically, which both names a real size and reveals nothing otherwise.
    const secret = 'my private note'
    const envelope = envelopeOf(() => getBoardSize(rootOf(`(;FF[4]SZ[${secret}])`)))

    expect(envelope).not.toContain('private')
    expect(envelope).not.toContain('note')
    expect(envelope).toContain('not a number')
  })

  it('quotes no file text for a short non-numeric rectangular size', () => {
    // The rectangular branch has its own message and needed its own test: a
    // numeric `SZ[19:9]` reads identically whether the dimensions are described
    // or the value is quoted verbatim, so only a non-numeric value can tell the
    // two apart. Both halves must be described, not just the first.
    const envelope = envelopeOf(() => getBoardSize(rootOf('(;FF[4]SZ[ab:cd])')))

    expect(envelope).not.toContain('ab')
    expect(envelope).not.toContain('cd')
    expect(envelope).toContain('not a number')
  })

  it('still reports which board size was rejected', () => {
    // The counterweight: describing numerically must not stop the diagnostic
    // naming the size, which is the one fact the user needs to act on.
    const envelope = envelopeOf(() => getBoardSize(rootOf('(;FF[4]SZ[7])')))
    expect(envelope).toContain('7')

    const rect = envelopeOf(() => getBoardSize(rootOf('(;FF[4]SZ[19:9])')))
    expect(rect).toContain('19:9')
  })

  it('still names a short off-board coordinate', () => {
    // The counterweight to every test above: a diagnostic that will not say
    // *which* point was off-board is not a diagnostic. Capping must not become
    // redaction of the thing worth reporting.
    const envelope = envelopeOf(() => getMove(rootOf('(;FF[4]SZ[9]B[rs])'), 9))
    expect(envelope).toContain('rs')
  })

  it('does not quote the contents of a file that is not SGF', () => {
    // The realistic case: a private document opened by mistake. This branch is
    // reached precisely because the input is *not* a game record, so no part of
    // it is a coordinate that is safe to name.
    const secret = 'Dear Bob, the merger price is $4.2M and the board has not met'
    const envelope = envelopeOf(() => parseSgf(secret))
    expect(envelope).not.toContain('merger')
    expect(envelope).not.toContain('Bob')
    expect(envelope).not.toContain('4.2M')
    // One character is kept, which distinguishes markup from JSON from prose
    // without carrying a sentence into a log file.
    expect(envelope).toContain('"firstChar":"D"')
  })

  it('does not quote a long single line of non-SGF text', () => {
    const envelope = envelopeOf(() => parseSgf('x'.repeat(5000)))
    expect(envelope.length).toBeLessThan(200)
    expect(envelope).not.toContain('xxx')
  })
})
