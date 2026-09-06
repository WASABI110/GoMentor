import { z } from 'zod'
import { gameSchema, gameSummarySchema } from './types/game'
import {
  analysisResultSchema,
  engineGameSchema,
  engineInfoSchema,
} from './types/analysis'
import { chatChunkSchema, chatContextSchema, chatMessageSchema } from './types/chat'
import { secretKeySchema, settingsPatchSchema, settingsSchema } from './types/settings'
import { errorEnvelopeSchema } from './types/errors'

/**
 * THE IPC contract. Single source of truth for every channel name and payload
 * shape in the app.
 *
 * Rules this file exists to enforce:
 *
 * - Channel names are `domain:verb`. Inlining one at a call site is safe — the
 *   wrappers are generic over `ChannelName`/`EventName`, so a renamed channel
 *   is a compile error, not silent drift. What the lint rule guards instead is
 *   reaching past those wrappers to `ipcMain.handle`/`webContents.send`, which
 *   typechecks fine while skipping validation and error mapping (R4).
 * - `register.ts` validates every request against its schema before calling
 *   the handler, and validates responses in dev builds only — fail loud in
 *   dev, fast in prod.
 * - Renderer→main is always `invoke` (request/response). Main→renderer uses
 *   EVENTS for high-frequency streaming, which invoke cannot model.
 *
 * Every channel here must have a test in `test/ipc.test.ts`, and a meta-test
 * asserts none is missing — see A9.
 */

const empty = z.object({})

// ---------------------------------------------------------------------------
// Channels: renderer → main, request/response via invoke
// ---------------------------------------------------------------------------

export const CHANNELS = {
  'sgf:parse': {
    request: z.object({
      content: z.string(),
      /**
       * Branch navigation (`design.md` §Branch navigation): child index to
       * follow at each branch point along the line, in walk order. A branch
       * point is a node with at least two usable alternatives (children whose
       * own line carries a move) — exactly the nodes `Game.branches` reports
       * options at. Absent means the default mainline (first child at every
       * branch). Entry `k` is the SGF child index at the `k`-th branch point
       * on the followed line — exactly the `BranchOption.index` the picker
       * offers, so a choice round-trips without a mapping.
       */
      variationPath: z.array(z.number().int().min(0)).optional(),
    }),
    response: gameSchema,
  },
  'sgf:serialize': {
    request: z.object({ gameId: z.string().min(1) }),
    response: z.object({ content: z.string() }),
  },
  'sgf:openDialog': {
    request: empty,
    // Empty array means the user cancelled — not an error.
    response: z.object({ filePaths: z.array(z.string()) }),
  },

  'library:list': {
    request: empty,
    response: z.object({ games: z.array(gameSummarySchema) }),
  },
  'library:import': {
    request: z.object({ filePaths: z.array(z.string()).min(1) }),
    // Partial success is normal: one bad file in a folder import must not
    // fail the whole batch, so failures are data rather than a thrown error.
    response: z.object({
      imported: z.array(gameSummarySchema),
      duplicates: z.number().int().min(0),
      failures: z.array(z.object({ filePath: z.string(), error: errorEnvelopeSchema })),
    }),
  },

  'llm:sendMessage': {
    request: z.object({
      content: z.string().min(1),
      context: chatContextSchema.optional(),
      history: z.array(chatMessageSchema).default([]),
    }),
    // Returns a handle, not the reply — the reply streams over EVENTS.
    response: z.object({ runId: z.string() }),
  },
  'llm:cancel': {
    request: z.object({ runId: z.string().min(1) }),
    response: empty,
  },

  'settings:get': {
    request: empty,
    response: settingsSchema,
  },
  'settings:set': {
    // `settingsPatchSchema`, not `settingsSchema.partial()`. The latter makes
    // keys optional but leaves each field's `.default()` in place, so zod's
    // output — which is what `register.ts` hands the handler — came back as the
    // whole document filled with defaults. A patch naming one field then reset
    // every other setting the user had chosen. See the note on
    // `settingsPatchSchema`.
    request: z.object({ patch: settingsPatchSchema }),
    response: settingsSchema,
  },
  'settings:setSecret': {
    // The value goes main-ward only. It is never returned, never logged.
    request: z.object({ key: secretKeySchema, value: z.string() }),
    response: empty,
  },
  'settings:hasSecret': {
    request: z.object({ key: secretKeySchema }),
    response: z.object({ present: z.boolean() }),
  },

  /**
   * Engine lifecycle. Startup is lazy: `engine:start` fires when the first game
   * opens, not at app launch (`design.md` §Engine lifecycle), so a chat-only
   * user never pays for a resident engine process. Both channels answer with a
   * snapshot so a fresh mount can sync without subscribing first.
   */
  'engine:info': {
    request: empty,
    response: engineInfoSchema,
  },
  'engine:start': {
    request: empty,
    // Idempotent: calling it while `starting` joins the in-flight attempt, and
    // calling it while `ready` is a no-op returning the snapshot. From
    // `failed` it retries the whole start (that is the recovery path).
    response: engineInfoSchema,
  },
  /**
   * Live analysis. `game: null` closes analysis: in-flight queries are
   * terminated, the held record is dropped, and the engine stays warm for the
   * next open — closing a record is not an engine shutdown. The response names
   * the focus query correlating the results for this position, or null when
   * the engine is not ready (the service remembers the request and issues it
   * on ready, so a slow cold start loses nothing but latency).
   *
   * `atMove` selects the analysed position inside the record and is ignored
   * when `game` is null.
   */
  'engine:setGame': {
    request: z.object({
      game: engineGameSchema.nullable(),
      atMove: z.number().int().min(0),
    }),
    response: z.object({ focusQueryId: z.string().nullable() }),
  },
  /**
   * Cursor movement: one integer, carrying nothing else, because cursor steps
   * resend nothing (`design.md` §IPC additions). Main debounces cursor streams
   * ~50ms latest-wins before touching the engine — holding an arrow key must
   * not queue 200 queries — and supersedes the prior in-flight focus query
   * with a production `encodeTerminateRequest`.
   *
   * Design.md wrote this response's id as non-nullable; it is nullable for
   * the same reason `setGame`'s is — with no record open there is no query to
   * name, and the renderer only calls this with a record open. Null there
   * means "nothing was scheduled", not an error.
   */
  'engine:setCursor': {
    request: z.object({ moveNumber: z.number().int().min(0) }),
    response: z.object({ focusQueryId: z.string().nullable() }),
  },
} as const

