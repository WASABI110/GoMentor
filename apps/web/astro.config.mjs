import { defineConfig } from 'astro/config'

// Static output, default `dist/`. No integrations: the site is deliberately
// zero-JS (the download cards are static links to GitHub Releases), which is
// what keeps it buildable offline and servable from any static file server —
// the M5 scope decision is local build, no deployment (prd.md decision 7).
export default defineConfig({
  // zh-CN is the authoring locale at `/`; en mirrors it at `/en/`. Two routes,
  // no i18n library — the content is small enough that duplicating the page
  // components with a locale prop is simpler than any abstraction.
  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['zh-CN', 'en'],
    routing: { prefixDefaultLocale: false },
  },
})
