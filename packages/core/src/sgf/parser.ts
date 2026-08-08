import { AppError } from '@gomentor/shared'
import {
  UNKNOWN_ENCODING,
  type SgfCollection,
  type SgfNode,
  type SgfProperty,
} from './ast'
import { describeNonSgfStart, describeValue } from './diagnostic'

/**
 * SGF parser.
 *
 * Hand-written tokeniser rather than `@sabaki/sgf`'s high-level API, for one
 * reason: A5 requires unknown properties to round-trip **byte-for-byte**, and
 * that means owning the escape handling. A library that helpfully decodes
 * `\]` to `]` on read has already lost the information needed to write the
 * original bytes back.
 *
 * So values are kept raw here. Decoding happens in the typed accessors
 * (`props.ts`), where it is opt-in per property.
 *
 * Error handling: every failure mode gets a distinct code, and **nothing
 * loops unbounded** — a parser that hangs on a truncated file freezes the
 * import flow with no recovery path, which is worse than rejecting it (A6).
 */

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], label: 'utf-8' as const, encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], label: 'utf-16le' as const, encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], label: 'utf-16be' as const, encoding: 'utf-16be' },
]

export interface ParseOptions {
  /**
   * Overrides both the `CA` property and sniffing. Used when the caller
   * already knows better, e.g. re-parsing a file we just wrote.
   */
  encoding?: string
}

interface DetectedEncoding {
  bom: SgfCollection['bom']
  encoding: string
  /** Offset in bytes where content starts, past any BOM. */
  offset: number
}

function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  for (const bom of BOMS) {
    if (bom.bytes.every((b, i) => bytes[i] === b)) {
      return { bom: bom.label, encoding: bom.encoding, offset: bom.bytes.length }
    }
  }
  return { bom: null, encoding: 'utf-8', offset: 0 }
}

/**
 * Reads the `CA` property without a full parse, so we know how to decode
 * before we decode. Scans only the root node's properties.
 */
function sniffCharset(text: string): string | null {
  // Bounded: only look at the first 2KB, which is far past any root node.
  const head = text.slice(0, 2048)
  const match = /\bCA\s*\[([^\]]*)\]/.exec(head)
  if (!match) return null
  const declared = (match[1] ?? '').trim()
  return declared === '' ? null : declared
}

/** Maps SGF `CA` values and common aliases onto TextDecoder labels. */
function normaliseEncoding(label: string): string {
  const key = label.toLowerCase().replace(/[^a-z0-9]/g, '')
  const aliases: Record<string, string> = {
    utf8: 'utf-8',
    utf16: 'utf-16le',
    utf16le: 'utf-16le',
    utf16be: 'utf-16be',
    mskanji: 'shift_jis',
    shiftjis: 'shift_jis',
    sjis: 'shift_jis',
    xsjis: 'shift_jis',
    eucjp: 'euc-jp',
    euckr: 'euc-kr',
    gb2312: 'gbk',
    gbk: 'gbk',
    gb18030: 'gb18030',
    big5: 'big5',
    iso88591: 'iso-8859-1',
    latin1: 'iso-8859-1',
    ascii: 'utf-8',
    usascii: 'utf-8',
  }
  const mapped = aliases[key]
  if (mapped !== undefined) return mapped
  // An unrecognised label is only returned if `TextDecoder` actually accepts
  // it — the alias table cannot list every valid label, so a pass-through is
  // right for `windows-1252` and wrong for `X-MADE-UP`. Returning a label no
  // decoder accepts would put a value in `collection.encoding` that makes
  // `new TextDecoder(encoding)` throw a bare `RangeError` downstream, in the
  // A5 baseline and in any consumer that trusts the field.
  return isDecoderLabel(label) ? label : UNKNOWN_ENCODING
}

/** Whether `TextDecoder` accepts this label at all. */
function isDecoderLabel(label: string): boolean {
  try {
    new TextDecoder(label)
    return true
  } catch {
    return false
  }
}

