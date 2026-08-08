import { describe, expect, it } from 'vitest'
import type { AnalysisResult, GameMeta, Locale } from '@gomentor/shared'
import {
  buildSystemPrompt,
  type TeacherContext,
} from '../../../src/llm/prompts/teacher'

/**
 * These tests assert **properties** of the prompt, not its exact wording.
 *
 * Pinning the full string would make every rewording a failure and would tell
 * nobody whether the prompt still forbids fabrication. What matters is: the
 * language is right, every number shown came from the analysis, and absence of
 * analysis is stated rather than left to inference.
 */

const GAME: GameMeta = { boardSize: 19, handicap: 0, komi: 6.5 }

const ANALYSIS: AnalysisResult = {
  queryId: 'q1',
  gameId: 'g1',
  moveNumber: 47,
  player: 'black',
  winrate: 0.553,
  scoreLead: 2.5,
  visits: 1200,
  candidates: [
    {
      coord: { x: 3, y: 15 },
      winrate: 0.56,
      scoreLead: 2.6,
      visits: 800,
      pv: [],
      order: 0,
    },
    {
      coord: { x: 15, y: 3 },
      winrate: 0.54,
      scoreLead: 2.1,
      visits: 300,
      pv: [],
      order: 1,
    },
  ],
  complete: true,
}

const ALL_LOCALES: Locale[] = ['zh-CN', 'en', 'ja', 'ko', 'th', 'vi']

describe('buildSystemPrompt — language selection', () => {
  it('writes a Chinese prompt for zh-CN', () => {
    const prompt = buildSystemPrompt({ locale: 'zh-CN' })
    expect(prompt).toContain('围棋老师')
    expect(prompt).not.toContain('You are a Go')
  })

  it('writes an English prompt for en', () => {
    const prompt = buildSystemPrompt({ locale: 'en' })
    expect(prompt).toContain('You are a Go')
    expect(prompt).not.toContain('围棋老师')
  })

  it('falls back to English, not Chinese, for a deferred locale', () => {
    // zh-CN is the authoring locale, so a naive fallback would hand a Vietnamese
    // user a Chinese prompt. English is the lesser wrong answer.
    const prompt = buildSystemPrompt({ locale: 'vi' })
    expect(prompt).toContain('You are a Go')
    expect(prompt).not.toContain('围棋老师')
  })

  it('names the target language when falling back', () => {
    // The UI is untranslated but the answer should still be in the user's
    // language — that is the whole reason the fallback names it.
    expect(buildSystemPrompt({ locale: 'vi' })).toContain('Vietnamese')
    expect(buildSystemPrompt({ locale: 'ja' })).toContain('Japanese')
    expect(buildSystemPrompt({ locale: 'ko' })).toContain('Korean')
    expect(buildSystemPrompt({ locale: 'th' })).toContain('Thai')
  })

  it('does not add a redundant language instruction for an authored locale', () => {
    // Telling a Chinese prompt to "reply in Simplified Chinese" is noise, and
    // mixing an English meta-instruction into a Chinese prompt weakens it.
    expect(buildSystemPrompt({ locale: 'zh-CN' })).not.toContain('Reply in')
    expect(buildSystemPrompt({ locale: 'en' })).not.toContain('Reply in English')
  })

  it('produces a non-empty prompt for every locale in the schema', () => {
    // localeSchema has six entries but only two are authored. A locale that
    // silently produced an empty system prompt would ship an unguided teacher.
    for (const locale of ALL_LOCALES) {
      const prompt = buildSystemPrompt({ locale })
      expect(prompt.length).toBeGreaterThan(100)
    }
  })
})

describe('buildSystemPrompt — anti-fabrication', () => {
  it('forbids inventing a winrate in both authored locales', () => {
    expect(buildSystemPrompt({ locale: 'en' })).toMatch(/never invent/i)
    expect(buildSystemPrompt({ locale: 'zh-CN' })).toContain('绝不编造')
  })

  it('states explicitly that no analysis is available when the engine is absent', () => {
    // Omitting the analysis silently reads to a model as "it exists, it just was
    // not included", and the observed failure is a confidently invented number.
    const prompt = buildSystemPrompt({ locale: 'en', game: GAME, moveNumber: 47 })
    expect(prompt).toMatch(/none available/i)
    expect(prompt).toMatch(/do not invent/i)
  })

  it('states engine absence in Chinese too', () => {
    const prompt = buildSystemPrompt({ locale: 'zh-CN', game: GAME, moveNumber: 47 })
    expect(prompt).toContain('引擎不可用')
  })

  it('asks for admitted uncertainty rather than a confident guess', () => {
    expect(buildSystemPrompt({ locale: 'en' })).toMatch(/unsure/i)
    expect(buildSystemPrompt({ locale: 'zh-CN' })).toContain('不确定')
  })
})

