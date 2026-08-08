import type { Coord } from '@gomentor/shared'

/**
 * SGF game tree AST.
 *
 * Our own node type rather than a library's, because the move tree UI, library
 * store, IPC payloads, and (from M2) database rows all need **stable node
 * identity**, which raw SGF node arrays do not provide.
 *
 * Two hard contracts shape this design:
 *
 * 1. **Unknown properties survive byte-for-byte** (A5). SGF files in the wild
 *    carry editor-specific properties — `GK`/`LC`/`LT`/`RD` from Nihon Ki-in
 *    records, `SY` from Cgoban, `OS`/`RR` from Pandanet. Silently dropping
 *    them means a user's file degrades every time it passes through GoMentor.
 *    So every property is retained, recognised or not, with its raw value
 *    text preserved exactly as written including escapes.
 *
 * 2. **Property order and layout are preserved.** Two files that differ only in
 *    property order are both valid, and rewriting one into the other's order is
 *    a gratuitous diff in a user's version-controlled game collection. The same
 *    argument applies to whitespace, hence the several `*Whitespace` fields
 *    below: they exist so that opening and saving a file is a no-op.
 *
 * Interpretation of values lives in `props.ts`, never here. Keeping the decode
 * step out of the AST is what makes (1) achievable — a tree that stored `]`
 * where the file wrote `\]` could not reproduce the original bytes.
 */

/** A property's values, as they appeared in the source — escapes intact. */
export interface SgfProperty {
  /** Identifier, e.g. `B`, `SZ`, `GK`. Uppercase per spec, but see `rawIdent`. */
  ident: string
  /**
   * The identifier exactly as written. Some real files use long forms
   * (`PlayerBlack`, `SiZe`) which the spec permits by ignoring lowercase
   * letters. Kept so serialisation does not silently normalise them.
   */
  rawIdent: string
  /**
   * One entry per `[...]` block. Text is **raw**: `\]` is still `\]`, not `]`.
   * Decoding happens in the typed accessors, not here, so that a value we do
   * not understand round-trips untouched.
   */
  values: string[]
  /** Whitespace before the identifier, preserved for byte-exact output. */
  leadingWhitespace?: string
  /**
   * Whitespace before each value's `[`, parallel to `values`. Absent when every
   * entry would be empty, which is the common case. Real files use it to wrap
   * long point lists — `AB[aa][bb]\n[cc][dd]`.
   */
  valueWhitespace?: string[]
}

export interface SgfNode {
  /** Stable within a parse. Not persisted — regenerated on each parse. */
  id: number
  /** Insertion-ordered. Duplicate idents are possible in malformed files. */
  properties: SgfProperty[]
  parent: SgfNode | null
  children: SgfNode[]
  /**
   * True when the source wrote properties straight after `(` with no `;`.
   * The spec requires the semicolon, but real Nihon Ki-in records omit it.
   * Recorded so serialisation can omit it again and stay byte-exact.
   */
  impliedRoot?: boolean
  /**
   * Whitespace that preceded this node's `;` in the source.
   *
   * Required for byte-exact round-trip (A5): real files are heavily formatted
   * with newlines and tabs, and normalising that away would rewrite every
   * file a user opens — a gratuitous diff across their whole collection.
   */
  leadingWhitespace?: string
  /** Whitespace between the last child and this tree's closing `)`. */
  trailingWhitespace?: string
  /** True when this node began its own parenthesised `(...)` subtree. */
  isSubtree?: boolean
  /**
   * For a subtree node, whitespace that preceded its `(`. Kept separate from
   * `leadingWhitespace`, which is the whitespace *inside* the paren before the
   * node's `;`. Real files indent both, and conflating them reorders output.
   */
  subtreeLeadingWhitespace?: string
}

