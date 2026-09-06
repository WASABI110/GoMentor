import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KATAGO_MANIFEST,
  applyRecordedChecksums,
  currentEngineTarget,
  persistRecordedChecksums,
  readRecordedChecksums,
  recordObservedSha256,
  type WeightAsset,
} from '../katago-manifest'
import {
  ensureFetched,
  fetchBytes,
  outputName,
  type FetchContext,
} from '../fetch-engine'

/**
 * The download/verify contract of the fetch chain, exercised against an
 * injected context so nothing here touches the network or the real resources
 * directory. The invariants under test are the ones the M1 stub comments named:
 * checksum-before-trust, resume, and fail-loudly-never-silently.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fetch-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  // Reset the TOFU hash so a recorded value from one test does not leak into the
  // next. The manifest object is module-level; tests that record a hash restore
  // it here.
  for (const asset of [KATAGO_MANIFEST.weights, KATAGO_MANIFEST.fallbackWeights]) {
    asset.sha256 = null
  }
  for (const key of Object.keys(KATAGO_MANIFEST.engine.targets)) {
    KATAGO_MANIFEST.engine.targets[
      key as keyof typeof KATAGO_MANIFEST.engine.targets
    ].sha256 = null
  }
})

/** A tiny valid zip (stored, one file) so extractZip has real bytes to parse. */
function makeStoredZip(entryName: string, content: string): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8')
  const data = Buffer.from(content, 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0, 8) // method: stored
  local.writeUInt32LE(0, 14) // crc (unchecked by our parser)
  local.writeUInt32LE(data.length, 18) // compressed size
  local.writeUInt32LE(data.length, 22) // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 10) // method
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  // 30 extra / 32 comment / 34 disk-start / 36 int-attrs / 38 ext-attrs / 42 local
  // header offset stay zero (Buffer.alloc). Writing a UInt32 at 44 would exceed
  // the 46-byte fixed header, so we stop here — the fields our parser reads are
  // all set.

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8) // entries this disk
  eocd.writeUInt16LE(1, 10) // total entries
  eocd.writeUInt32LE(central.length, 12) // central size
  eocd.writeUInt32LE(local.length + nameBuf.length + data.length, 16) // central offset

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd])
}

/** A context whose fetchBytes writes `bytes` and extractors record their calls. */
function fakeContext(
  bytes: Buffer,
  calls: { extractZip: string[]; extractAppImage: string[] },
): {
  context: FetchContext
  written: () => Buffer | null
} {
  let written: Buffer | null = null
  const context: FetchContext = {
    fetchBytes: async (_url, filePath) => {
      await Promise.resolve()
      writeFileSync(filePath, bytes)
      written = bytes
      return bytes.length
    },
    extractZip: async (zipPath) => {
      await Promise.resolve()
      calls.extractZip.push(zipPath)
    },
    extractAppImage: async (imagePath) => {
      await Promise.resolve()
      calls.extractAppImage.push(imagePath)
    },
  }
  return { context, written: () => written }
}

describe('ensureFetched', () => {
  it('fetches, verifies size, records TOFU sha256, and renames into place', async () => {
    const asset = KATAGO_MANIFEST.weights
    const bytes = Buffer.alloc(asset.bytes) // size matters; content can be zeros
    const { context } = fakeContext(bytes, { extractZip: [], extractAppImage: [] })

    const result = await ensureFetched(asset, asset.url, dir, context)

    expect(result.reused).toBe(false)
    expect(result.path).toBe(join(dir, outputName(asset)))
    // sha256 was recorded (TOFU), and the file is at the trusted name (no .partial).
    expect(asset.sha256).toBe(result.sha256)
    expect(existsSync(result.path)).toBe(true)
    expect(existsSync(`${result.path}.partial`)).toBe(false)
    expect(readFileSync(result.path).length).toBe(asset.bytes)
  })

  it('reuses a verified existing file without re-fetching', async () => {
    const asset = KATAGO_MANIFEST.weights
    const bytes = Buffer.alloc(asset.bytes)
    const { context } = fakeContext(bytes, { extractZip: [], extractAppImage: [] })
    const first = await ensureFetched(asset, asset.url, dir, context)

    // Second call: fetchBytes would throw if called, proving reuse.
    const throwing: FetchContext = {
      ...context,
      fetchBytes: () => {
        throw new Error('must not re-fetch a verified file')
      },
    }
    const second = await ensureFetched(asset, asset.url, dir, throwing)
    expect(second.reused).toBe(true)
    expect(second.sha256).toBe(first.sha256)
  })

  it('rejects a size mismatch (truncated download) rather than renaming it into place', async () => {
    const asset = KATAGO_MANIFEST.weights
    const short = Buffer.alloc(asset.bytes - 1)
    const { context } = fakeContext(short, { extractZip: [], extractAppImage: [] })

    await expect(ensureFetched(asset, asset.url, dir, context)).rejects.toThrow(
      /Size mismatch/,
    )
    // The partial is left for inspection/resume, never renamed to the trusted name.
    expect(existsSync(join(dir, outputName(asset)))).toBe(false)
  })

  it('rejects when a recorded sha256 does not match (source changed under us)', async () => {
    const asset = KATAGO_MANIFEST.weights
    const bytes = Buffer.alloc(asset.bytes)
    const shaOfZeros = '0'.repeat(64) // wrong on purpose
    asset.sha256 = shaOfZeros
    const { context } = fakeContext(bytes, { extractZip: [], extractAppImage: [] })

    await expect(ensureFetched(asset, asset.url, dir, context)).rejects.toThrow(
      /sha256 mismatch/,
    )
  })

  it('recordObservedSha256 refuses to overwrite a different recorded value', () => {
    const asset: WeightAsset = { ...KATAGO_MANIFEST.weights, sha256: null }
    recordObservedSha256(asset, 'a'.repeat(64))
    expect(() => {
      recordObservedSha256(asset, 'b'.repeat(64))
    }).toThrow(/Refusing to record/)
  })
})

