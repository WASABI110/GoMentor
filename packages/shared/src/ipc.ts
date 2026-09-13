import { z } from 'zod'
import { gameSchema, gameSummarySchema } from './types/game'
import {
  analysisResultSchema,
  engineGameSchema,
  engineInfoSchema,
} from './types/analysis'
import { batchProgressSchema, batchStatusSchema, batchScopeSchema } from './types/batch'
import { profileSnapshotSchema } from './types/profile'
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

  /**
   * Batch analysis of the library (M4 Stage 2). `batch:start` queues every
   * in-scope game that is not already `done` in the ledger and returns the
   * run's snapshot; the run itself proceeds in the background and reports on
   * `batch:progress`. The engine starts lazily, like a game open — a
   * chat-only user who clicks "analyse my library" pays exactly one engine
   * start, and an engine that stays not-ready rejects with its own typed
   * code (an expected state with a UI, not a crash).
   *
   * Starting while a run is active is `BATCH_ALREADY_RUNNING`, not a silent
   * join: joining would report the in-flight run's scope and totals for a
   * request that asked for something else.
   */
  'batch:start': {
    request: z.object({ scope: batchScopeSchema }),
    response: batchStatusSchema,
  },
  /**
   * Stops the active run: in-flight queries are aborted (the engine is told,
   * per the agent tier's terminate-on-cancel) and no new queries are issued.
   * Games that did not finish stay `pending` in the ledger and resume on the
   * next run. Cancelling with nothing running is a no-op, like `llm:cancel`.
   */
  'batch:cancel': {
    request: empty,
    response: batchStatusSchema,
  },
  /** The synchronous snapshot, so a freshly mounted panel syncs without subscribing first. */
  'batch:status': {
    request: empty,
    response: batchStatusSchema,
  },
  /**
   * The student profile (M4 Stage 3), derived on demand from the persisted
   * analysis rows of the student's own games — pure core, milliseconds, no
   * snapshot to invalidate. The response carries the three named weaknesses
   * plus the counts the panel needs to say "run the batch analysis" when
   * nothing is analysed yet. An empty weaknesses list is a state, not an
   * error: a student with no classified weaknesses has nothing to show.
   */
  'profile:get': {
    request: empty,
    response: profileSnapshotSchema,
  },
  /**
   * GPU tier-2 state (M5 Stage 4): which backends are downloaded (their
   * binary exists in the fetch layout) and which one
   * `settings.engine.backend` names. Read on settings-panel mount; the live
   * download story is `gpu:download` + the `gpu:progress` event.
   */
  'gpu:status': {
    request: empty,
    response: z.object({
      backends: z.array(
        z.object({
          backend: z.enum(['cuda', 'opencl']),
          /** The engine binary exists in the fetch layout for this platform. */
          downloaded: z.boolean(),
          /** `settings.engine.backend` names this backend. */
          preferred: z.boolean(),
        }),
      ),
    }),
  },
  /**
   * Fetches one GPU backend from the pinned upstream assets (same TOFU chain
   * as the CLI's `pnpm fetch:gpu`). Returns immediately; progress arrives on
   * the `gpu:progress` event. One download at a time — a second concurrent
   * request is the typed error `GPU_ALREADY_DOWNLOADING`, because two
   * writers to one `.partial` file would corrupt each other's resumes.
   */
  'gpu:download': {
    request: z.object({ backend: z.enum(['cuda', 'opencl']) }),
    response: z.object({ started: z.boolean() }),
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

  /**
   * Batch-run progress: emitted on run start, after each game completes, and
   * once with a terminal status (`done` | `cancelled` | `failed`). Bounded by
   * the game's-in-the-run count, so no coalescing. A `failed` terminal
   * carries the typed envelope (usually an `ENGINE_*` code) so the renderer
   * can translate it; per-game failures are not errors — they are the
   * `failed` count, and the game is retried on the next run.
   */
  'batch:progress': batchProgressSchema,

  /**
   * Auto-update lifecycle (M5). Emitted on state transitions only — checking,
   * available (with the version), download progress (electron-updater's own
   * throttling), downloaded (the renderer prompts "restart to install"), an
   * error, or `idle` after a not-available check. `disabled` is sent once at
   * startup when eligibility fails (dev build, setting off, or the unsigned
   * macOS policy) so the settings panel can say WHY there is no updater
   * instead of showing a dead row. Errors carry a message string only — never
   * a stack (the renderer-transit rule).
   */
  'update:status': z.object({
    state: z.enum([
      'idle',
      'checking',
      'available',
      'downloading',
      'downloaded',
      'error',
      'disabled',
    ]),
    version: z.string().optional(),
    progress: z.number().min(0).max(100).optional(),
    error: z.string().optional(),
  }),

  /**
   * GPU tier-2 download progress (M5 Stage 4): one run per backend, states in
   * order `downloading` (with `received`/`total` bytes; total null when the
   * server sent no length), `extracting`, then `done` or `error`. Emitted on
   * the service's throttle — at most a few per second, never per chunk.
   */
  'gpu:progress': z.object({
    backend: z.enum(['cuda', 'opencl']),
    state: z.enum(['downloading', 'extracting', 'done', 'error']),
    received: z.number().int().min(0).optional(),
    total: z.number().int().min(0).nullable().optional(),
    error: z.string().optional(),
  }),
} as const

export type Events = typeof EVENTS
export type EventName = keyof Events
export type EventPayload<E extends EventName> = z.infer<Events[E]>

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[]
