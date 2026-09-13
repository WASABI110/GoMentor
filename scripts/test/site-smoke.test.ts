import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The marketing site's build gate (M5 Stage 6). The site is zero-JS by
 * design, bilingual (zh at /, en at /en/), and every page must name the
 * product and link the Releases page — the download story IS the site's
 * purpose. No deployment exists (M5 scope decision 7: local build, no
 * external publish), so this smoke runs against `astro build`'s dist/ during
 * the suite; the build is ~1.5s and cached by the filesystem, which is why
 * it is cheap enough to live in the standing gate rather than a release job.
 *
 * The build runs once per suite via `buildOnce()`: astro is invoked through
 * the workspace package's own script so its cwd is the package (the same
 * cwd-relative trap electron-vite has).
 */

const WEB = join(import.meta.dirname, '..', '..', 'apps', 'web')
const DIST = join(WEB, 'dist')

const PAGES = ['index', 'download', 'docs', 'privacy'] as const
const LOCALE_DIRS = ['', 'en/'] as const

let built = false

function buildOnce(): void {
  if (built || existsSync(join(DIST, 'index.html'))) return
  execFileSync('pnpm', ['build'], { cwd: WEB, stdio: 'pipe', shell: true })
  built = true
}

function pagePaths(): string[] {
  return PAGES.flatMap((page) =>
    LOCALE_DIRS.map((localeDir) => {
      const file = page === 'index' ? 'index.html' : `${page}/index.html`
      return join(DIST, localeDir, file)
    }),
  )
}

describe('the marketing site builds and smokes', () => {
  it('builds every page for both locales', () => {
    buildOnce()
    for (const path of pagePaths()) {
      expect(existsSync(path), `missing built page: ${path}`).toBe(true)
    }
  })

  it('every page names the product and links Releases, with zero script tags', () => {
    buildOnce()
    for (const path of pagePaths()) {
      const html = readFileSync(path, 'utf8')
      expect(html.includes('GoMentor'), `${path} does not name the product`).toBe(true)
      expect(
        html.includes('github.com/WASABI110/GoMentor'),
        `${path} does not link the repository`,
      ).toBe(true)
      // Zero-JS is a privacy and simplicity claim made on the site itself
      // (the privacy page promises no tracking); a script tag would break it.
      expect(
        /<script[ >]/.test(html),
        `${path} carries a script tag — the site claims zero-JS`,
      ).toBe(false)
    }
  })

  it('the en locale is served under /en/ with an English privacy page', () => {
    buildOnce()
    const en = readFileSync(join(DIST, 'en', 'privacy', 'index.html'), 'utf8')
    expect(en).toContain('Telemetry (off by default)')
  })
})
