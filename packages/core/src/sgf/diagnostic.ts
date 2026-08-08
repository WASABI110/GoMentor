/**
 * Bounding what an SGF parse failure is allowed to say about the file.
 *
 * Two separate problems, one helper each.
 *
 * **Size.** `AppError.toEnvelope()` forwards `context` verbatim, and
 * `logging-guidelines.md:54` says error `context` is logged. A malformed file
 * can put an arbitrary number of bytes in a single property value, so quoting
 * one unbounded gives an unbounded envelope — a 5 kB `B[ZZZ…]` produced a 10 kB
 * envelope before this existed. `gtp.ts:174` already caps engine output at 40
 * characters for exactly this reason; SGF had simply never had the same rule
 * applied.
 *
 * **Content.** `logging-guidelines.md:76` puts SGF content and game records
 * out of bounds for logging outright. That cannot mean "never name a
 * coordinate" — a diagnostic that will not say *which* point was off-board is
 * not a diagnostic — so the line drawn here is the same one `analysis.ts`
 * draws: a board position is safe to name, and file text is not.
 *
 * Hence the split. A value that could plausibly be a coordinate — short enough
 * and built from the characters SGF allows in a point — is quoted. Anything else
 * is described rather than quoted: text from a file that turned out not to be SGF
 * at all has no defined shape and may be any private document the user pointed at
 * by mistake, and *being short does not make it a coordinate*. That last part was
 * learned the hard way; see {@link describeValue}.
 */

/**
 * The cap for a quoted property value.
 *
 * A legal `Point` is 2 characters and a compressed rectangle is 5, so 6 covers
 * every well-formed value with one to spare. It was 16 for a while, on the
 * reasoning that "several times the longest legal value" was safely
 * conservative — but that made the *length* the rule while this file's own
 * doc-comment claims the rule is *shape*, and the gap between the two was
 * reachable: `describeValue('MyPasswrd1234')` returned it verbatim, 13 bytes of
 * a user's file quoted into a `message` and a `context` that `toEnvelope()`
 * forwards and main logs, against `logging-guidelines.md:76`. Anything longer
 * than a rectangle is not a coordinate that needs showing.
 */
const MAX_QUOTED = 6

/** Characters a `Point` or compressed rectangle can be built from. */
const COORDINATE_SHAPE = /^[a-zA-Z]{1,2}(?::[a-zA-Z]{1,2})?$/

/**
 * Describes a property value that should have been a coordinate.
 *
 * Quoted only when it could plausibly *be* a coordinate — short enough and built
 * from the characters SGF allows in a point. Naming the point is the whole
 * diagnostic, so `zz` and `aa:bb` come back as themselves.
 *
 * Everything else is described, not quoted. Length alone was not a sufficient
 * test: a short value can still be file content that is nothing like a
 * coordinate (`MyPasswrd1234` is 13 characters), and for such a value the useful
 * fact is that it is not coordinate-shaped, not what it says. Reporting the
 * length for the over-long case keeps the anomaly visible without putting file
 * bytes in a log.
 */
export function describeValue(raw: string): string {
  if (raw.length <= MAX_QUOTED && COORDINATE_SHAPE.test(raw)) return raw
  return raw.length <= MAX_QUOTED
    ? '<not coordinate-shaped>'
    : `<${String(raw.length)} characters>`
}

/**
 * Describes the start of something that is not an SGF file.
 *
 * Deliberately reports the first character and nothing else. This path is
 * reached precisely when the input did *not* parse as SGF, so it is not a game
 * record whose coordinates are safe to name — it is arbitrary text, and the
 * observed real case is a user opening a private document by mistake. The
 * earlier version quoted 32 characters, which was enough to carry a sentence of
 * it into a log file that outlives the session.
 *
 * One character still separates the cases worth separating: `<` for markup, `{`
 * for JSON, a letter for prose or program output. The message itself already
 * says the file does not begin with a game tree.
 */
export function describeNonSgfStart(text: string): string {
  return text.trimStart()[0] ?? '<empty>'
}

/**
 * Describes a property value that should have been a number.
 *
 * {@link describeValue} is the wrong tool for these. Its 16-character allowance
 * is justified by coordinates — the point is the diagnostic, so it has to be
 * quoted — but a numeric field has no such need: either the value parses, and
 * the number itself is the whole story, or it does not, and *that* is the story.
 * Sixteen characters of arbitrary file text is strictly more than either case
 * requires, and `SZ[<16 chars of a private comment>]` is a real shape a
 * malformed file can take.
 *
 * So a value that parses as a number is reported as that number, and one that
 * does not is reported only as not being one. Nothing verbatim from the file
 * survives either branch.
 */
export function describeNumeric(raw: string): string {
  const numeric = Number(raw.trim())
  return Number.isFinite(numeric) ? String(numeric) : '<not a number>'
}