describe('buildSystemPrompt — position block', () => {
  it('omits the position block entirely when there is no position', () => {
    // An empty "Current position:" heading tells the model a position exists and
    // it failed to read it — which invites a fabricated answer.
    const prompt = buildSystemPrompt({ locale: 'en' })
    expect(prompt).not.toContain('Current position')
  })

  it('includes board size and komi when a game is open', () => {
    const prompt = buildSystemPrompt({ locale: 'en', game: GAME })
    expect(prompt).toContain('Current position')
    expect(prompt).toContain('19x19')
    expect(prompt).toContain('6.5')
  })

  it('omits handicap when there is none', () => {
    // `handicap: 0` is the common case; printing "Handicap: 0" is noise that
    // invites the model to discuss a handicap game.
    expect(buildSystemPrompt({ locale: 'en', game: GAME })).not.toMatch(/handicap/i)
  })

  it('includes handicap when there is one', () => {
    const prompt = buildSystemPrompt({ locale: 'en', game: { ...GAME, handicap: 4 } })
    expect(prompt).toMatch(/handicap/i)
    expect(prompt).toContain('4')
  })

  it('includes the move number and the side to move', () => {
    const prompt = buildSystemPrompt({
      locale: 'en',
      game: GAME,
      moveNumber: 47,
      toMove: 'white',
    })
    expect(prompt).toContain('47')
    expect(prompt).toContain('white')
  })

  it('renders the side to move in Chinese for zh-CN', () => {
    const prompt = buildSystemPrompt({ locale: 'zh-CN', game: GAME, toMove: 'black' })
    expect(prompt).toContain('轮到：黑')
    expect(prompt).not.toContain('black')
  })

  it('shows move number 0 rather than treating it as absent', () => {
    // A falsy check instead of an `undefined` check would drop move 0, which is
    // the opening position — a legitimate thing to ask about.
    const prompt = buildSystemPrompt({ locale: 'en', game: GAME, moveNumber: 0 })
    expect(prompt).toMatch(/move number: 0/i)
  })
})

describe('buildSystemPrompt — analysis quoting', () => {
  const withAnalysis: TeacherContext = {
    locale: 'en',
    game: GAME,
    moveNumber: 47,
    toMove: 'black',
    analysis: ANALYSIS,
  }

  it('quotes the winrate as a percentage with the side named', () => {
    // "55%" with no side is the most misreadable number in a Go UI.
    const prompt = buildSystemPrompt(withAnalysis)
    expect(prompt).toContain('55.3%')
    expect(prompt).toMatch(/55\.3% for black/)
  })

  it('names the leader rather than printing a bare signed score', () => {
    const prompt = buildSystemPrompt(withAnalysis)
    expect(prompt).toMatch(/black by 2\.5/)
  })

  it('names white as the leader when the score lead is negative', () => {
    // scoreLead is positive for black by schema, so a negative value means white
    // leads. Printing "-3.0 for black" would be read backwards by a model.
    const prompt = buildSystemPrompt({
      ...withAnalysis,
      analysis: { ...ANALYSIS, scoreLead: -3 },
    })
    expect(prompt).toMatch(/white by 3\.0/)
    expect(prompt).not.toContain('-3')
  })

  it('includes the visit count so the reading depth is visible', () => {
    expect(buildSystemPrompt(withAnalysis)).toContain('1200')
  })

  it('lists candidate moves in GTP coordinates', () => {
    const prompt = buildSystemPrompt(withAnalysis)
    expect(prompt).toContain('D4')
    expect(prompt).toContain('Q16')
  })

  it('caps the candidate list at three', () => {
    // The whole list can be 30+ entries. Sending all of them buries the signal
    // and burns context on moves the student will never ask about.
    const many = Array.from({ length: 10 }, (_unused, index) => ({
      coord: { x: index, y: 0 },
      winrate: 0.5,
      scoreLead: 0,
      visits: 10,
      pv: [],
      order: index,
    }))
    const prompt = buildSystemPrompt({
      ...withAnalysis,
      analysis: { ...ANALYSIS, candidates: many },
    })
    const listed = prompt
      .split('\n')
      .filter((line) => line.startsWith('- ') && line.includes('visits'))
    expect(listed).toHaveLength(3)
  })

  it('renders a pass candidate as pass, not as a coordinate', () => {
    const prompt = buildSystemPrompt({
      ...withAnalysis,
      analysis: {
        ...ANALYSIS,
        candidates: [
          { coord: null, winrate: 0.5, scoreLead: 0, visits: 10, pv: [], order: 0 },
        ],
      },
    })
    expect(prompt).toMatch(/- pass:/)
  })

  it('marks a mid-search result as provisional', () => {
    // An unlabelled partial invites the model to present a provisional number as
    // settled — the streaming path makes this the common case, not a rare one.
    const prompt = buildSystemPrompt({
      ...withAnalysis,
      analysis: { ...ANALYSIS, complete: false },
    })
    expect(prompt).toMatch(/provisional/i)
  })

  it('does not mark a complete result as provisional', () => {
    expect(buildSystemPrompt(withAnalysis)).not.toMatch(/provisional/i)
  })

  it('marks a mid-search result as provisional in Chinese too', () => {
    const prompt = buildSystemPrompt({
      locale: 'zh-CN',
      game: GAME,
      analysis: { ...ANALYSIS, complete: false },
    })
    expect(prompt).toContain('中间结果')
  })

  it('does not claim analysis is unavailable when it is present', () => {
    expect(buildSystemPrompt(withAnalysis)).not.toMatch(/none available/i)
  })

  it('renders a candidate outside the board as a placeholder, not a real point', () => {
    // A 19x19 coordinate against a 9x9 board. Rendering something plausible
    // would have the model discuss a move that does not exist.
    const prompt = buildSystemPrompt({
      locale: 'en',
      game: { ...GAME, boardSize: 9 },
      analysis: {
        ...ANALYSIS,
        candidates: [
          {
            coord: { x: 15, y: 3 },
            winrate: 0.5,
            scoreLead: 0,
            visits: 10,
            pv: [],
            order: 0,
          },
        ],
      },
    })
    expect(prompt).toContain('- ?:')
    // Scoped to the candidate list: the core instructions name D4 and Q16 as
    // examples of coordinate notation, so a whole-prompt `not.toContain` would
    // fail on that unrelated text.
    const listed = prompt
      .split('\n')
      .filter((line) => line.startsWith('- ') && line.includes('visits'))
    expect(listed).toEqual(['- ?: 50.0%, 10 visits'])
  })

  it('uses the game board size for coordinates, not a hardcoded 19', () => {
    // On 9x9, y=0 is row 9; on 19x19 the same point is row 19. A hardcoded size
    // would silently shift every vertex vertically.
    const prompt = buildSystemPrompt({
      locale: 'en',
      game: { ...GAME, boardSize: 9 },
      analysis: {
        ...ANALYSIS,
        candidates: [
          {
            coord: { x: 3, y: 0 },
            winrate: 0.5,
            scoreLead: 0,
            visits: 10,
            pv: [],
            order: 0,
          },
        ],
      },
    })
    const listed = prompt
      .split('\n')
      .filter((line) => line.startsWith('- ') && line.includes('visits'))
    expect(listed).toEqual(['- D9: 50.0%, 10 visits'])
  })
})

