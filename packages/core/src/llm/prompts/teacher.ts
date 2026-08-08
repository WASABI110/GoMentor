import type {
  AnalysisResult,
  BoardSize,
  Coord,
  GameMeta,
  Locale,
  Player,
} from '@gomentor/shared'
import { toGtp } from '../../board/coords'

/**
 * System-prompt composition for the AI teacher.
 *
 * Pure string building. No provider, no network, no I/O — which is what lets the
 * wording be unit-tested rather than eyeballed against a live model.
 *
 * Three decisions shape this module:
 *
 * 1. **The prompt is data, not a template string at the call site.** A prompt
 *    assembled inline is a prompt nobody can diff. Composing it here means a
 *    change in how the teacher is instructed shows up as a reviewable change.
 *
 * 2. **Locale is a parameter, not an ambient global.** `zh-CN` is the authoring
 *    locale (R10) and `en` is complete; ja/ko/th/vi are in `localeSchema` but
 *    deferred to M5. An unwritten locale falls back to `en` with the target
 *    language still named in the instruction, so the teacher answers in the
 *    user's language even before the UI is translated. Returning a `zh-CN`
 *    prompt for a Vietnamese user would be worse than an English one.
 *
 * 3. **Analysis is quoted, never interpreted.** Every number in the prompt comes
 *    from KataGo via `AnalysisResult`. The LLM is told to explain the numbers and
 *    forbidden to invent them, because a teacher that fabricates a winrate is
 *    actively harmful to a learner (`prd.md`: "LLM answer quality is the
 *    product"). Judging *how bad* a move was is `profile/weakness`'s job — pure
 *    and testable — not the model's.
 *
 * Nothing here may be logged. Prompts can carry pasted game context, and
 * `logging-guidelines.md` puts prompts in the same class as chat text and SGF.
 */

/** Locales with hand-written teacher instructions. Others fall back. */
const AUTHORED_LOCALES = ['zh-CN', 'en'] as const
type AuthoredLocale = (typeof AUTHORED_LOCALES)[number]

/**
 * Language names in English, for the fallback instruction.
 *
 * In English on purpose: the fallback prompt body is English, and asking in
 * English to "reply in Vietnamese" is more reliable than mixing scripts inside
 * one instruction.
 */
const LANGUAGE_NAMES: Record<Locale, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  th: 'Thai',
  vi: 'Vietnamese',
}

function isAuthored(locale: Locale): locale is AuthoredLocale {
  return (AUTHORED_LOCALES as readonly Locale[]).includes(locale)
}

/** What the teacher can see about the position being discussed. */
export interface TeacherContext {
  readonly locale: Locale
  /** Absent when the user is asking a general question with no game open. */
  readonly game?: GameMeta
  readonly moveNumber?: number
  readonly toMove?: Player
  /**
   * KataGo's read on the position. Absent when the engine is unavailable — a
   * normal state, not an error (`engineStatusSchema`), and the teacher must
   * still be useful without it.
   */
  readonly analysis?: AnalysisResult
  /**
   * False when the provider has no measured tool support. The prompt then omits
   * any mention of tools rather than describing capabilities the model does not
   * have — `error-handling.md`: capability gaps degrade, they don't throw.
   */
  readonly toolsAvailable?: boolean
}

const CORE_EN = [
  'You are a Go (baduk) teacher helping a student review their own games.',
  '',
  'Rules you must follow:',
  '- Explain reasoning, do not just name a move. The student wants to understand why.',
  '- Never invent a winrate, score, or variation. Use only the analysis given to you.',
  '- If no engine analysis is provided, say what you can from shape and direction alone, and say plainly that you have no engine reading for this position.',
  '- If you are unsure, say so. A confident wrong explanation is worse than an admitted gap.',
  '- Refer to points in standard coordinates (for example D4, Q16).',
  '- Be concise. Two or three short paragraphs unless the student asks for more.',
].join('\n')

const CORE_ZH = [
  '你是一位围棋老师，帮助学生复盘自己的对局。',
  '',
  '必须遵守：',
  '- 解释理由，不要只报一个着点。学生想弄懂为什么。',
  '- 绝不编造胜率、目数或变化图。只使用提供给你的分析数据。',
  '- 如果没有引擎分析，就只依据棋形和方向来讲，并明确说明本局面没有引擎读秒。',
  '- 不确定就说不确定。一个自信的错误解释比承认盲区更糟。',
  '- 用标准坐标指位置（例如 D4、Q16）。',
  '- 简洁。除非学生要求展开，两三个短段落即可。',
].join('\n')

const CORE: Record<AuthoredLocale, string> = { en: CORE_EN, 'zh-CN': CORE_ZH }

const TOOLS_EN =
  'You may call the provided tools to look up analysis or reference material. Prefer calling a tool over guessing.'
const TOOLS_ZH = '你可以调用提供的工具来查询分析或参考资料。宁可调用工具，也不要猜。'

const TOOLS: Record<AuthoredLocale, string> = { en: TOOLS_EN, 'zh-CN': TOOLS_ZH }

/**
 * Builds the system prompt.
 *
 * Deterministic: same context in, same string out. No timestamps, no random ids
 * — a prompt that varies between identical requests cannot be regression-tested
 * and defeats provider-side caching.
 */