function decode(bytes: Uint8Array, encoding: string): string {
  // The sentinel is not a decoder label. Latin-1 is the right reading for it,
  // though not for the reason it first appears: WHATWG aliases `iso-8859-1` to
  // windows-1252, so `0x80`–`0x9f` do *not* decode to the same code point
  // (`0x82` becomes U+201A). What matters is the two properties that do hold —
  // it is identity on ASCII, so `(`, `;`, `[` and `]` are exactly where they
  // were, and it is a bijection over all 256 bytes, so no two input bytes
  // collapse into one character and no byte becomes U+FFFD. The text is
  // mojibake, but it is reversible mojibake, and the tree is intact.
  if (encoding === UNKNOWN_ENCODING) {
    return new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes)
  }
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes)
  } catch {
    // An unknown label is not fatal: fall back rather than reject a file we
    // could still read approximately.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/** Whether the bytes are well-formed UTF-8, with no invalid sequence. */
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Chooses an encoding for a file that declares no `CA`.
 *
 * Only two answers are honest here, and the distinction is the whole point.
 *
 * **UTF-8**, when the bytes are valid UTF-8. This is safe rather than merely
 * likely: a byte sequence that is valid UTF-8 and *also* meaningful in a legacy
 * codepage is vanishingly rare, because UTF-8's continuation-byte structure is
 * what legacy codepages do not respect.
 *
 * **`null`** — unknown — when they are not. It is tempting to guess, and the
 * corpus shows exactly why not: `sabaki-sgf-no-ca.sgf` decodes without error
 * under gbk, big5 *and* euc-kr, and `gnugo-9handicap-glgo-latin1.sgf` under all
 * five candidates tried. `TextDecoder` succeeding proves nothing about
 * correctness, so a guess here is a coin flip that produces plausible
 * mojibake — and mojibake that parses is worse than a file we admit we cannot
 * read, because it gets written back over the original.
 *
 * The caller decodes `null` as latin-1 so the *structure* stays readable (it is
 * byte-preserving, so `(`, `;`, `[`, `]` all survive), and records the encoding
 * as unknown so serialisation refuses to write rather than corrupt. A user can
 * then supply the codepage via `options.encoding`, which is the only source of
 * truth that actually exists for these files.
 */
function sniffWithoutDeclaration(bytes: Uint8Array): string | null {
  return isValidUtf8(bytes) ? 'utf-8' : null
}

class Tokeniser {
  private readonly text: string
  private pos = 0

  constructor(text: string) {
    this.text = text
  }

  get offset(): number {
    return this.pos
  }

  /** The input length, so callers can bound loops by it rather than by a constant. */
  get length(): number {
    return this.text.length
  }

  atEnd(): boolean {
    return this.pos >= this.text.length
  }

  peek(): string | undefined {
    return this.text[this.pos]
  }

  next(): string | undefined {
    const char = this.text[this.pos]
    this.pos++
    return char
  }

  /** Puts characters back, so whitespace can be attributed to the next token. */
  rewind(count: number): void {
    this.pos = Math.max(0, this.pos - count)
  }

  /** Restores a previously recorded offset, so lookahead can be undone. */
  seek(offset: number): void {
    this.pos = offset
  }

  skipWhitespace(): string {
    const start = this.pos
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]
      if (char === undefined || !/\s/.test(char)) break
      this.pos++
    }
    return this.text.slice(start, this.pos)
  }

  /**
   * Reads a property identifier. The spec says uppercase letters are
   * significant and lowercase are ignored, which is how `PlayerBlack` and
   * `PB` mean the same thing.
   */
  readIdent(): string {
    const start = this.pos
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]
      if (char === undefined || !/[A-Za-z]/.test(char)) break
      this.pos++
    }
    return this.text.slice(start, this.pos)
  }

  /**
   * Reads one `[...]` value, returning its **raw** contents with escapes
   * intact. Consumes the closing bracket.
   */
  readValue(): string {
    // Caller has consumed '['.
    const start = this.pos
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]
      if (char === '\\') {
        // A backslash escapes the next character, including ']' and itself.
        // Skipping two keeps '\]' from ending the value.
        this.pos += 2
        continue
      }
      if (char === ']') {
        const raw = this.text.slice(start, this.pos)
        this.pos++
        return raw
      }
      this.pos++
    }
    throw new AppError('SGF_TRUNCATED', 'unterminated property value', {
      context: { offset: start },
    })
  }
}

