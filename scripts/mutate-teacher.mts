/**
 * Mutation harness for the teacher prompt layer.
 *
 * Prompt tests are unusually easy to write vacuously: `expect(prompt).toContain(
 * 'tool')` passes on any prompt that happens to include the word anywhere, and a
 * `not.toContain` on a short token can be satisfied by accident. Breaking each
 * decision and requiring a failure is the only way to tell a real assertion from
 * a decorative one.
 *
 * Same validity gate as the katago harness: a mutated run whose test total
 * differs from baseline broke collection, and is reported INVALID rather than
 * counted as caught.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const TARGET = 'packages/core/src/llm/prompts/teacher.ts'

interface Mutation {
  readonly id: string
  readonly what: string
  readonly from: string
  readonly to: string
}

const MUTATIONS: Mutation[] = [
  {
    id: 'T1',
    what: 'fall back to zh-CN instead of en for a deferred locale',
    from: "  const authored: AuthoredLocale = isAuthored(locale) ? locale : 'en'",
    to: "  const authored: AuthoredLocale = isAuthored(locale) ? locale : 'zh-CN'",
  },
  {
    id: 'T2',
    what: 'drop the language instruction for a deferred locale',
    from: '  if (!isAuthored(locale)) {\n    sections.push(`Reply in ${LANGUAGE_NAMES[locale]}.`)\n  }',
    to: '  if (false) {\n    sections.push(`Reply in ${LANGUAGE_NAMES[locale]}.`)\n  }',
  },
  {
    id: 'T3',
    what: 'emit the language instruction for every locale, including authored ones',
    from: '  if (!isAuthored(locale)) {',
    to: '  if (true) {',
  },
  {
    id: 'T4',
    what: 'mention tools whenever the flag is not explicitly false',
    from: '  if (context.toolsAvailable === true) sections.push(TOOLS[authored])',
    to: '  if (context.toolsAvailable !== false) sections.push(TOOLS[authored])',
  },
  {
    id: 'T5',
    what: 'never mention tools, even when support was measured',
    from: '  if (context.toolsAvailable === true) sections.push(TOOLS[authored])',
    to: '  if (false) sections.push(TOOLS[authored])',
  },
  {
    id: 'T6',
    what: 'emit an empty position heading instead of omitting the block',
    from: '  if (lines.length === 0) return null',
    to: '  if (false) return null',
  },
  {
    id: 'T7',
    what: 'stop stating that no engine analysis is available',
    from: '  } else if (lines.length > 0) {',
    to: '  } else if (false) {',
  },
  {
    id: 'T8',
    what: 'treat move number 0 as absent',
    from: '  if (context.moveNumber !== undefined) {',
    to: '  if (context.moveNumber !== undefined && context.moveNumber !== 0) {',
  },
  {
    id: 'T9',
    what: 'print handicap 0 as noise',
    from: '    if (game.handicap > 0) {',
    to: '    if (game.handicap >= 0) {',
  },
  {
    id: 'T10',
    what: 'omit handicap even when there is one',
    from: '    if (game.handicap > 0) {',
    to: '    if (false) {',
  },
  {
    id: 'T11',
    what: 'name the wrong side for the winrate',
    from: "  const side = analysis.player === 'black' ? (zh ? '黑' : 'black') : zh ? '白' : 'white'",
    to: "  const side = analysis.player === 'black' ? (zh ? '白' : 'white') : zh ? '黑' : 'black'",
  },
  {
    id: 'T12',
    what: 'name the wrong leader when the score lead is negative',
    from: "  const leader = analysis.scoreLead >= 0 ? (zh ? '黑' : 'black') : zh ? '白' : 'white'",
    to: "  const leader = analysis.scoreLead >= 0 ? (zh ? '白' : 'white') : zh ? '黑' : 'black'",
  },
  {
    id: 'T13',
    what: 'print a bare signed score instead of naming the leader',
    from: '  const magnitude = Math.abs(analysis.scoreLead).toFixed(1)',
    to: '  const magnitude = analysis.scoreLead.toFixed(1)',
  },
  {
    id: 'T14',
    what: 'drop the visit count, hiding the reading depth',
    from: '      : `Engine winrate: ${percent} for ${side} (${String(analysis.visits)} visits)`,',
    to: '      : `Engine winrate: ${percent} for ${side}`,',
  },
  {
    id: 'T15',
    what: 'stop labelling a mid-search result as provisional',
    from: '  if (!analysis.complete) {',
    to: '  if (false) {',
  },
  {
    id: 'T16',
    what: 'label every result as provisional, including complete ones',
    from: '  if (!analysis.complete) {',
    to: '  if (true) {',
  },
  {
    id: 'T17',
    what: 'send the whole candidate list instead of the top three',
    from: '  const top = analysis.candidates.slice(0, 3)',
    to: '  const top = analysis.candidates',
  },
  {
    id: 'T18',
    what: 'send only the single best candidate',
    from: '  const top = analysis.candidates.slice(0, 3)',
    to: '  const top = analysis.candidates.slice(0, 1)',
  },
  {
    id: 'T19',
    what: 'hardcode board size 19 for candidate coordinates',
    from: '  const size: BoardSize = context.game?.boardSize ?? 19',
    to: '  const size: BoardSize = 19',
  },
  {
    id: 'T20',
    what: 'render a pass candidate as a coordinate rather than the word pass',
    from: "      const vertex =\n        candidate.coord === null\n          ? zh\n            ? '脱先'\n            : 'pass'\n          : safeVertex(candidate.coord, size)",
    to: "      const vertex = candidate.coord === null ? 'A1' : safeVertex(candidate.coord, size)",
  },
  {
    id: 'T21',
    what: 'render an out-of-board coordinate as a plausible real point',
    from: "  } catch {\n    return '?'\n  }",
    to: "  } catch {\n    return 'A1'\n  }",
  },
  {
    id: 'T22',
    what: 'leak player names into the prompt',
    from: '    lines.push(zh ? `贴目：${String(game.komi)}` : `Komi: ${String(game.komi)}`)',
    to: '    lines.push(zh ? `贴目：${String(game.komi)}` : `Komi: ${String(game.komi)}`)\n    if (game.blackName !== undefined) lines.push(`Black: ${game.blackName}`)',
  },
  {
    id: 'T23',
    what: 'leak the internal query id into the prompt',
    from: '  const lines: string[] = []\n\n  // Percent with one decimal',
    to: '  const lines: string[] = [`Query: ${analysis.queryId}`]\n\n  // Percent with one decimal',
  },
  {
    id: 'T24',
    what: 'remove the anti-fabrication rule from the English prompt',
    from: "  '- Never invent a winrate, score, or variation. Use only the analysis given to you.',",
    to: "  '- Use the analysis given to you.',",
  },
  {
    id: 'T25',
    what: 'remove the anti-fabrication rule from the Chinese prompt',
    from: "  '- 绝不编造胜率、目数或变化图。只使用提供给你的分析数据。',",
    to: "  '- 使用提供给你的分析数据。',",
  },
  {
    id: 'T26',
    what: 'remove the admit-uncertainty rule from the English prompt',
    from: "  '- If you are unsure, say so. A confident wrong explanation is worse than an admitted gap.',",
    to: "  '- Answer the question.',",
  },
  {
    id: 'T27',
    what: 'swap the English and Chinese core prompts',
    from: "const CORE: Record<AuthoredLocale, string> = { en: CORE_EN, 'zh-CN': CORE_ZH }",
    to: "const CORE: Record<AuthoredLocale, string> = { en: CORE_ZH, 'zh-CN': CORE_EN }",
  },
  {
    id: 'T28',
    what: 'return an empty prompt for a locale with no authored text',
    from: '  const sections: string[] = [CORE[authored]]',
    to: "  const sections: string[] = [isAuthored(locale) ? CORE[authored] : '']",
  },
  {
    id: 'T29',
    what: 'read the clock, making the prompt non-deterministic',
    from: '  const sections: string[] = [CORE[authored]]',
    to: '  const sections: string[] = [CORE[authored], new Date().toISOString().slice(0, 10)]',
  },
  {
    id: 'T30',
    what: 'render the side to move in English inside a Chinese prompt',
    from: "    const side = zh ? (context.toMove === 'black' ? '黑' : '白') : context.toMove",
    to: '    const side = context.toMove',
  },
  {
    id: 'T31',
    what: 'drop the do-not-invent warning from the no-analysis branch',
    from: "        ? '引擎分析：无（引擎不可用）。不要编造胜率或目数。'\n        : 'Engine analysis: none available. Do not invent a winrate or score.',",
    to: "        ? '引擎分析：无。'\n        : 'Engine analysis: none available.',",
  },
  {
    id: 'T32',
    what: 'round the winrate to a whole percent, losing the decimal',
    from: '  const percent = `${(analysis.winrate * 100).toFixed(1)}%`',
    to: '  const percent = `${String(Math.round(analysis.winrate * 100))}%`',
  },
]

function run(): { total: number; failed: number; ok: boolean } {
  try {
    const out = execFileSync(
      'pnpm',
      ['vitest', 'run', '--project', 'core', 'test/llm/prompts', '--reporter', 'basic'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true },
    )
    return parse(out, true)
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string }
    return parse((shaped.stdout ?? '') + (shaped.stderr ?? ''), false)
  }
}

function parse(
  output: string,
  ok: boolean,
): { total: number; failed: number; ok: boolean } {
  const clean = output.replace(ANSI, '')
  const match =
    /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?\s+\((\d+)\)/.exec(
      clean,
    )
  if (match === null) return { total: 0, failed: 0, ok }
  return { total: Number(match[4]), failed: Number(match[1] ?? 0), ok }
}

const baseline = run()
console.log(
  `baseline: ${String(baseline.total)} tests, ${String(baseline.failed)} failed`,
)
if (!baseline.ok || baseline.failed > 0) {
  console.log('BASELINE IS NOT GREEN — aborting, every result would be meaningless')
  process.exit(1)
}

const path = resolve(ROOT, TARGET)
const results: string[] = []

for (const mutation of MUTATIONS) {
  const original = readFileSync(path, 'utf8')
  const occurrences = original.split(mutation.from).length - 1
  if (occurrences !== 1) {
    results.push(
      `${mutation.id}  ANCHOR NOT UNIQUE (${String(occurrences)} matches)  ${mutation.what}`,
    )
    console.log(results[results.length - 1])
    continue
  }

  writeFileSync(path, original.replace(mutation.from, mutation.to), 'utf8')
  try {
    const result = run()
    if (result.total !== baseline.total) {
      results.push(
        `${mutation.id}  INVALID (${String(result.total)} tests vs ${String(baseline.total)})  ${mutation.what}`,
      )
    } else if (result.failed > 0) {
      results.push(
        `${mutation.id}  caught (${String(result.failed)} failed)  ${mutation.what}`,
      )
    } else {
      results.push(`${mutation.id}  *** ESCAPED ***  ${mutation.what}`)
    }
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  console.log(results[results.length - 1])
}

console.log('\n===== SUMMARY =====')
for (const line of results) console.log(line)
const escaped = results.filter((line) => line.includes('ESCAPED')).length
const invalid = results.filter(
  (line) => line.includes('INVALID') || line.includes('ANCHOR'),
).length
console.log(
  `\n${String(results.length - escaped - invalid)}/${String(results.length)} caught, ${String(escaped)} escaped, ${String(invalid)} invalid`,
)