describe('buildSystemPrompt — tool capability', () => {
  it('says nothing about tools when support is unknown', () => {
    // `toolsSupported` is null until probed. Describing tools the model may not
    // have is how a no-tools model ends up emitting tool syntax as prose.
    expect(buildSystemPrompt({ locale: 'en' })).not.toMatch(/tool/i)
  })

  it('says nothing about tools when support was measured as absent', () => {
    expect(buildSystemPrompt({ locale: 'en', toolsAvailable: false })).not.toMatch(
      /tool/i,
    )
  })

  it('mentions tools only when support was measured as present', () => {
    const prompt = buildSystemPrompt({ locale: 'en', toolsAvailable: true })
    expect(prompt).toMatch(/tool/i)
    expect(prompt).toMatch(/prefer calling a tool/i)
  })

  it('mentions tools in Chinese for zh-CN', () => {
    const prompt = buildSystemPrompt({ locale: 'zh-CN', toolsAvailable: true })
    expect(prompt).toContain('调用')
  })
})

describe('buildSystemPrompt — determinism', () => {
  it('returns the same string for the same context', () => {
    // No timestamps, no random ids. A prompt that varies between identical
    // requests cannot be regression-tested and defeats provider-side caching.
    const context: TeacherContext = { locale: 'en', game: GAME, analysis: ANALYSIS }
    expect(buildSystemPrompt(context)).toBe(buildSystemPrompt(context))
  })

  it('does not contain a year, which would betray a clock read', () => {
    const prompt = buildSystemPrompt({ locale: 'en', game: GAME, analysis: ANALYSIS })
    expect(prompt).not.toMatch(/20\d\d-\d\d-\d\d/)
  })
})

describe('buildSystemPrompt — leakage', () => {
  it('does not echo player names or event metadata into the prompt', () => {
    // The prompt is the one string in this layer that reaches a third party.
    // Board size and komi are game facts; names are personal data with no
    // bearing on the advice.
    const prompt = buildSystemPrompt({
      locale: 'en',
      game: {
        ...GAME,
        blackName: 'Zhang Wei',
        whiteName: 'Tanaka Hiroshi',
        event: 'Club League 2026',
        place: 'Shanghai',
      },
    })
    expect(prompt).not.toContain('Zhang Wei')
    expect(prompt).not.toContain('Tanaka Hiroshi')
    expect(prompt).not.toContain('Club League')
    expect(prompt).not.toContain('Shanghai')
  })

  it('does not echo internal ids', () => {
    // gameId and queryId are correlation handles for our own logs. A model has
    // no use for them and they would end up in a provider's request log.
    const prompt = buildSystemPrompt({ locale: 'en', game: GAME, analysis: ANALYSIS })
    expect(prompt).not.toContain('q1')
    expect(prompt).not.toContain('g1')
  })
})
