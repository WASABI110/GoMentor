import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  BUILD_DIR,
  drawIcon,
  encodeIco,
  encodePng,
  ICO_SIZES,
  PNG_SIZE,
  type Bitmap,
} from '../icon'

/**
 * Gate for the application icon.
 *
 * The defect this exists to prevent is specific and was observed on this repo in the
 * neighbouring `extraResources` case: electron-builder, asked for a resource it cannot
 * find, **says nothing and carries on**. With no `icon:` key and no `build/icon.*`, it
 * silently substitutes the stock Electron icon, the build goes green, and the first
 * person to notice is whoever opens the installer.
 *
 * So this file asserts three separate things, because any one of them alone can pass
 * while the icon is still broken:
 *
 * 1. The **drawing** produces a real picture (not a transparent or flat-filled square).
 * 2. The **encoders** produce structurally valid PNG and ICO.
 * 3. The **artifacts** exist on disk, where the packager's convention says to look.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const BUILDER_YML = join(REPO_ROOT, 'apps', 'desktop', 'electron-builder.yml')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface PngInfo {
  width: number
  height: number
  colourType: number
  pixels: Buffer
}

/** Minimal PNG reader: enough to prove the encoder wrote what it claimed. */
function decodePng(bytes: Buffer): PngInfo {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  // IHDR payload begins after the signature, a 4-byte length, and the 4-byte type.
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const colourType = bytes.readUInt8(25)

  const idat: Buffer[] = []
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
    if (type === 'IEND') break
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    // Filter byte 0 (None) on every scanline, which is what `encodePng` writes.
    expect(raw[y * (stride + 1)]).toBe(0)
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }

  return { width, height, colourType, pixels }
}

function alphaAt(bitmap: Bitmap, x: number, y: number): number {
  return bitmap.data[(y * bitmap.width + x) * 4 + 3] ?? 0
}

describe('the drawing is a picture, not a blank square', () => {
  const size = 256
  const icon = drawIcon(size)

  it('is opaque in the middle and transparent in the corner', () => {
    // The rounded-corner mask is the one part of the drawing that produces alpha at
    // all; if `insideRoundedSquare` ever inverts, this is what says so.
    expect(alphaAt(icon, size / 2, size / 2)).toBe(255)
    expect(alphaAt(icon, 0, 0)).toBe(0)
    expect(alphaAt(icon, size - 1, size - 1)).toBe(0)
  })

  it('contains board, line, and both stone colours', () => {
    const colours = new Set<string>()
    for (let index = 0; index < icon.data.length; index += 4) {
      if ((icon.data[index + 3] ?? 0) < 250) continue
      colours.add(
        `${String(icon.data[index])},${String(icon.data[index + 1])},${String(icon.data[index + 2])}`,
      )
    }

    // A flat fill — the shape a broken `sample()` most plausibly returns — would give
    // one colour. Antialiasing means the true count is in the hundreds; the floor is
    // deliberately far below that so this does not become a brittle exact-match.
    expect(colours.size).toBeGreaterThan(20)

    let dark = 0
    let light = 0
    let board = 0
    for (let index = 0; index < icon.data.length; index += 4) {
      if ((icon.data[index + 3] ?? 0) < 250) continue
      const r = icon.data[index] ?? 0
      const g = icon.data[index + 1] ?? 0
      const b = icon.data[index + 2] ?? 0
      if (r < 60 && g < 60 && b < 60) dark += 1
      else if (r > 235 && g > 235 && b > 230) light += 1
      else if (r > 180 && g > 130 && b > 60 && b < 130) board += 1
    }

    // Each of the three has to be present in quantity: a black stone, a white stone,
    // and the board itself. A drawing that lost the stones would still pass a
    // "colour count" check on the grid lines alone.
    expect(dark).toBeGreaterThan(100)
    expect(light).toBeGreaterThan(100)
    expect(board).toBeGreaterThan(1_000)
  })

  it('is deterministic', () => {
    // The generator is only a legitimate substitute for a committed binary if
    // re-running it produces the same bytes. Any `Math.random` or time dependency
    // sneaking into the drawing shows up here as a diff on every build.
    expect(Buffer.from(drawIcon(64).data).equals(Buffer.from(drawIcon(64).data))).toBe(
      true,
    )
  })
})

