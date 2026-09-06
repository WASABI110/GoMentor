/**
 * Verified, resumable download of the KataGo engine and weights into the
 * `extraResources` directories the packager copies (ADR 0003, E1).
 *
 * ## The contract this must hold (from the M1 stubs' own doc comments)
 *
 * - **Checksum before trust.** This is an executable that will be spawned as a
 *   child process, and a weight file the engine opens. The check belongs here,
 *   not at spawn time. sha256 is recorded TOFU (see katago-manifest.ts): null
 *   means "record on this download", non-null means "verify against it".
 * - **Resume and re-run.** At 6-40MB (engine) and 14MB (net) on a bad
 *   connection, a partial download must not leave a truncated file that passes
 *   an existence check. Downloads land in a `*.partial` file and are renamed
 *   into place only after the hash verifies, so an interrupted run can resume
 *   from the bytes already on disk via an HTTP `Range` request.
 * - **Outside the asar.** The destination is `apps/desktop/resources/{katago,
 *   weights}`, which `electron-builder.yml` copies via `extraResources`. A
 *   future refactor that moves it inside makes the engine unspawnable.
 * - **Fail loudly, never silently.** A zero exit must mean "the resource is
 *   present and verified". Anything else exits non-zero so a caller wiring this
 *   into a pipeline gets a stop, not a build that looks finished (the M1 stub
 *   contract, kept verbatim in behaviour).
 *
 * ## Why hand-rolled zip extraction
 *
 * The engine archive is a zip. Rather than add a dependency (`fflate`) and touch
 * the lockfile for one call, the extractor below parses the zip central directory
 * and inflates each entry with Node's built-in `zlib`. It only supports the
 * subset release archives use (deflate/stored, no encryption, no spanned
 * archives) and throws on anything else — a malformed or unexpected archive is
 * an error, not a guess.
 *
 * ## The Windows spawn caveat that shapes `flatten`
 *
 * Windows loads a spawned exe's dependent DLLs from the application directory,
 * then system dirs, then `PATH` — not relative to some library path the way
 * POSIX loaders search shared objects. KataGo's Windows Eigen build dynamically
 * links the MSVC runtime (`vcruntime140*.dll`/`msvcp140*.dll`), and a clean
 * machine without the VC++ redistributable is a real risk (research
 * `bundled-binary-packaging.md`: KaTrain ships these DLLs next to `katago.exe`).
 * So the fetcher flattens every regular file from the archive into the target
 * directory — engine and any DLLs it needs end up side by side, no installer
 * step and no PATH dependency.
 */

import { execFile } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import {
  assertSize,
  recordObservedSha256,
  type EngineAsset,
  type WeightAsset,
} from './katago-manifest'

const run = promisify(execFile)

/** A manifest entry that names a downloadable file with an expected size. */
export type FetchAsset = EngineAsset | WeightAsset

function assetName(asset: FetchAsset): string {
  return 'file' in asset ? asset.file : asset.name
}

/** The stable name this asset's verified archive is kept as in the destination. */
export function outputName(asset: FetchAsset): string {
  return 'archive' in asset ? asset.archive : asset.name
}

export interface DownloadResult {
  /** Absolute path of the verified, in-place file. */
  readonly path: string
  /** sha256 of the final file (recorded or verified). */
  readonly sha256: string
  /** True when a usable file already existed and no download ran. */
  readonly reused: boolean
}

export interface FetchContext {
  /** Injectable for tests: bytes fetched from `url` into `filePath`, resuming from current size. Returns final size. */
  readonly fetchBytes: (url: string, filePath: string) => Promise<number>
  /** Injectable for tests: extract a zip archive into `intoDir`, flattening regular files. */
  readonly extractZip: (zipPath: string, intoDir: string) => Promise<void>
  /** Injectable for tests: extract a Linux AppImage (self-extracting archive) into `intoDir`. */
  readonly extractAppImage: (imagePath: string, intoDir: string) => Promise<void>
}

const DEFAULT_CONTEXT: FetchContext = {
  fetchBytes,
  extractZip,
  extractAppImage,
}

