/**
 * GTP command names and KataGo's analysis-mode field names, as constants.
 *
 * Why constants rather than inline strings: these are a wire protocol. A typo in
 * `"kata-analyze"` does not fail at compile time, it fails at runtime against a
 * real engine with an unhelpful `? unknown command` — and only on the code path
 * that sends it. Naming them once puts every spelling in one reviewable place.
 *
 * `commands.ts` deliberately holds no logic. `gtp.ts` builds and parses GTP
 * lines; `analysis.ts` handles the JSON protocol.
 */

/** Standard GTP commands. Implemented by every engine, KataGo included. */
export const GTP_COMMANDS = {
  protocolVersion: 'protocol_version',
  name: 'name',
  version: 'version',
  knownCommand: 'known_command',
  listCommands: 'list_commands',
  quit: 'quit',
  boardsize: 'boardsize',
  clearBoard: 'clear_board',
  komi: 'komi',
  play: 'play',
  genmove: 'genmove',
  undo: 'undo',
  showboard: 'showboard',
  finalScore: 'final_score',
} as const

/**
 * KataGo extensions. Not part of GTP, and not present on other engines — code
 * that sends these must have established it is talking to KataGo.
 */
export const KATAGO_COMMANDS = {
  /** Streams analysis for the current position until interrupted. */
  analyze: 'kata-analyze',
  /** Analyses, then plays the chosen move. */
  genmoveAnalyze: 'kata-genmove_analyze',
  rawNn: 'kata-raw-nn',
  setRules: 'kata-set-rules',
  getRules: 'kata-get-rules',
} as const

/**
 * Field names in analysis-mode JSON.
 *
 * KataGo's analysis engine speaks newline-delimited JSON on stdin/stdout, which
 * is a different protocol from GTP — not a variant of it. These are its keys.
 */
export const ANALYSIS_FIELDS = {
  id: 'id',
  moves: 'moves',
  initialStones: 'initialStones',
  rules: 'rules',
  komi: 'komi',
  boardXSize: 'boardXSize',
  boardYSize: 'boardYSize',
  maxVisits: 'maxVisits',
  analyzeTurns: 'analyzeTurns',
  includeOwnership: 'includeOwnership',
  includePolicy: 'includePolicy',
  includeMovesOwnership: 'includeMovesOwnership',
  reportDuringSearchEvery: 'reportDuringSearchEvery',
  overrideSettings: 'overrideSettings',
  action: 'action',
} as const

/**
 * Rulesets KataGo accepts by name.
 *
 * `chinese` is the default this app sends: area scoring matches what
 * `board/rules.ts` computes, so an engine score and our score are comparable.
 * Sending `japanese` while scoring by area would produce a mismatch the user
 * would read as a bug.
 */
export const KATAGO_RULESETS = [
  'tromp-taylor',
  'chinese',
  'japanese',
  'korean',
  'aga',
] as const
export type KataGoRuleset = (typeof KATAGO_RULESETS)[number]

/** GTP's two response prefixes. A line starting with neither is not a response. */
export const GTP_SUCCESS_PREFIX = '='
export const GTP_FAILURE_PREFIX = '?'