/**
 * `SgfCollection.encoding` when the source encoding could not be determined.
 *
 * A named constant rather than a bare string in two files, because the parser
 * writing it and the serialiser refusing on it have to agree exactly — a typo
 * in either would restore the silent-corruption bug this value exists to
 * prevent. Deliberately not a valid `TextDecoder` label, so it cannot be
 * mistaken for one and passed to a decoder.
 */
export const UNKNOWN_ENCODING = 'unknown'

export interface SgfCollection {
  /** A file may hold several games; most hold one. */
  roots: SgfNode[]
  /**
   * Byte order mark found at the start of the file, if any. Must be re-emitted
   * on serialisation or the round-trip is not byte-exact.
   */
  bom: 'utf-8' | 'utf-16le' | 'utf-16be' | null
  /**
   * Encoding used to decode the source. Either from the root `CA` property, a
   * BOM, the caller's `options.encoding`, or sniffed.
   *
   * `'unknown'` when the file declares no `CA`, carries no BOM, and is not
   * valid UTF-8. That is not a failure to try harder: several legacy codepages
   * accept the same bytes without error, so there is nothing to distinguish
   * them by, and a guess would produce plausible mojibake. Serialisation
   * refuses to write bytes in this state rather than corrupt the original.
   */
  encoding: string
  /**
   * Whether the source had whitespace or a newline before the first `;`.
   * Real files vary and some omit the root `;` entirely (Nihon Ki-in records).
   */
  leadingText: string
  /** Trailing whitespace after the last `)`, commonly a final newline. */
  trailingText?: string
}

/** Finds a property by identifier. Case-insensitive per spec. */
export function getProperty(node: SgfNode, ident: string): SgfProperty | undefined {
  const target = ident.toUpperCase()
  return node.properties.find((p) => p.ident === target)
}

export function hasProperty(node: SgfNode, ident: string): boolean {
  return getProperty(node, ident) !== undefined
}

/** First value of a property, or undefined. Raw — escapes not decoded. */
export function getRawValue(node: SgfNode, ident: string): string | undefined {
  return getProperty(node, ident)?.values[0]
}

/** Walks the mainline: first child at each branch. */
export function mainline(root: SgfNode): SgfNode[] {
  const out: SgfNode[] = []
  let current: SgfNode | undefined = root
  while (current !== undefined) {
    out.push(current)
    current = current.children[0]
  }
  return out
}

/**
 * Depth-first pre-order walk over every node.
 *
 * Iterative, with an explicit stack, rather than the obvious `yield* walk(child)`
 * recursion. A recursive generator recurses once **per node on the mainline**,
 * not per branch, so it overflowed the stack at around 5000 nodes — and a
 * generator's `RangeError` surfaces at the consumer's `for...of`, carrying no
 * `code` and pointing at a line that is merely iterating. Long records exist
 * (the corpus already reaches 401 nodes deep), and a parsed tree that cannot be
 * traversed is worse than one that was rejected.
 *
 * Children are pushed in reverse so they pop left-to-right, keeping the order
 * identical to the recursive version — node identity and ordering are relied on
 * by the round-trip tests and by the move-tree UI.
 */
export function* walk(root: SgfNode): Generator<SgfNode> {
  const stack: SgfNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    yield node
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]
      if (child !== undefined) stack.push(child)
    }
  }
}

export function nodeCount(root: SgfNode): number {
  // Counts via the iterator without binding the yielded value, avoiding an
  // unused-variable exemption that would depend on a naming convention.
  let n = 0
  const iterator = walk(root)
  while (!iterator.next().done) n += 1
  return n
}

/** Path from root to `node`, inclusive. */
export function pathTo(node: SgfNode): SgfNode[] {
  const path: SgfNode[] = []
  let current: SgfNode | null = node
  while (current !== null) {
    path.unshift(current)
    current = current.parent
  }
  return path
}

/** A move extracted from a node, or null if the node has no move property. */
export interface NodeMove {
  player: 'black' | 'white'
  /** null is a pass. */
  coord: Coord | null
}