let nextNodeId = 0

function makeNode(parent: SgfNode | null): SgfNode {
  nextNodeId += 1
  return { id: nextNodeId, properties: [], parent, children: [] }
}

/**
 * Cap on `(` nesting depth.
 *
 * `parseGameTree` recurses once per nested subtree, so a file with thousands of
 * nested variations exhausts the JS stack. Left unguarded that surfaces as a
 * bare `RangeError` — no `code`, so the caller cannot branch, the UI cannot
 * translate it, and it is indistinguishable from a genuine crash. Exactly the
 * "never hangs, always typed" contract A6 exists to enforce, failing in the one
 * shape a test asserting only on error *type* would miss.
 *
 * 512 is chosen against measurement, not taste. The deepest file in the
 * real-world corpus nests 113 (`katrain-ogs.sgf`). That headroom is smaller
 * than it looks: OGS writes every move as its own subtree, so for that file
 * shape nesting *equals* move count — 113 parens for 113 moves, and a 512-move
 * OGS export would be rejected. Long for a game, but not impossible.
 *
 * The ceiling is what forces the number to stay here rather than be raised:
 * `serialiseSgf` recurses per subtree too and overflows around 3000, so the
 * limit must sit **below** what the serialiser can handle — otherwise the
 * parser would accept a tree that cannot be written back, turning a rejected
 * import into data loss on save. Raising this safely means making the
 * serialiser iterative first.
 */
const MAX_TREE_DEPTH = 512

/**
 * Parses SGF source into a collection.
 *
 * Accepts bytes (preferred — lets us detect the BOM and honour `CA`) or a
 * string (convenient for tests and for content we generated ourselves).
 */
export function parseSgf(
  source: Uint8Array | string,
  options: ParseOptions = {},
): SgfCollection {
  let text: string
  let bom: SgfCollection['bom'] = null
  let encoding = 'utf-8'

  if (typeof source === 'string') {
    text = source
    encoding = options.encoding ?? 'utf-8'
  } else {
    if (source.byteLength === 0) {
      throw new AppError('SGF_EMPTY', 'file is empty')
    }

    const detected = detectEncoding(source)
    bom = detected.bom
    const body = source.subarray(detected.offset)

    if (options.encoding !== undefined) {
      encoding = normaliseEncoding(options.encoding)
      text = decode(body, encoding)
    } else if (detected.bom !== null) {
      // A BOM is authoritative — it beats any CA declaration.
      encoding = detected.encoding
      text = decode(body, encoding)
    } else {
      // Read once as latin-1 to find CA without mangling high bytes, then
      // re-decode properly. latin-1 is byte-preserving for this purpose.
      const provisional = decode(body, 'iso-8859-1')
      const declared = sniffCharset(provisional)
      if (declared !== null) {
        encoding = normaliseEncoding(declared)
        text = decode(body, encoding)
      } else {
        const sniffed = sniffWithoutDeclaration(body)
        if (sniffed === null) {
          // Undeterminable. Keep the latin-1 decoding already in hand: it is
          // identity on ASCII and injective over the rest, so the structural
          // characters — `(`, `;`, `[`, `]` — are all intact and the game is
          // still readable as a tree. Only the text properties are mojibake,
          // and `encoding: 'unknown'` stops serialisation writing that
          // mojibake back over the original.
          //
          // Previously this branch assumed UTF-8, which silently rewrote six
          // real corpus files — one from 917 bytes to 1543, irreversibly.
          encoding = UNKNOWN_ENCODING
          text = provisional
        } else {
          encoding = sniffed
          text = decode(body, encoding)
        }
      }
    }
  }

  if (text.trim() === '') {
    throw new AppError('SGF_EMPTY', 'file contains no content')
  }

  const tokeniser = new Tokeniser(text)
  const leadingText = tokeniser.skipWhitespace()

  if (tokeniser.peek() !== '(') {
    throw new AppError('SGF_NOT_SGF', 'input does not begin with a game tree', {
      // The first character only. This branch is reached when the input is not
      // an SGF file, so it may be any document the user opened by mistake, and
      // this context is logged.
      context: { firstChar: describeNonSgfStart(text) },
    })
  }

  const roots: SgfNode[] = []
  // Bounded by input length: every iteration consumes at least one character.
  let guard = text.length + 1
  let trailingText = ''

  while (!tokeniser.atEnd()) {
    const between = tokeniser.skipWhitespace()
    if (tokeniser.peek() !== '(') {
      // Whitespace after the last tree, typically a final newline.
      trailingText = between
      break
    }

    guard -= 1
    if (guard <= 0) {
      throw new AppError('SGF_INVALID_PROPERTY', 'parser failed to make progress')
    }

    const tree = parseGameTree(tokeniser, null, 1)
    // Whitespace *before* this tree's '(' — the same role `isSubtree` children
    // use, so it shares that field. Not `leadingWhitespace`: that one is the
    // whitespace *inside* the paren, and parseGameTree may already have set it.
    if (between !== '' && roots.length > 0) tree.subtreeLeadingWhitespace = between
    roots.push(tree)
  }

  if (roots.length === 0) {
    throw new AppError('SGF_NOT_SGF', 'no game tree found')
  }

  const collection: SgfCollection = { roots, bom, encoding, leadingText }
  if (trailingText !== '') collection.trailingText = trailingText
  return collection
}

