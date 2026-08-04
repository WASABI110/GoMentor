// @gomentor/core — pure domain logic. Electron-free by design so it stays
// testable under plain Node and reusable by apps/web.
//
// Stage 3 fills in sgf/, board/, katago/ (protocol only, no processes), and
// llm/. A lint rule bars `electron` imports from this package.

export const CORE_PACKAGE_VERSION = '0.1.0'
