/**
 * Writes the application icon into `apps/desktop/build/`.
 *
 * Run with `pnpm make:icon`. Idempotent: the drawing in `scripts/icon.ts` is pure
 * arithmetic, so re-running produces byte-identical files and a no-op diff —
 * `scripts/test/icon.test.ts` asserts exactly that, which is what makes reviewing the
 * generator equivalent to reviewing the icon.
 *
 * All constants and pure functions live in `scripts/icon.ts`. This file is only the
 * CLI wrapper, and it deliberately exports nothing: it runs `main()` at import, so
 * anything importable from here would fire that as a side effect.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_DIR, drawIcon, encodeIco, encodePng, ICO_SIZES, PNG_SIZE } from './icon'

function main(): void {
  mkdirSync(BUILD_DIR, { recursive: true })

  const png = join(BUILD_DIR, 'icon.png')
  writeFileSync(png, encodePng(drawIcon(PNG_SIZE)))
  console.log(`wrote ${png} (${String(PNG_SIZE)}×${String(PNG_SIZE)})`)

  const ico = join(BUILD_DIR, 'icon.ico')
  writeFileSync(ico, encodeIco(ICO_SIZES.map((size) => drawIcon(size))))
  console.log(`wrote ${ico} (${ICO_SIZES.join(', ')})`)
}

main()