describe('the encoders produce valid containers', () => {
  it('round-trips a PNG through an independent decoder', () => {
    const source = drawIcon(32)
    const decoded = decodePng(encodePng(source))

    expect(decoded.width).toBe(32)
    expect(decoded.height).toBe(32)
    expect(decoded.colourType).toBe(6) // RGBA
    // Byte-for-byte: the encoder must not reorder, pad, or drop channels.
    expect(decoded.pixels.equals(Buffer.from(source.data))).toBe(true)
  })

  it('packs every declared size into the ICO with in-range offsets', () => {
    const sizes = [16, 32, 256]
    const ico = encodeIco(sizes.map((size) => drawIcon(size)))

    expect(ico.readUInt16LE(0)).toBe(0) // reserved
    expect(ico.readUInt16LE(2)).toBe(1) // type: icon
    expect(ico.readUInt16LE(4)).toBe(sizes.length)

    for (const [index, size] of sizes.entries()) {
      const entry = 6 + 16 * index
      // 256 is stored as 0 because the field is a single byte. Getting this wrong
      // is how a 256px icon becomes a zero-size entry that Windows ignores.
      expect(ico.readUInt8(entry)).toBe(size >= 256 ? 0 : size)
      expect(ico.readUInt16LE(entry + 6)).toBe(32) // bits per pixel

      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(offset + length).toBeLessThanOrEqual(ico.length)

      // Each payload is itself a PNG of the size the directory entry advertises.
      const payload = ico.subarray(offset, offset + length)
      const decoded = decodePng(Buffer.from(payload))
      expect(decoded.width).toBe(size)
      expect(decoded.height).toBe(size)
    }
  })
})

describe('the artifacts are where the packager looks', () => {
  it('declares buildResources as the directory the generator writes to', () => {
    // Anchored to the packager's own config rather than to the string "build": if
    // someone repoints buildResources, this fails instead of quietly passing while
    // electron-builder reads an empty directory.
    const yml = readFileSync(BUILDER_YML, 'utf8')
    const match = /^\s*buildResources:\s*(\S+)\s*$/m.exec(yml)
    expect(match?.[1]).toBeDefined()
    expect(join(REPO_ROOT, 'apps', 'desktop', match?.[1] ?? '')).toBe(BUILD_DIR)
  })

  it('has an icon.png of at least 512px', () => {
    const path = join(BUILD_DIR, 'icon.png')
    expect(existsSync(path), 'run `pnpm make:icon`').toBe(true)

    const decoded = decodePng(readFileSync(path))
    // electron-builder's own floor for deriving platform icons is 512.
    expect(decoded.width).toBeGreaterThanOrEqual(512)
    expect(decoded.width).toBe(PNG_SIZE)
    expect(decoded.height).toBe(decoded.width)
  })

  it('has an icon.ico containing a 256px image', () => {
    const path = join(BUILD_DIR, 'icon.ico')
    expect(existsSync(path), 'run `pnpm make:icon`').toBe(true)

    const ico = readFileSync(path)
    const count = ico.readUInt16LE(4)
    expect(count).toBe(ICO_SIZES.length)

    const widths = new Set<number>()
    for (let index = 0; index < count; index += 1) {
      const stored = ico.readUInt8(6 + 16 * index)
      widths.add(stored === 0 ? 256 : stored)
    }
    // NSIS requires 256; without it electron-builder falls back to its default.
    expect(widths.has(256)).toBe(true)
    expect(widths.size).toBe(ICO_SIZES.length)
  })

  it('is byte-identical to a fresh generation', () => {
    // Proves the committed artifacts came from the committed code — the property that
    // makes reviewing `scripts/icon.ts` equivalent to reviewing the icon itself. If
    // someone hand-edits the binary, this is what catches it.
    const png = readFileSync(join(BUILD_DIR, 'icon.png'))
    expect(png.equals(encodePng(drawIcon(PNG_SIZE)))).toBe(true)

    const ico = readFileSync(join(BUILD_DIR, 'icon.ico'))
    expect(ico.equals(encodeIco(ICO_SIZES.map((size) => drawIcon(size))))).toBe(true)
  })
})