/**
 * Ensures `asset` is present and verified at `dir`.
 *
 * Resume-then-verify: if the final file already exists we verify it (size +
 * sha256, if recorded) and reuse it; otherwise we fetch to a `.partial` file,
 * verify, then rename into place. The rename is what makes a partial never
 * appear as the real file.
 */
export async function ensureFetched(
  asset: FetchAsset,
  url: string,
  dir: string,
  context: FetchContext = DEFAULT_CONTEXT,
): Promise<DownloadResult> {
  await mkdir(dir, { recursive: true })
  const finalPath = join(dir, outputName(asset))

  if (existsSync(finalPath)) {
    const existing = await sha256Of(finalPath)
    assertSize(asset, await sizeOf(finalPath))
    if (asset.sha256 !== null && existing !== asset.sha256) {
      throw new Error(
        `Existing ${outputName(asset)} at ${finalPath} does not match the recorded sha256 ` +
          `(expected ${asset.sha256}, found ${existing}). Delete it and re-fetch.`,
      )
    }
    if (asset.sha256 === null) recordObservedSha256(asset, existing)
    return { path: finalPath, sha256: existing, reused: true }
  }

  const partialPath = `${finalPath}.partial`
  // A stale .partial from a prior interrupted run resumes rather than restarts.
  await context.fetchBytes(url, partialPath)
  const downloaded = await sha256Of(partialPath)
  assertSize(asset, await sizeOf(partialPath))

  if (asset.sha256 !== null && downloaded !== asset.sha256) {
    // Leave the .partial in place so a re-run can resume/examine, but never
    // rename a mismatched file into the trusted name.
    throw new Error(
      `sha256 mismatch for ${assetName(asset)}: expected ${asset.sha256}, got ${downloaded}. ` +
        `Partial kept at ${partialPath}; investigate the source before re-fetching.`,
    )
  }

  recordObservedSha256(asset, downloaded)
  await rename(partialPath, finalPath)
  return { path: finalPath, sha256: downloaded, reused: false }
}

export interface FetchBytesOptions {
  /**
   * Abort the read when no body chunk arrives within this many milliseconds.
   * Not "complete within" — a slow first chunk on a huge asset is latency, not a
   * stall. Only armed on the options call; the single-argument form
   * (`ensureFetched`) leaves the transfer unbounded so instant/injected
   * transfers never wait.
   */
  readonly stallTimeoutMs?: number
  /** An external abort (caller cancellation), composed with the stall timer. */
  readonly externalSignal?: AbortSignal
}

/**
 * Downloads `url` into `filePath`, resuming from the current on-disk size via a
 * `Range` request when the file already exists. Throws on a non-2xx/206 status
 * or a null body rather than writing a truncated file silently.
 */