describe('checksum sidecar (TOFU persistence)', () => {
  // The B2 loop, "corrupt the cache, re-run fetch", only bites if the recorded
  // hash survives the process exit. These tests pin the sidecar round-trip;
  // every path is injected into a tmp dir so the real sidecar is never touched.

  it('persists recorded hashes and re-applies them to a null manifest slot', () => {
    const sidecar = join(dir, 'katago-checksums.json')
    KATAGO_MANIFEST.weights.sha256 = 'ab'.repeat(32) // 64 hex chars

    persistRecordedChecksums(sidecar)
    const recorded = readRecordedChecksums(sidecar)

    expect(recorded.weights?.sha256).toBe('ab'.repeat(32))
    // Assets with no recorded hash are simply absent, not null-stubbed.
    expect('fallbackWeights' in recorded).toBe(false)

    // A later run starts from a null slot (fresh manifest read) and verifies.
    KATAGO_MANIFEST.weights.sha256 = null
    applyRecordedChecksums(recorded)
    expect(KATAGO_MANIFEST.weights.sha256).toBe('ab'.repeat(32))
  })

  it('never overwrites a hash pinned in the manifest source', () => {
    KATAGO_MANIFEST.weights.sha256 = 'aa'.repeat(32)
    applyRecordedChecksums({ weights: { sha256: 'bb'.repeat(32) } })
    // The manifest is the reviewed source of truth; the sidecar loses.
    expect(KATAGO_MANIFEST.weights.sha256).toBe('aa'.repeat(32))
  })

  it('reads a missing or malformed sidecar as empty (record mode), never throws', () => {
    expect(readRecordedChecksums(join(dir, 'does-not-exist.json'))).toEqual({})

    const garbage = join(dir, 'garbage.json')
    writeFileSync(garbage, 'this is not json')
    expect(readRecordedChecksums(garbage)).toEqual({})

    const wrongShape = join(dir, 'wrong-shape.json')
    writeFileSync(wrongShape, JSON.stringify({ version: 1, assets: { weights: 42 } }))
    expect(readRecordedChecksums(wrongShape)).toEqual({})

    const badHash = join(dir, 'bad-hash.json')
    writeFileSync(
      badHash,
      JSON.stringify({ version: 1, assets: { weights: { sha256: 'not-a-hash' } } }),
    )
    expect(readRecordedChecksums(badHash)).toEqual({})
  })
})

describe('extractZip', () => {
  it('flattens a stored entry to its basename', async () => {
    const { extractZip } = await import('../fetch-engine')
    const zip = join(dir, 'a.zip')
    writeFileSync(zip, makeStoredZip('pkg/nested/katago.exe', 'MZ-fake'))
    const out = join(dir, 'out')
    rmSync(out, { recursive: true, force: true })
    await extractZip(zip, out)
    expect(readFileSync(join(out, 'katago.exe'), 'utf8')).toBe('MZ-fake')
    // The nested directory name is not preserved — flattening is the point.
    expect(existsSync(join(out, 'pkg'))).toBe(false)
  })

  it('rejects a path-traversal entry rather than writing outside the dir', async () => {
    const { extractZip } = await import('../fetch-engine')
    const zip = join(dir, 'evil.zip')
    writeFileSync(zip, makeStoredZip('../escape.txt', 'x'))
    const out = join(dir, 'out2')
    await extractZip(zip, out)
    // The traversal entry is skipped; nothing is written outside `out2`.
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
  })
})

describe('currentEngineTarget', () => {
  it('returns null on platforms with no official Eigen build (macOS)', () => {
    // This test runs on the dev/CI host; we assert the contract shape, not the
    // host. On win/linux it is a target key; the manifest carries no darwin key.
    const target = currentEngineTarget()
    if (target !== null) {
      expect(Object.keys(KATAGO_MANIFEST.engine.targets)).toContain(target)
    }
    expect(Object.keys(KATAGO_MANIFEST.engine.targets)).not.toContain('darwin-arm64')
    expect(Object.keys(KATAGO_MANIFEST.engine.targets)).not.toContain('darwin-x64')
  })
})

