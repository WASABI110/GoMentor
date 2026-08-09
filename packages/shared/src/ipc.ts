import { z } from 'zod'
import { gameSchema, gameSummarySchema } from './types/game'
import { engineInfoSchema } from './types/analysis'
import { chatChunkSchema, chatContextSchema, chatMessageSchema } from './types/chat'
import { secretKeySchema, settingsPatchSchema, settingsSchema } from './types/settings'
import { errorEnvelopeSchema } from './types/errors'

/**
 * THE IPC contract. Single source of truth for every channel name and payload
 * shape in the app.
 *
 * Rules this file exists to enforce:
 *
 * - Channel names are `domain:verb`. A lint rule forbids inlining these
 *   strings anywhere else, because a renamed channel would otherwise drift
 *   silently.
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
    request: z.object({ content: z.string() }),
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
   * Engine lifecycle transitions. M1 only ever emits 'unavailable'.
   * M2 will coalesce high-frequency analysis ticks to ~20/s before sending —
   * engines emit far faster than a UI can usefully paint.
   */
  'engine:status': engineInfoSchema,
} as const

export type Events = typeof EVENTS
export type EventName = keyof Events
export type EventPayload<E extends EventName> = z.infer<Events[E]>

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[]