export async function fetchBytes(
  url: string,
  filePath: string,
  options?: FetchBytesOptions,
): Promise<number> {
  const { stallTimeoutMs, externalSignal } = options ?? {}
  const current = existsSync(filePath) ? await sizeOf(filePath) : 0
  const headers: Record<string, string> = {}
  if (current > 0) headers['Range'] = `bytes=${String(current)}-`

  // The stall timer is wired to an AbortController rather than racing a
  // `AbortSignal.timeout`: aborting is what makes Node's body iterator throw
  // deterministically (a bare `body.cancel()` against a stalled socket is not
  // guaranteed to end the `for await`). Composed with any caller abort so
  // external cancellation aborts the read the same way.
  const stallController = new AbortController()
  const signals: AbortSignal[] = [stallController.signal]
  if (externalSignal !== undefined) signals.push(externalSignal)
  const signal = AbortSignal.any(signals)

  let response: Response
  try {
    response = await fetch(url, { headers, signal })
  } catch (error) {
    // An abort surfaces as a DOMException AbortError. If the stall timer fired,
    // `stalledError` carries the specific message; otherwise it was an external
    // cancel. Either way give a loud, specific failure rather than a bare abort.
    if (isAbortError(error)) {
      throw new Error(`GET ${url} aborted (resuming from ${String(current)} bytes).`)
    }
    throw error
  }
  const ok = current > 0 ? response.status === 206 : response.ok
  if (!ok || response.body === null) {
    throw new Error(
      `GET ${url} failed: HTTP ${String(response.status)} (resuming from ${String(current)} bytes).`,
    )
  }

  // 'a' so an existing partial is appended to, honouring the Range offset.
  const out: WriteStream = createWriteStream(filePath, { flags: 'a' })
  let total = current
  // Lazily-armed: only an options call passes a bounded timeout, and the timer
  // starts on the first chunk. A first chunk may arrive after far longer than
  // `stallTimeoutMs` (a slow server on a huge asset) — that is latency, not a
  // stall — so the deadline is "no bytes for `stallTimeoutMs`", not "complete
  // within `stallTimeoutMs`".
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  // Set by the stall timer, then thrown either by the post-loop check (if the
  // iterator ended cleanly on abort) or by the catch below (if the abort made
  // the iterator throw first). Either way the caller sees the specific stall
  // message, not the signal's generic "operation was aborted".
  let stalledError: Error | null = null
  // Read at throw time, not inlined: TypeScript narrows `stalledError` to `null`
  // at declaration (the only synchronous assignment is null) and does not see
  // the timer callback's assignment, so `stalledError !== null` in the catch
  // reads to it as an always-false comparison. A read through a function is
  // re-evaluated on each call, which is both lint-clean and the honest value.
  const takeStalledError = (): Error | null => stalledError
  try {
    for await (const chunk of response.body) {
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      const buffer = chunk as Buffer
      if (!out.write(buffer)) {
        // Respect backpressure so a large body does not balloon memory.
        await new Promise<void>((resolve) => out.once('drain', resolve))
      }
      total += buffer.length
      if (stallTimeoutMs !== undefined) {
        stallTimer = setTimeout(() => {
          // Fail loudly: record the reason, then abort the read so the body
          // iterator below throws/ends and the failure surfaces. `unref`'d so
          // a mid-body stall never holds a CLI fetch (or a failed CI job) open
          // while waiting for the timeout.
          stalledError = new Error(
            `GET ${url} stalled: no bytes for ${String(stallTimeoutMs)}ms ` +
              `(resuming from ${String(current)} bytes).`,
          )
          stallController.abort()
        }, stallTimeoutMs)
        if (typeof stallTimer.unref === 'function') stallTimer.unref()
      }
    }
    // Clean completion (no abort): fall through. If the timer fired the
    // iterator ended via the abort and a stall is recorded — throw it.
    const afterLoop = takeStalledError()
    if (afterLoop !== null) throw afterLoop
  } catch (error) {
    // An abort (stall timer or external) surfaces here as an AbortError; swap
    // in the specific reason when it was a stall.
    const fromTimer = takeStalledError()
    if (fromTimer !== null) throw fromTimer
    if (isAbortError(error)) {
      throw new Error(`GET ${url} aborted (resuming from ${String(current)} bytes).`)
    }
    throw error
  } finally {
    if (stallTimer !== undefined) clearTimeout(stallTimer)
    out.end()
  }
  await finished(out)
  return total
}

/**
 * Extracts a zip, flattening every regular file into `intoDir`.
 *
 * Flattening (not preserving the archive's internal directory tree) is the
 * point: the spawnable and its co-located DLLs must sit side by side in one
 * directory (the Windows DLL-load contract above). We ignore the directory part
 * of each entry's name on purpose. Archive-internal paths are engine-controlled,
 * not user content, so there is no user-input zip-slip risk; the traversal
 * sanitiser below is kept as belt-and-braces against a malformed archive.
 *
 * Only the release-archive subset is supported: stored or deflated entries, no
 * encryption, no spanned/multi-disk archives. Anything else throws.
 */
export async function extractZip(zipPath: string, intoDir: string): Promise<void> {
  const buffer = await readFile(zipPath)
  const entries = listZipEntries(buffer)
  await mkdir(intoDir, { recursive: true })
  for (const entry of entries) {
    const base = sanitizeBaseName(entry.name)
    if (base === null) continue
    if (entry.method === 0) {
      await writeEntry(
        intoDir,
        base,
        buffer.subarray(entry.dataStart, entry.dataStart + entry.size),
      )
    } else if (entry.method === 8) {
      await writeEntry(
        intoDir,
        base,
        inflateRawSync(buffer.subarray(entry.dataStart, entry.dataStart + entry.size)),
      )
    } else {
      throw new Error(
        `Unsupported zip compression method ${String(entry.method)} for ${entry.name}.`,
      )
    }
  }
}