function parseGameTree(
  tokeniser: Tokeniser,
  parent: SgfNode | null,
  depth: number,
): SgfNode {
  // Checked on entry, before any recursion, so the throw happens with stack to
  // spare rather than as a RangeError one frame later.
  if (depth > MAX_TREE_DEPTH) {
    throw new AppError('SGF_TOO_DEEP', 'game tree nesting is too deep to parse', {
      context: { depth, limit: MAX_TREE_DEPTH, offset: tokeniser.offset },
    })
  }

  const open = tokeniser.next()
  if (open !== '(') {
    throw new AppError('SGF_NOT_SGF', `expected '(' at ${String(tokeniser.offset)}`)
  }

  let root: SgfNode | null = null
  let current: SgfNode | null = null
  // Bounded by input length, like the sibling loop above, and not by
  // `Number.MAX_SAFE_INTEGER` as it once was. Every branch does consume input, so
  // this should never fire — but a guard at 2^53 is not a termination bound: it
  // would take longer than the process's useful life to reach, so a spin would
  // present as a hang, which is exactly what the guard exists to prevent.
  // `quality-guidelines.md` requires parsers to be *asserted* to terminate, and
  // vitest's `timeout` option cannot enforce that on synchronous code — it
  // reports afterwards, it does not interrupt (measured: a 500ms-timeout test
  // spinning 3s runs the full 3s, then fails). So the bound has to be real here.
  let guard = tokeniser.length + 1

  for (;;) {
    guard -= 1
    if (guard <= 0)
      throw new AppError('SGF_INVALID_PROPERTY', 'parser failed to make progress')

    // Captured rather than discarded: real files are heavily formatted, and
    // byte-exact round-trip (A5) means putting the layout back.
    const whitespace = tokeniser.skipWhitespace()
    const char = tokeniser.peek()

    if (char === undefined) {
      throw new AppError('SGF_TRUNCATED', 'unterminated game tree')
    }

    if (char === ';') {
      tokeniser.next()
      const node = makeNode(current ?? parent)
      if (whitespace !== '') node.leadingWhitespace = whitespace
      if (root === null) {
        root = node
      } else if (current !== null) {
        current.children.push(node)
      }
      current = node
      parseProperties(tokeniser, node)
      continue
    }

    if (char === '(') {
      if (current === null) {
        throw new AppError('SGF_NOT_SGF', 'variation before any node')
      }
      const child = parseGameTree(tokeniser, current, depth + 1)
      // Whitespace before this subtree's '(' — distinct from whitespace
      // *inside* it, which the subtree's root holds as leadingWhitespace.
      if (whitespace !== '') child.subtreeLeadingWhitespace = whitespace
      child.isSubtree = true
      current.children.push(child)
      continue
    }

    if (char === ')') {
      tokeniser.next()
      if (root === null) {
        throw new AppError('SGF_NOT_SGF', 'empty game tree')
      }
      if (whitespace !== '') root.trailingWhitespace = whitespace
      return root
    }

    if (/[A-Za-z]/.test(char)) {
      // Properties directly after '(' with no leading ';'. The spec requires
      // the semicolon, but real Nihon Ki-in records omit it, so an implicit
      // root node is created rather than rejecting a file that other tools
      // read fine. `impliedRoot` is recorded so serialisation can leave the
      // semicolon out again and stay byte-exact.
      if (root === null) {
        const node = makeNode(parent)
        node.impliedRoot = true
        if (whitespace !== '') node.leadingWhitespace = whitespace
        root = node
        current = node
        parseProperties(tokeniser, node)
        continue
      }
      throw new AppError('SGF_INVALID_PROPERTY', 'properties outside a node', {
        context: { offset: tokeniser.offset },
      })
    }

    throw new AppError('SGF_INVALID_PROPERTY', `unexpected ${JSON.stringify(char)}`, {
      context: { offset: tokeniser.offset },
    })
  }
}