export function buildSystemPrompt(context: TeacherContext): string {
  const locale = context.locale
  const authored: AuthoredLocale = isAuthored(locale) ? locale : 'en'

  const sections: string[] = [CORE[authored]]

  // The language instruction is emitted only for a locale we have no prompt for.
  // Telling a zh-CN reader "reply in Simplified Chinese" inside an already-Chinese
  // prompt is noise; telling a Vietnamese reader is the whole point.
  if (!isAuthored(locale)) {
    sections.push(`Reply in ${LANGUAGE_NAMES[locale]}.`)
  }

  if (context.toolsAvailable === true) sections.push(TOOLS[authored])

  const position = describePosition(context, authored)
  if (position !== null) sections.push(position)

  return sections.join('\n\n')
}

/**
 * Renders the position as a labelled block, or `null` when there is nothing to
 * say.
 *
 * `null` rather than an empty section: an empty "Position:" heading tells the
 * model a position exists and it failed to read it, which invites a fabricated
 * answer. Absence has to be absent.
 */
function describePosition(
  context: TeacherContext,
  locale: AuthoredLocale,
): string | null {
  const lines: string[] = []
  const zh = locale === 'zh-CN'

  if (context.game !== undefined) {
    const game = context.game
    lines.push(
      zh
        ? `棋盘：${String(game.boardSize)} 路`
        : `Board: ${String(game.boardSize)}x${String(game.boardSize)}`,
    )
    lines.push(zh ? `贴目：${String(game.komi)}` : `Komi: ${String(game.komi)}`)
    if (game.handicap > 0) {
      lines.push(
        zh ? `让子：${String(game.handicap)}` : `Handicap: ${String(game.handicap)}`,
      )
    }
  }

  if (context.moveNumber !== undefined) {
    lines.push(
      zh
        ? `手数：第 ${String(context.moveNumber)} 手`
        : `Move number: ${String(context.moveNumber)}`,
    )
  }
  if (context.toMove !== undefined) {
    const side = zh ? (context.toMove === 'black' ? '黑' : '白') : context.toMove
    lines.push(zh ? `轮到：${side}` : `To move: ${side}`)
  }

  if (context.analysis !== undefined) {
    lines.push(...describeAnalysis(context.analysis, context, zh))
  } else if (lines.length > 0) {
    // Stated explicitly rather than left to inference. A prompt that simply omits
    // analysis reads to the model as "analysis exists, it just wasn't included",
    // and the observed failure mode is a confidently invented winrate.
    lines.push(
      zh
        ? '引擎分析：无（引擎不可用）。不要编造胜率或目数。'
        : 'Engine analysis: none available. Do not invent a winrate or score.',
    )
  }

  if (lines.length === 0) return null
  return (zh ? '当前局面：\n' : 'Current position:\n') + lines.join('\n')
}

function describeAnalysis(
  analysis: AnalysisResult,
  context: TeacherContext,
  zh: boolean,
): string[] {
  // `BoardSize`, not `number`: threading the literal union through means
  // `safeVertex` needs no cast, and a cast is how a wrong board size would get
  // past the compiler in the first place.
  const size: BoardSize = context.game?.boardSize ?? 19
  const lines: string[] = []

  // Percent with one decimal, and always from the perspective the result names.
  // "55%" without a side is the single most misreadable number in a Go UI.
  const side = analysis.player === 'black' ? (zh ? '黑' : 'black') : zh ? '白' : 'white'
  const percent = `${(analysis.winrate * 100).toFixed(1)}%`
  lines.push(
    zh
      ? `引擎胜率：${side}方 ${percent}（${String(analysis.visits)} 次模拟）`
      : `Engine winrate: ${percent} for ${side} (${String(analysis.visits)} visits)`,
  )

  // Signed and with the leader named. `scoreLead` is positive for black by
  // schema, and a bare "+2.5" is ambiguous to a reader and to a model.
  const leader = analysis.scoreLead >= 0 ? (zh ? '黑' : 'black') : zh ? '白' : 'white'
  const magnitude = Math.abs(analysis.scoreLead).toFixed(1)
  lines.push(
    zh
      ? `引擎目数：${leader}方领先 ${magnitude} 目`
      : `Engine score lead: ${leader} by ${magnitude} points`,
  )

  // Partial results are labelled. An unlabelled mid-search winrate invites the
  // model to present a provisional number as settled.
  if (!analysis.complete) {
    lines.push(
      zh
        ? '（分析仍在进行，以上为中间结果。）'
        : '(Search still running; the numbers above are provisional.)',
    )
  }

  const top = analysis.candidates.slice(0, 3)
  if (top.length > 0) {
    lines.push(zh ? '引擎推荐：' : 'Engine top choices:')
    for (const candidate of top) {
      const vertex =
        candidate.coord === null
          ? zh
            ? '脱先'
            : 'pass'
          : safeVertex(candidate.coord, size)
      const candidatePercent = `${(candidate.winrate * 100).toFixed(1)}%`
      lines.push(
        zh
          ? `- ${vertex}：胜率 ${candidatePercent}，${String(candidate.visits)} 次模拟`
          : `- ${vertex}: ${candidatePercent}, ${String(candidate.visits)} visits`,
      )
    }
  }

  return lines
}

/**
 * A coordinate as GTP, or a placeholder.
 *
 * `toGtp` throws a `CoordError` for a coordinate outside the board. In a prompt
 * that is not worth failing the whole request over — but it must not silently
 * render as a real point either, because the model would then discuss a move
 * that does not exist. `?` is deliberately not a legal vertex.
 */
function safeVertex(coord: Coord, size: BoardSize): string {
  try {
    return toGtp(coord, size)
  } catch {
    return '?'
  }
}
