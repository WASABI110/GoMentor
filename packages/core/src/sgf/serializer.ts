import { AppError } from '@gomentor/shared'

import { UNKNOWN_ENCODING, type SgfCollection, type SgfNode } from './ast'
import { describeValue } from './diagnostic'

/**
 * SGF serialiser.
 *
 * The contract is byte-exactness on round-trip (A5): `serialise(parse(x))`
 * must equal `x` for every file in the corpus, including files with unknown
 * properties, unusual escaping, and heavy formatting.
 *
 * Two things make that work:
 *
 * 1. **Values are written back raw.** The parser kept `\]` as `\]`, so this
 *    emits it unchanged rather than re-escaping a decoded value. Re-escaping
 *    is where round-trip fidelity usually dies, because decode-then-encode is
 *    only the identity if both agree on every edge case, and real files
 *    disagree.
 *
 * 2. **Whitespace is restored.** Real files are formatted with newlines and
 *    tabs. Normalising that away would rewrite every file a user opens,
 *    producing a gratuitous diff across their whole collection.
 */

export interface SerialiseOptions {
  /**
   * Emit the byte order mark recorded at parse time. Default true — omitting
   * it changes the bytes, so a round-trip test would fail.
   */
  includeBom?: boolean
}

const BOM_BYTES: Record<NonNullable<SgfCollection['bom']>, number[]> = {
  'utf-8': [0xef, 0xbb, 0xbf],
  'utf-16le': [0xff, 0xfe],
  'utf-16be': [0xfe, 0xff],
}

/** Serialises to text. Encoding and BOM are handled by `serialiseToBytes`. */
export function serialiseSgf(collection: SgfCollection): string {
  // A collection root carries the whitespace before its own '(' in
  // subtreeLeadingWhitespace, exactly as a subtree child does.
  const trees = collection.roots.map(
    (root) => `${root.subtreeLeadingWhitespace ?? ''}${serialiseTree(root)}`,
  )
  return `${collection.leadingText}${trees.join('')}${collection.trailingText ?? ''}`
}

function serialiseTree(root: SgfNode): string {
  // `root.leadingWhitespace` is the whitespace between '(' and the root's ';',
  // so it goes *inside* the paren. Whitespace before '(' is held by the
  // collection (leadingText) or by the subtree's own record in the parent.
  // `trailingWhitespace` is what sat before this tree's ')'.
  return `(${root.leadingWhitespace ?? ''}${serialiseMainline(root, true)}${root.trailingWhitespace ?? ''})`
}

/**
 * Emits `start` and everything below it, without the enclosing parens — those
 * belong to `serialiseTree`.
 *
 * `isTreeRoot` suppresses the node's own leading whitespace, which the caller
 * has already emitted after '('.
 */
function serialiseMainline(start: SgfNode, isTreeRoot: boolean): string {
  let out = ''
  let node: SgfNode = start
  let first = isTreeRoot

  // Walks the mainline iteratively and recurses only into branches, so a long
  // game does not build a deep call stack. Every path either breaks or
  // advances to a non-null child, so this is a `for(;;)` rather than a
  // `while (node !== undefined)` — the latter reads as a guard that can never
  // fire.
  for (;;) {
    out += serialiseNode(node, first)
    first = false

    if (node.children.length === 0) break

    const onlyChild: SgfNode | undefined =
      node.children.length === 1 ? node.children[0] : undefined
    if (onlyChild !== undefined && onlyChild.isSubtree !== true) {
      node = onlyChild
      continue
    }

    // A branch point, or a single child the source wrote as its own subtree.
    // A child that is *not* a subtree stays inline even here: `(;A(;B);C)` is
    // legal, and parenthesising `;C` would change the bytes. Its own
    // descendants come with it, hence the recursive call rather than a bare
    // serialiseNode.
    for (const child of node.children) {
      out +=
        child.isSubtree === true
          ? `${child.subtreeLeadingWhitespace ?? ''}${serialiseTree(child)}`
          : serialiseMainline(child, false)
    }
    break
  }

  return out
}

function serialiseNode(node: SgfNode, isTreeRoot: boolean): string {
  let out = isTreeRoot ? '' : (node.leadingWhitespace ?? '')
  // An implied root had no ';' in the source, so emitting one would change the
  // bytes. See SgfNode.impliedRoot.
  if (node.impliedRoot !== true) out += ';'

  for (const property of node.properties) {
    out += property.leadingWhitespace ?? ''
    // rawIdent, not ident: a file that wrote `SiZe[9]` gets `SiZe[9]` back.
    out += property.rawIdent
    for (const [index, value] of property.values.entries()) {
      out += `${property.valueWhitespace?.[index] ?? ''}[${value}]`
    }
  }
  return out
}

/**
 * Serialises to bytes in the collection's original encoding, with its original
 * BOM. This is the round-trip counterpart of `parseSgf(bytes)`.
 *
 * Note the asymmetry: `TextEncoder` only speaks UTF-8, so a file that arrived
 * as Shift-JIS or GB2312 cannot be re-encoded byte-exactly without an encoder
 * for that codepage. Rather than silently write different bytes, this throws —
 * a caller that wants to convert must ask for it explicitly.
 */
export function serialiseToBytes(
  collection: SgfCollection,
  options: SerialiseOptions = {},
): Uint8Array {
  const text = serialiseSgf(collection)
  const encoding = collection.encoding.toLowerCase()

  if (encoding === UNKNOWN_ENCODING) {
    // Distinct from the codepage case below, and distinct in the message: there
    // is no encoder to reach for, because we never established what the file
    // was. Writing UTF-8 here is precisely the bug that rewrote six real corpus
    // files — the text in hand is a latin-1 reading of unknown bytes, so
    // encoding it as UTF-8 produces mojibake with no path back.
    throw new AppError(
      'SGF_UNSUPPORTED_ENCODING',
      'cannot re-encode: the source encoding could not be determined. ' +
        'Re-open the file with an explicit encoding to write it back.',
      { context: { encoding: UNKNOWN_ENCODING } },
    )
  }

  if (encoding !== 'utf-8' && encoding !== 'utf8') {
    // `describeValue` on both: `collection.encoding` comes from the file's
    // `CA[...]`, whose value is bounded only by the 2 KB sniff window, and
    // `toEnvelope` forwards `context` and cannot strip `message`. A 1900-char
    // `CA` produced a 3923-byte envelope carrying file bytes verbatim before
    // this — the same unbounded-diagnostic bug as the property identifier, at
    // the one site that was not using the helper.
    const shown = describeValue(collection.encoding)
    throw new AppError(
      'SGF_UNSUPPORTED_ENCODING',
      `cannot re-encode to ${shown}: TextEncoder only produces UTF-8. ` +
        `Use serialiseSgf() and encode deliberately, or convert the file on import.`,
      { context: { encoding: shown } },
    )
  }

  const body = new TextEncoder().encode(text)

  const includeBom = options.includeBom ?? true
  if (!includeBom || collection.bom === null) return body

  const bomBytes = BOM_BYTES[collection.bom]
  const out = new Uint8Array(bomBytes.length + body.length)
  out.set(bomBytes, 0)
  out.set(body, bomBytes.length)
  return out
}
