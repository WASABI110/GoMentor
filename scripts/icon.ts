/**
 * Generates the GoMentor application icon from code.
 *
 * ## Why a generator and not a checked-in blob
 *
 * A `.ico` in git is an opaque binary: nobody can review a change to it, nobody can
 * tell whether it matches the brand, and regenerating it at a new size means finding
 * whichever design tool made it. The drawing here is ~100 lines of arithmetic that
 * any reviewer can read, and every size the packager wants is derived from the same
 * source. `pnpm make:icon` is idempotent — same input, same bytes out.
 *
 * ## Why hand-rolled encoders
 *
 * PNG and ICO are both simple container formats, and `node:zlib` already does the
 * only hard part (DEFLATE). Adding `sharp`/`jimp`/`png-to-ico` would mean a native
 * build step and a supply-chain surface for something this project does exactly once
 * per release. See `docs/architecture.md` on dependency posture.
 *
 * ## What the packager actually reads
 *
 * `electron-builder.yml` sets `directories.buildResources: build` and specifies no
 * `icon:` key, so electron-builder looks for `build/icon.png` and `build/icon.ico` by
 * convention. When neither exists it falls back to the stock Electron icon **without
 * warning** — the same silent-fallback class of defect as the `extraResources`
 * directories that were declared and never copied. `scripts/test/icon.test.ts` is the
 * gate that keeps that from being invisible again.
 */

import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const REPO_ROOT = resolve(import.meta.dirname, '..')

/**
 * Where the packager looks. `electron-builder.yml` sets `directories.buildResources`
 * to this directory and names no `icon:` key, so the filenames below are convention,
 * not configuration.
 *
 * These live here rather than in `make-icon.ts` on purpose: that file runs its `main()`
 * at import, so a test importing a constant from it would generate icons as a side
 * effect of collection. This repo has already been bitten by exactly that shape — a
 * Playwright spec created temp profiles during `--list`, before any hook could run.
 */
export const BUILD_DIR = join(REPO_ROOT, 'apps', 'desktop', 'build')
/** electron-builder wants ≥512 for the source PNG; 1024 covers macOS retina. */
export const PNG_SIZE = 1024

/** Straight (non-premultiplied) RGBA, row-major, 4 bytes per pixel. */
export interface Bitmap {
  width: number
  height: number
  data: Uint8Array
}

type Rgb = readonly [number, number, number]

/** Kaya-board warm tan; the one colour a Go player recognises instantly. */
const BOARD: Rgb = [205, 156, 88]
/** Grid and star points: dark umber, not black, so stones stay dominant. */
const LINES: Rgb = [74, 48, 26]
const BLACK_STONE: Rgb = [26, 26, 30]
const WHITE_STONE: Rgb = [246, 245, 241]

/** 9×9, because a 19×19 grid turns to mush below 48px. */
const GRID = 9
/** Star points on a 9×9 board, as 0-indexed grid coordinates. */
const STARS: readonly (readonly [number, number])[] = [
  [2, 2],
  [6, 2],
  [4, 4],
  [2, 6],
  [6, 6],
]
/** One stone of each colour, on opposite star points. */
const STONES: readonly { at: readonly [number, number]; colour: Rgb }[] = [
  { at: [2, 6], colour: BLACK_STONE },
  { at: [6, 2], colour: WHITE_STONE },
]

/**
 * Supersampling factor. Antialiasing comes from rendering at `SS`× and box-filtering
 * down, rather than from per-shape coverage maths — the grid lines at 32px are thin
 * enough that getting this wrong is immediately visible, and 3× is where the stone
 * edges stop looking ragged.
 */
const SS = 3

