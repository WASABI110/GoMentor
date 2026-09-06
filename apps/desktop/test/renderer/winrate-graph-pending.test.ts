import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The pending region's hatch pattern — pinned as a cross-file contract.
 *
 * ## What this guards, and why it is a source test
 *
 * The unanalysed span of the winrate graph must render as a hatch, never as a
 * solid fill: a 50%-coloured flatline reads as a real even game, and "we
 * don't know yet" is not a result (`design.md` §Board overlays). The hatch is
 * produced by two mechanisms that must agree with each other and that no
 * typechecker connects:
 *
 * 1. `WinrateGraph.tsx` defines an SVG `<pattern>` under
 *    `PENDING_HATCH_PATTERN_ID` and paints the pending `<rect>` with the
 *    class `winrate-graph__pending`;
 * 2. `global.css` fills that class with `url('#<that id>')`.
 *
 * A regression — someone "simplifying" the CSS to a solid colour, or renaming
 * the id on one side only — renders every pending region as a flat surface
 * and no runtime assertion in this repo notices (there is no jsdom here; the
 * e2e suite asserts the region's existence, not its fill). So this test
 * reads both sources and asserts the linkage, the same way the CI gate
 * greps `out/preload/index.js` for `require("electron")`: a text-scraping
 * gate where the thing under test is itself a string contract. A solid-fill
 * regression fails rule (2)'s `url('#…')` assertion below.
 *
 * ## Why not render the component
 *
 * The desktop vitest project runs in a node environment with no DOM and no
 * component-rendering precedent (`test/renderer/` holds store tests only);
 * `renderToStaticMarkup` here would need a JSX transform configuration that
 * exists nowhere else in the project, for one assertion. The contract this
 * pins lives in source text either way — the fill and the pattern id ARE
 * strings, and their disagreement is the defect.
 */

const COMPONENT_PATH = join(
  import.meta.dirname,
  '../../src/renderer/src/components/WinrateGraph.tsx',
)
const STYLES_PATH = join(
  import.meta.dirname,
  '../../src/renderer/src/styles/global.css',
)

const component = readFileSync(COMPONENT_PATH, 'utf8')
const styles = readFileSync(STYLES_PATH, 'utf8')

/** `const PENDING_HATCH_PATTERN_ID = '…'` — the component's own declaration. */
const patternId = /const PENDING_HATCH_PATTERN_ID = '([^']+)'/.exec(component)?.[1]

describe('the winrate graph pending region renders through the hatch pattern', () => {
  it('declares the pattern id exactly once, as a stable literal', () => {
    expect(patternId).toBeDefined()
    // The CSS side references the id inside a url('#…'); a pattern id that is
    // not a plain literal (or is absent) breaks that reference silently.
    expect(patternId).toBe('winrate-graph-pending-hatch')
  })

  it('defines the <pattern> the id names and paints the pending rect with the class', () => {
    // The defs exist and are keyed by the same constant the CSS expects.
    expect(component).toContain('<pattern')
    expect(component).toContain('id={PENDING_HATCH_PATTERN_ID}')
    // The pending rect is the element the CSS rule targets.
    expect(component).toContain('className="winrate-graph__pending"')
  })

  it("fills .winrate-graph__pending with the pattern's url, never a solid colour", () => {
    const rule = /\.winrate-graph__pending\s*\{([^}]*)\}/.exec(styles)
    expect(rule, 'the .winrate-graph__pending rule exists in global.css').not.toBeNull()
    const body = rule?.[1] ?? ''
    // The load-bearing assertion: the fill must be a pattern reference. A
    // solid-fill "simplification" (e.g. `fill: var(--surface-hover)`) fails
    // here — which is the whole point of this test.
    expect(body).toContain(`fill: url('#${patternId ?? ''}')`)
  })

  it('styles the hatch’s own base and stripe (the pattern is not a bare outline)', () => {
    // The pattern's internals are class-driven too; a dropped rule would
    // leave the pattern invisible and the region blank rather than hatched —
    // a subtler failure than a solid fill, caught by the same linkage check.
    expect(styles).toMatch(/\.winrate-graph__pending-base\s*\{/)
    expect(styles).toMatch(/\.winrate-graph__pending-stripe\s*\{/)
  })
})
