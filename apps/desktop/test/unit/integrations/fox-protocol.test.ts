/*
 * The fixture transports are deliberately synchronous functions typed as
 * async (the contract the protocol layer consumes). require-await would
 * force a meaningless `await Promise.resolve()` into every one of them.
 */
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest'
import {
  FoxProtocolError,
  fetchGameSgf,
  isImportable,
  listGames,
  lookupUser,
  normalizeListPayload,
  normalizeSgfPayload,
  type FoxFetch,
} from '../../../src/main/integrations/fox/protocol'

/**
 * The Fox protocol layer against STRUCTURAL fixtures (see the task's
 * research/fox-fixtures.md: shapes match the upstream tool's parsing
 * expectations; live verification is a named residual). What the suite pins:
 *
 * - the double URL-encoding quirk (a single-encoded nickname is the measured
 *   empty-result failure, so the exact URL text is asserted);
 * - payload normalisation tolerates junk rows without losing the page;
 * - every failure is a typed FoxProtocolError, never a bare throw — the
 *   service maps them onto SOURCE_* codes for the renderer.
 *
 * `fetch` is injected, so nothing here touches a network.
 */

const fixturesDir = '../../../src/main/integrations/fox/fixtures'

function fetchReturning(body: string, status = 200): FoxFetch & { urls: string[] } {
  const urls: string[] = []
  const fetch: FoxFetch = async (url) => {
    urls.push(url)
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return Object.assign(fetch, { urls })
}

const USER_FIXTURE = JSON.stringify([
  { uid: 12345678, nickname: '测试棋手', level: '9段' },
])

const LIST_FIXTURE = JSON.stringify([
  {
    chessid: '20260901-001',
    black: '测试棋手',
    white: '对手甲',
    date: '2026-09-01',
    result: 'B+2.5',
    extra_unknown_field: true,
  },
  {
    chessid: '20260901-002',
    black: '对手乙',
    white: '测试棋手',
    date: '2026-09-02',
    result: 'W+R',
  },
  // A junk row: no chessid. One malformed record must not lose the page.
  { black: '幽灵' },
  'not-an-object',
])

const SGF_FIXTURE = JSON.stringify({
  sgf: '(;GM[1]FF[4]SZ[19]PB[测试棋手]PW[对手甲]RE[B+2.5];B[pd];W[dp])',
  meta: 'irrelevant',
})

describe('lookupUser', () => {
  it('double-encodes the nickname in the query URL (the measured upstream quirk)', async () => {
    const fetch = fetchReturning(USER_FIXTURE)
    await lookupUser(fetch, '测试棋手')
    expect(fetch.urls).toHaveLength(1)
    const url = fetch.urls[0] ?? ''
    // encodeURIComponent('%E6%B5%8B') === '%25E6%25B5%258B' — the % signs of
    // the first encoding are themselves encoded in the second.
    expect(url).toContain(
      'username=%25E6%25B5%258B%25E8%25AF%2595%25E6%25A3%258B%25E6%2589%258B',
    )
    expect(url).toContain('srcuid=0')
  })

  it('resolves the first user panel to uid + nickname', async () => {
    const user = await lookupUser(fetchReturning(USER_FIXTURE), '测试棋手')
    expect(user).toEqual({ uid: '12345678', nickname: '测试棋手' })
  })

  it('an empty panel list is FOX_USER_NOT_FOUND, not an empty result', async () => {
    const promise = lookupUser(fetchReturning('[]'), 'nobody')
    await expect(promise).rejects.toMatchObject({ code: 'FOX_USER_NOT_FOUND' })
  })

  it('non-JSON responses are FOX_BAD_PAYLOAD', async () => {
    const promise = lookupUser(fetchReturning('<html>login</html>'), 'x')
    await expect(promise).rejects.toMatchObject({ code: 'FOX_BAD_PAYLOAD' })
  })

  it('a non-2xx status is FOX_UPSTREAM_STATUS with the code in the message', async () => {
    const promise = lookupUser(fetchReturning('gone', 503), 'x')
    await expect(promise).rejects.toMatchObject({
      code: 'FOX_UPSTREAM_STATUS',
    })
    await expect(promise).rejects.toThrow(/503/)
  })
})

describe('listGames', () => {
  it('encodes the uid and omits the cursor for the first page', async () => {
    const fetch = fetchReturning(LIST_FIXTURE)
    const games = await listGames(fetch, '12345678')
    expect(fetch.urls[0]).toBe(
      'https://h5.foxwq.com/yehuDiamond/chessbook_local/YHWQFetchChess?uid=12345678',
    )
    expect(games).toHaveLength(2)
    expect(games[0]).toEqual({
      chessid: '20260901-001',
      black: '测试棋手',
      white: '对手甲',
      date: '2026-09-01',
      result: 'B+2.5',
    })
  })

  it('passes the pagination cursor when given', async () => {
    const fetch = fetchReturning('[]')
    await listGames(fetch, '12345678', '20260901-002')
    expect(fetch.urls[0]).toContain('lastcode=20260901-002')
  })

  it('normalizeListPayload drops junk rows but keeps the good ones', () => {
    const games = normalizeListPayload(LIST_FIXTURE)
    expect(games.map((game) => game.chessid)).toEqual(['20260901-001', '20260901-002'])
  })

  it('isImportable requires at least one named player', () => {
    expect(
      isImportable({ chessid: '1', black: 'a', white: '', date: '', result: '' }),
    ).toBe(true)
    expect(
      isImportable({ chessid: '1', black: '', white: '', date: '', result: '' }),
    ).toBe(false)
  })
})

describe('fetchGameSgf', () => {
  it('extracts the SGF from the JSON wrapper', async () => {
    const fetch = fetchReturning(SGF_FIXTURE)
    const sgf = await fetchGameSgf(fetch, '20260901-001')
    expect(sgf).toContain('(;GM[1]FF[4]SZ[19]')
    expect(fetch.urls[0]).toContain('chessid=20260901-001')
  })

  it('accepts a bare SGF body (some responses are unwrapped)', async () => {
    const sgf = await fetchGameSgf(fetchReturning('(;GM[1]FF[4])'), 'x')
    expect(sgf).toContain(';GM[1]')
  })

  it('a payload with no SGF is FOX_BAD_PAYLOAD', async () => {
    const promise = fetchGameSgf(fetchReturning(JSON.stringify({ foo: 1 })), 'x')
    await expect(promise).rejects.toMatchObject({ code: 'FOX_BAD_PAYLOAD' })
  })
})

describe('normalizeSgfPayload', () => {
  it('rejects JSON without an sgf field and accepts bare SGF', () => {
    expect(() => normalizeSgfPayload(JSON.stringify({ foo: 1 }))).toThrow(
      FoxProtocolError,
    )
    expect(normalizeSgfPayload('(;GM[1])')).toBe('(;GM[1])')
  })
})

describe('the error type is the boundary', () => {
  it('every rejection is a FoxProtocolError with a mapped code', async () => {
    const cases: Promise<unknown>[] = [
      lookupUser(fetchReturning('[]'), 'nobody'),
      lookupUser(fetchReturning('<html/>', 500), 'x'),
      listGames(fetchReturning('not json'), '12345678'),
      fetchGameSgf(fetchReturning('{"nope":1}'), 'x'),
    ]
    for (const promise of cases) {
      const error = await promise.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FoxProtocolError)
    }
  })
})

// fixturesDir is referenced by the fixture-loading test variant; keep the
// constant honest even though this suite builds fixtures inline.
void fixturesDir