describe('fetchBytes contract (offline)', () => {
  it('rejects when the fetch fails rather than resolving with a partial', async () => {
    // No network: point at a port that refuses. The invariant is that fetchBytes
    // rejects; whether a zero-byte placeholder exists afterwards is an
    // implementation detail, not the contract.
    const dest = join(dir, 'partial.bin')
    await expect(fetchBytes('http://127.0.0.1:1/unreachable', dest)).rejects.toThrow()
  })
})

describe('fetchBytes stall timeout', () => {
  // A connection that delivers a first chunk then goes silent must not hang the
  // fetch until the OS gives up — the whole point of the options-form stall
  // timer. A local server that writes once then never again reproduces the
  // stalled-mid-body condition without touching the network.

  let server: Server | undefined

  afterEach(async () => {
    // Aliased before any closure capture: `server` is `Server | undefined`,
    // and narrowing does not survive into callbacks for a mutable `let` —
    // `srv`'s const type does.
    const srv = server
    server = undefined
    if (srv === undefined) return
    // The test leaves a socket open and silent on purpose, and a bare
    // `server.close()` waits for every such connection to end — hanging the
    // hook. Destroying them first lets `close` finish immediately.
    srv.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      srv.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('rejects when the body stalls past stallTimeoutMs', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200)
      res.write('first-chunk')
      // Never end the response: the socket stays open and silent.
    })
    server = srv
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const address = srv.address()
    if (address === null || typeof address === 'string') {
      throw new Error('server did not bind an ephemeral TCP port')
    }
    const url = `http://127.0.0.1:${String(address.port)}/stall.bin`
    const dest = join(dir, 'stall.bin')

    await expect(fetchBytes(url, dest, { stallTimeoutMs: 100 })).rejects.toThrow(
      /stalled: no bytes for 100ms/,
    )
  })
})

describe('fetchBytes resume against a local server', () => {
  // The resume arithmetic the M1 stub named ("a partial download must not leave
  // a truncated executable") deserves better than an assertion about the code:
  // a real server speaking Range proves the offset is what fetchBytes actually
  // sends and that the appended result is byte-exact.

  const PAYLOAD = Buffer.from('katago-zip-bytes-'.repeat(800)) // ~12.8KB

  let server: Server
  let url = ''
  let seenRanges: (string | undefined)[]

  beforeEach(async () => {
    seenRanges = []
    server = createServer((req, res) => {
      seenRanges.push(req.headers.range)
      const range = req.headers.range
      if (typeof range === 'string' && range.startsWith('bytes=')) {
        const start = Number(range.slice('bytes='.length, -1))
        res.writeHead(206, {
          'content-range': `bytes ${String(start)}-${String(PAYLOAD.length - 1)}/${String(PAYLOAD.length)}`,
        })
        res.end(PAYLOAD.subarray(start))
        return
      }
      res.writeHead(200)
      res.end(PAYLOAD)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('server did not bind an ephemeral TCP port')
    }
    url = `http://127.0.0.1:${String(address.port)}/asset.zip`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('downloads the full body when no partial exists', async () => {
    const dest = join(dir, 'fresh.zip')
    const total = await fetchBytes(url, dest)

    expect(total).toBe(PAYLOAD.length)
    expect(seenRanges.at(-1)).toBeUndefined() // no Range header on a fresh GET
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  })

  it('resumes from the on-disk size and appends byte-exactly', async () => {
    const resumeAt = 1000
    const dest = join(dir, 'resume.zip')
    writeFileSync(dest, PAYLOAD.subarray(0, resumeAt))

    const total = await fetchBytes(url, dest)

    expect(total).toBe(PAYLOAD.length)
    expect(seenRanges.at(-1)).toBe(`bytes=${String(resumeAt)}-`)
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  })

  it('rejects when a server ignores Range and returns 200 mid-resume', async () => {
    // Accepting a 200 here would append the FULL body to the partial, doubling
    // bytes and corrupting the hash — the check must be on the status, and it
    // must reject before writing anything.
    const dest = join(dir, 'no-range-support.zip')
    writeFileSync(dest, PAYLOAD.subarray(0, 10))
    const before = readFileSync(dest)

    // A second server that never honours Range.
    const plain = createServer((req, res) => {
      seenRanges.push(req.headers.range)
      res.writeHead(200)
      res.end(PAYLOAD)
    })
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
    const address = plain.address()
    if (address === null || typeof address === 'string') {
      throw new Error('plain server did not bind')
    }

    await expect(
      fetchBytes(`http://127.0.0.1:${String(address.port)}/asset.zip`, dest),
    ).rejects.toThrow(/HTTP 200/)
    expect(readFileSync(dest).equals(before)).toBe(true) // untouched
    await new Promise<void>((resolve, reject) => {
      plain.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })
})