interface ZipEntry {
  readonly name: string
  readonly method: number
  readonly size: number
  readonly dataStart: number
}

/** Parses the central directory of a zip buffer into its entries. */
function listZipEntries(buffer: Buffer): ZipEntry[] {
  // End-of-central-directory record signature PK\x05\x06, fixed 22-byte minimum.
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1)
    throw new Error('Not a zip: end-of-central-directory record not found.')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(
        `Malformed zip: central-directory header #${String(i)} signature mismatch.`,
      )
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)

    // The local header repeats name/extra lengths, which may differ from the
    // central directory's (a rare but legal case), so locate the data start via
    // the local header, not by assuming the central sizes.
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Malformed zip: local header for ${name} not found.`)
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen

    entries.push({ name, method, size: compressedSize, dataStart })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function writeEntry(dir: string, base: string, data: Buffer): Promise<void> {
  const handle = await open(join(dir, base), 'w')
  try {
    await handle.write(data)
  } finally {
    await handle.close()
  }
}

/**
 * Extracts a Linux AppImage (a self-extracting archive) into `intoDir` and
 * flattens the payload. The official Linux KataGo build is an AppImage
 * (research `katago-releases.md`); we extract it rather than spawn the AppImage
 * directly, because a bundled AppImage nested inside an AppImage/AppDir has no
 * FUSE in the packaged context and does not run. `--appimage-extract` writes a
 * `squashfs-root/` tree; we flatten its regular files.
 */
export async function extractAppImage(
  imagePath: string,
  intoDir: string,
): Promise<void> {
  const outDir = join(intoDir, '.appimage-extract')
  await mkdir(outDir, { recursive: true })
  // --appimage-extract EXECUTES the image. Our zip writer does not preserve the
  // exec bit (writeEntry opens 'w', leaving 0644), so an extracted AppImage
  // would fail here with EACCES on a real Linux run — grant the bit first.
  await chmod(imagePath, 0o755)
  await run(imagePath, ['--appimage-extract'], {
    cwd: outDir,
    maxBuffer: 16 * 1024 * 1024,
  })
  const root = join(outDir, 'squashfs-root')
  const files = await allRegularFiles(root)
  for (const file of files) {
    const base = sanitizeBaseName(file.slice(root.length + 1))
    if (base === null) continue
    await rename(file, join(intoDir, base))
  }
  // The squashfs tree is an extraction intermediate; leaving it in the target
  // directory would ride into the installer through extraResources.
  await rm(outDir, { recursive: true, force: true })
}

async function allRegularFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await allRegularFiles(full, acc)
    else if (entry.isFile()) acc.push(full)
  }
  return acc
}

/** Strips directories from an archive-internal path, rejecting traversal. */
function sanitizeBaseName(archivePath: string): string | null {
  const normalised = archivePath.replace(/\\/g, '/')
  const parts = normalised.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return null
  return parts.at(-1) ?? null
}

async function sha256Of(path: string): Promise<string> {
  const hash: Hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size
}

function finished(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

/**
 * Whether a fetch rejection is a DOMException AbortError (name is the stable
 * signal; `instanceof DOMException` is realm-dependent and so unreliable here).
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/** The directory the engine binary for `target` is placed under. */
export function engineDir(resourcesRoot: string, target: string): string {
  return join(resourcesRoot, 'katago', target)
}

/** The directory weights are placed under. */
export function weightsDir(resourcesRoot: string): string {
  return join(resourcesRoot, 'weights')
}

/**
 * Grants the exec bit on POSIX, where the extracted engine must be spawnable.
 * A no-op on Windows (the exe needs no bit; chmod there manipulates DOS
 * attributes). This is implement.md's "chmod 755 on POSIX".
 */
export async function makeExecutable(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(path, 0o755)
}