function insideRoundedSquare(
  x: number,
  y: number,
  size: number,
  radius: number,
): boolean {
  const nearLeft = x < radius
  const nearRight = x > size - radius
  const nearTop = y < radius
  const nearBottom = y > size - radius
  if (!((nearLeft || nearRight) && (nearTop || nearBottom))) {
    return x >= 0 && x <= size && y >= 0 && y <= size
  }
  const cx = nearLeft ? radius : size - radius
  const cy = nearTop ? radius : size - radius
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

/** Colour of one supersample, or `null` for transparent. */
function sample(x: number, y: number, size: number): Rgb | null {
  const radius = size * 0.185
  if (!insideRoundedSquare(x, y, size, radius)) return null

  const margin = size * 0.15
  const cell = (size - 2 * margin) / (GRID - 1)
  const at = (index: number): number => margin + index * cell

  // Stones first: they occlude everything under them.
  const stoneRadius = cell * 0.47
  for (const stone of STONES) {
    const dx = x - at(stone.at[0])
    const dy = y - at(stone.at[1])
    const distance = Math.hypot(dx, dy)
    if (distance > stoneRadius) continue
    // A gentle top-left highlight so the stones read as spheres, not discs. Kept
    // subtle because it is the first thing to look wrong at 16px.
    const lift = (-(dx + dy) / (stoneRadius * 2)) * 0.18
    const shade = 1 + lift
    return [
      Math.max(0, Math.min(255, stone.colour[0] * shade)),
      Math.max(0, Math.min(255, stone.colour[1] * shade)),
      Math.max(0, Math.min(255, stone.colour[2] * shade)),
    ]
  }

  const half = Math.max(size * 0.0045, 0.45)
  const starRadius = size * 0.014
  const first = at(0)
  const last = at(GRID - 1)
  const onBoard =
    x >= first - half && x <= last + half && y >= first - half && y <= last + half

  if (onBoard) {
    for (const star of STARS) {
      if (Math.hypot(x - at(star[0]), y - at(star[1])) <= starRadius) return LINES
    }
    for (let index = 0; index < GRID; index += 1) {
      if (Math.abs(x - at(index)) <= half) return LINES
      if (Math.abs(y - at(index)) <= half) return LINES
    }
  }

  return BOARD
}

/** Renders the icon at `size`×`size`. */
export function drawIcon(size: number): Bitmap {
  const data = new Uint8Array(size * size * 4)
  const samples = SS * SS

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const colour = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, size)
          if (colour === null) continue
          covered += 1
          r += colour[0]
          g += colour[1]
          b += colour[2]
        }
      }

      const offset = (py * size + px) * 4
      if (covered === 0) continue
      // Averaged over *covered* samples, not all of them: dividing by `samples`
      // would darken every edge pixel toward black, which is the classic
      // premultiplied-alpha halo.
      data[offset] = Math.round(r / covered)
      data[offset + 1] = Math.round(g / covered)
      data[offset + 2] = Math.round(b / covered)
      data[offset + 3] = Math.round((covered / samples) * 255)
    }
  }

  return { width: size, height: size, data }
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    // Indexed with a byte-masked value, so the entry is always defined; the `?? 0`
    // is for the compiler, which cannot know that.
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Encodes a bitmap as a non-interlaced 8-bit RGBA PNG. */
export function encodePng(bitmap: Bitmap): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(bitmap.width, 0)
  header.writeUInt32BE(bitmap.height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(6, 9) // colour type: truecolour with alpha
  header.writeUInt8(0, 10) // compression: DEFLATE
  header.writeUInt8(0, 11) // filter method
  header.writeUInt8(0, 12) // no interlace

  const stride = bitmap.width * 4
  // Every scanline carries a leading filter-type byte. Filter 0 (None) keeps this
  // readable; DEFLATE recovers most of what a smarter filter would.
  const raw = Buffer.alloc((stride + 1) * bitmap.height)
  for (let y = 0; y < bitmap.height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(bitmap.data.subarray(y * stride, (y + 1) * stride)).copy(
      raw,
      y * (stride + 1) + 1,
    )
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** The sizes Windows asks for, smallest to largest. 256 is what NSIS requires. */
export const ICO_SIZES: readonly number[] = [16, 24, 32, 48, 64, 128, 256]

/**
 * Packs PNG payloads into a Windows `.ico`.
 *
 * PNG-in-ICO (rather than BMP-in-ICO) is supported from Vista on, which is far below
 * this app's floor, and avoids hand-writing a bottom-up BMP with an AND mask.
 */
export function encodeIco(images: readonly Bitmap[]): Buffer {
  const payloads = images.map((image) => encodePng(image))

  const directory = Buffer.alloc(6)
  directory.writeUInt16LE(0, 0) // reserved
  directory.writeUInt16LE(1, 2) // type: icon
  directory.writeUInt16LE(images.length, 4)

  let offset = 6 + 16 * images.length
  const entries: Buffer[] = []

  for (const [index, image] of images.entries()) {
    const payload = payloads[index]
    if (payload === undefined) continue
    const entry = Buffer.alloc(16)
    // 256 is stored as 0: the field is one byte and 256 does not fit. This is the
    // detail that silently truncates a 256px icon to nothing.
    entry.writeUInt8(image.width >= 256 ? 0 : image.width, 0)
    entry.writeUInt8(image.height >= 256 ? 0 : image.height, 1)
    entry.writeUInt8(0, 2) // palette size: not paletted
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(payload.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += payload.length
    entries.push(entry)
  }

  return Buffer.concat([directory, ...entries, ...payloads])
}