export type Channels = typeof CHANNELS
export type ChannelName = keyof Channels

export type ChannelRequest<C extends ChannelName> = z.infer<Channels[C]['request']>
export type ChannelResponse<C extends ChannelName> = z.infer<Channels[C]['response']>

export const CHANNEL_NAMES = Object.keys(CHANNELS) as ChannelName[]

// ---------------------------------------------------------------------------
// Events: main → renderer, one-way push
// ---------------------------------------------------------------------------

export const EVENTS = {
  /** Token and tool-call fragments. Correlated by runId. */
  'llm:delta': z.object({ runId: z.string(), chunk: chatChunkSchema }),
  'llm:done': z.object({
    runId: z.string(),
    finishReason: z.enum(['stop', 'length', 'tool_calls', 'aborted', 'error']),
  }),
  'llm:error': z.object({ runId: z.string(), error: errorEnvelopeSchema }),

  /** The library changed on disk or via import; the renderer refetches. */
  'library:changed': z.object({ reason: z.enum(['import', 'delete', 'watch']) }),

  /**
   * The native menu asked the renderer to run a flow it owns.
   *
   * The menu lives in main but the open-SGF flow lives in the renderer, and
   * having main open the dialog directly would make the accelerator and the
   * in-app button two independent paths to the same feature — which is how they
   * drift. So main asks, and the renderer runs the one implementation.
   */
  'menu:command': z.object({ command: z.enum(['openSgf']) }),

  /**
   * Engine lifecycle transitions. Startup is lazy (`engine:start` on first
   * game open), so a user who only chats never pays for a resident engine.
   */
  'engine:status': engineInfoSchema,

  /**
   * One analysis tick, coalesced per query to ≤20/s in main before sending —
   * engines emit far faster than a UI can usefully paint, and flooding IPC is
   * a known Electron cliff. The payload is the shared `AnalysisResult`
   * verbatim (`queryId` namespaces it: `focus:<n>` now, `sweep:<move>` in
   * Stage 4); the renderer routes by prefix and filters by `gameId` +
   * `moveNumber`, so a late tick from a since-closed game or a superseded
   * cursor position never reaches the screen.
   */
  'engine:analysis': analysisResultSchema,
} as const

export type Events = typeof EVENTS
export type EventName = keyof Events
export type EventPayload<E extends EventName> = z.infer<Events[E]>

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[]
