/**
 * The Fox (野狐) public-kifu protocol, isolated here by the integrations rule
 * (`.trellis/spec/backend/directory-structure.md`): an API we do not own, no
 * auth for public records, and shapes that can change without notice. Pure
 * functions over an INJECTED fetch — no network happens without a caller
 * binding one, which is what makes the recorded-fixture tests possible and
 * keeps this module free of process state.
 *
 * ## Endpoint provenance
 *
 * Reverse-engineered by lizzieyzy-next (`GetFoxRequest.java`, GPL-3.0 — same
 * license as this repo, so porting is legal and contribution-compatible);
 * see the M5 task's `research/fox-protocol.md` for the endpoint table and the
 * measured quirks. Two matter here:
 *
 * 1. **Double URL-encoding.** The username/uid parameters are UTF-8-encoded
 *    TWICE (the Java source calls `URLEncoder.encode(URLEncoder.encode(x))`).
 *    Single-encoding returns empty results — measured by the upstream tool
 *    and preserved verbatim.
 * 2. **The payload normalisation.** The list endpoint returns JSON whose
 *    records wrap the SGF in per-record metadata; `normalize...` below is the
 *    single place that knows the shape, so an upstream change is one
 *    function's diff plus a fixture update, not a service rewrite.
 */

const QUERY_USER_URL = 'https://newframe.foxwq.com/cgi/QueryUserInfoPanel'
const LIST_BASE_URL = 'https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess'

/** Minimal fetch contract — the subset of Response this module reads. */
export type FoxFetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/** Double-encode, per the upstream tool's measured behaviour (see header). */
function enc2(value: string): string {
  return encodeURIComponent(encodeURIComponent(value))
}

/** Narrows parsed JSON entries to plain records — the boundary against `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrows to an array of records; non-records are dropped. */
function asRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

async function fetchText(fetch: FoxFetch, url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new FoxProtocolError(
      `FOX_UPSTREAM_STATUS`,
      `fox endpoint answered HTTP ${String(response.status)}: ${url}`,
    )
  }
  return response.text()
}

export class FoxProtocolError extends Error {
  readonly code: 'FOX_UPSTREAM_STATUS' | 'FOX_BAD_PAYLOAD' | 'FOX_USER_NOT_FOUND'

  constructor(
    code: 'FOX_UPSTREAM_STATUS' | 'FOX_BAD_PAYLOAD' | 'FOX_USER_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'FoxProtocolError'
    this.code = code
  }
}

/** The uid lookup result: the numeric id pagination needs, plus a display name. */
export interface FoxUser {
  readonly uid: string
  readonly nickname: string
}

/**
 * Resolves a nickname to the uid the list endpoint needs. The response is a
 * JSON array of user panels; an empty array means "no such public user".
 */
export async function lookupUser(fetch: FoxFetch, nickname: string): Promise<FoxUser> {
  const url = `${QUERY_USER_URL}?srcuid=0&username=${enc2(nickname)}`
  const text = await fetchText(fetch, url)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new FoxProtocolError('FOX_BAD_PAYLOAD', 'user lookup returned non-JSON')
  }
  const list = asRecords(parsed)
  const first = list.find(
    (entry) =>
      typeof entry.uid !== 'undefined' && typeof entry.nickname !== 'undefined',
  )
  if (first === undefined) {
    throw new FoxProtocolError(
      'FOX_USER_NOT_FOUND',
      `no public Fox user named ${nickname}`,
    )
  }
  return { uid: String(first.uid), nickname: String(first.nickname) }
}

/** One record of the paginated list: identity for import plus display fields. */
export interface FoxGameSummary {
  readonly chessid: string
  readonly black: string
  readonly white: string
  readonly date: string
  readonly result: string
}

/**
 * One page of the user's public records. `lastCode` is the upstream's cursor
 * (the last record's code from the previous page); absent or empty for the
 * first page. An empty page means the walk is complete.
 */
export async function listGames(
  fetch: FoxFetch,
  uid: string,
  lastCode?: string,
): Promise<FoxGameSummary[]> {
  const cursor = lastCode === undefined ? '' : `&lastcode=${enc2(lastCode)}`
  const url = `${LIST_BASE_URL}?uid=${enc2(uid)}${cursor}`
  const text = await fetchText(fetch, url)
  return normalizeListPayload(text)
}

/**
 * The single place that knows the list payload's shape. Records arrive as
 * `{ chessid, black, white, date, result }`-shaped objects in a top-level
 * array (fields as rendered by the upstream H5 endpoint). Unknown extra
 * fields are ignored; a record without a chessid is skipped rather than
 * fatal — one malformed row must not lose the page.
 */
export function normalizeListPayload(text: string): FoxGameSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new FoxProtocolError('FOX_BAD_PAYLOAD', 'list payload is not JSON')
  }
  const list = asRecords(parsed)
  const out: FoxGameSummary[] = []
  for (const entry of list) {
    const chessid = entry.chessid
    if (typeof chessid !== 'string' || chessid === '') continue
    out.push({
      chessid,
      black: str(entry.black),
      white: str(entry.white),
      date: str(entry.date),
      result: str(entry.result),
    })
  }
  return out
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Fetches one game's SGF by its chess id. */
export async function fetchGameSgf(fetch: FoxFetch, chessid: string): Promise<string> {
  const url = `${LIST_BASE_URL}?chessid=${enc2(chessid)}`
  const text = await fetchText(fetch, url)
  return normalizeSgfPayload(text)
}

/**
 * The single place that knows the game payload's shape: a JSON object whose
 * `sgf`-ish field carries the record text (the upstream wraps it in metadata).
 * The normalized SGF must start with `(;` — anything else is a payload change,
 * not a game worth half-parsing.
 */
export function normalizeSgfPayload(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Some responses carry the SGF bare. Accept it when it looks like SGF.
    if (text.trimStart().startsWith('(')) return text
    throw new FoxProtocolError('FOX_BAD_PAYLOAD', 'game payload is not JSON')
  }
  const record =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  const sgf =
    record === undefined
      ? undefined
      : (record['sgf'] ?? record['content'] ?? record['text'])
  if (typeof sgf !== 'string' || !sgf.trimStart().startsWith('(')) {
    throw new FoxProtocolError('FOX_BAD_PAYLOAD', 'game payload carries no SGF')
  }
  return sgf
}

/** True when the summary's players mean it belongs in the import list. */
export function isImportable(summary: FoxGameSummary): boolean {
  return summary.black !== '' || summary.white !== ''
}