function parseProperties(tokeniser: Tokeniser, node: SgfNode): void {
  for (;;) {
    const mark = tokeniser.offset
    const whitespace = tokeniser.skipWhitespace()
    const char = tokeniser.peek()
    if (char === undefined || !/[A-Za-z]/.test(char)) {
      // Whitespace before the next ';' or ')' belongs to whatever follows, so
      // put the tokeniser back rather than swallowing it — the caller records
      // it as that node's leading whitespace for byte-exact output.
      tokeniser.seek(mark)
      return
    }

    const rawIdent = tokeniser.readIdent()
    // Per spec, lowercase letters in an identifier are not significant, which
    // is how 'PlayerBlack' and 'PB' are the same property.
    const ident = rawIdent.replace(/[^A-Z]/g, '')

    const values: string[] = []
    // Whitespace before each value's '[', parallel to `values`. The spec allows
    // `AB[aa]\n[bb]`, and real files use it to keep long point lists readable.
    const valueWhitespace: string[] = []
    for (;;) {
      // Rewound if what follows is not another value: the whitespace then
      // belongs to the next property (or node), not to this one. Consuming it
      // here is what silently dropped every newline between properties.
      const valueMark = tokeniser.offset
      const before = tokeniser.skipWhitespace()
      if (tokeniser.peek() !== '[') {
        tokeniser.seek(valueMark)
        break
      }
      tokeniser.next()
      values.push(tokeniser.readValue())
      valueWhitespace.push(before)
    }

    if (values.length === 0) {
      // `readIdent` consumes an unbounded run of letters, so the identifier is
      // capped like any other quoted value.
      throw new AppError(
        'SGF_INVALID_PROPERTY',
        `property ${describeValue(rawIdent)} has no value`,
        { context: { offset: tokeniser.offset } },
      )
    }

    const property: SgfProperty = { ident, rawIdent, values }
    if (whitespace !== '') property.leadingWhitespace = whitespace
    // Only recorded when it carries information, so the common case stays a
    // three-field object and `toEqual` comparisons in tests do not see noise.
    if (valueWhitespace.some((w) => w !== ''))
      property.valueWhitespace = valueWhitespace
    node.properties.push(property)
  }
}
