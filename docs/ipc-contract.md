# IPC contract

Every channel and event that crosses a process boundary in GoMentor.

The machine-readable contract is [`packages/shared/src/ipc.ts`](../packages/shared/src/ipc.ts) and it is the authority. This document exists for what the code cannot state: why a channel is shaped the way it is, what is deliberately _absent_, and which rules a reviewer has to know to tell a correct handler from a plausible one.

**This file is machine-checked.** `packages/shared/test/ipc-doc.test.ts` fails if the set of channels and events documented here differs from `CHANNELS` and `EVENTS` in either direction. Adding a channel without documenting it fails; documenting one that no longer exists fails too. What no test can check is whether the prose below is still _true_ — so when you change a channel's behaviour, change the words as well as the schema.

**What is not duplicated here:** field lists. Payload shapes live in the zod schemas and are reproduced nowhere, because a copied field list drifts silently and a stale one is worse than none. Each entry names its schema; read it there.

## Shape of the boundary

Three processes, two directions, and the asymmetry is deliberate.

- **Renderer → main is always `invoke`** — request/response, one result per call. Listed under [Channels](#channels).
- **Main → renderer is always an event** — one-way push, no reply. Listed under [Events](#events). Events exist for what `invoke` cannot model: a stream whose length is unknown when the call is made, and a notification nobody asked for.
- **Renderer → renderer does not cross anything** and is not here.

There is no generic `send`, no generic `on`, and no `window.ipcRenderer`. The preload exposes one named function per channel ([`apps/desktop/src/preload/index.ts`](../apps/desktop/src/preload/index.ts)), so the renderer cannot name a channel the contract does not have, and a renamed channel is a compile error rather than a silently dead listener.

### Every response is an envelope, never a throw

Handlers return `IpcResult<T>` — `{ ok: true, data }` or `{ ok: false, error }` ([`types/errors.ts:95`](../packages/shared/src/types/errors.ts#L95)). Nothing rejects across the bridge.

This is not stylistic. `contextBridge` copies values structurally, and a thrown `Error` arrives on the renderer side with **only `message`** — `code`, `context`, and every own property are gone. Measured, not assumed. So an error thrown across the boundary is an error the renderer cannot branch on and cannot translate. The envelope is data, and data survives.

### The error envelope carries a code and nothing sensitive

`errorEnvelopeSchema` ([`types/errors.ts:86`](../packages/shared/src/types/errors.ts#L86)) is `{ code, message, context? }`. Note what is missing:

- **No `cause`.** No stack. Stacks carry filesystem paths and argument values; they stay in main.
- **`message` is developer-facing.** The renderer must never render it as primary UI text. It translates `code` through the `errors` i18n namespace and shows that. `message` may appear in a details/copy affordance.
- **`context` is logged.** Anything put in it is subject to the logging rules: no secrets, no SGF content, no chat text, no prompts, no credentialed URLs. Bound the size where the message is built — an error message interpolating a value from a file or a network response is a log payload.

`register.ts` maps a thrown `AppError` into this shape. A throw with no `code` becomes `IPC_HANDLER_FAILED`, which is correct behaviour and also a defect: every error crossing this boundary is supposed to carry its own code.

### Validation runs on both sides of the call, asymmetrically

`register.ts` validates **every request** against its schema before the handler sees it, and validates **responses in dev builds only**. Fail loud in dev, fast in prod. A request that fails validation never reaches the handler and comes back `IPC_INVALID_REQUEST`.

Note the consequence for `zod`'s `.default()`: what the handler receives is zod's _output_, not the renderer's literal payload. This is exactly how `settings:set` was once broken — see its entry below.

### Expected absence is a state, not an error

A cancelled file dialog returns an empty array. A missing engine reports `status: 'unavailable'`. A library with no games returns `games: []`. None of these is `ok: false`. Reserve the failure branch for things that actually went wrong, or the renderer ends up showing an error notice for a user who simply pressed Escape.

## Channels

Renderer → main, `invoke`, one response each. Request/response schemas are in [`ipc.ts`](../packages/shared/src/ipc.ts); the referenced payload types are in `packages/shared/src/types/`.

### `sgf:parse`

Parses SGF text into a `Game`. Text in, structure out — the file read happens elsewhere, which keeps the parser testable against a string and keeps this channel usable for content that never was a file (clipboard, a future network source).

Failure is specific by design: `SGF_TRUNCATED`, `SGF_EMPTY`, `SGF_NOT_SGF`, `SGF_INVALID_PROPERTY`, `SGF_UNSUPPORTED_BOARD_SIZE`, `SGF_TOO_DEEP`. Each has a different user-facing remedy, which is why they are not one code.

### `sgf:serialize`

`Game` back to SGF text, addressed by `gameId` rather than by value: the renderer holding the game does not make the renderer the authority on it, and passing the whole structure back would let the two copies disagree.

`SGF_UNSUPPORTED_ENCODING` is a _write_-side limitation on our end, not a defect in the user's file — `TextEncoder` emits only UTF-8, so a file that arrived in a legacy codepage cannot be re-encoded to it.

### `sgf:openDialog`

Opens the native file dialog and returns the chosen paths. Main owns this because a renderer cannot open one, and the dialog is modal to a window main owns.

**An empty array means the user cancelled.** Not an error, not `ok: false`.

The renderer, not main, then drives the open flow — which is what `menu:command` exists for.

### `library:list`

Every game summary in the library. Summaries, not full games: a list view needs a dozen fields and a library may hold thousands of records.

### `library:import`

Imports one or more SGF files by path.

**Partial success is the normal case.** One unreadable file in a folder of two hundred must not fail the import, so the response carries three parts: `imported`, a `duplicates` count, and a `failures` array of `{ filePath, error }`. Failures are _data_. A caller that only checks `ok` and ignores `failures` will silently drop files, and the UI is required to show them.

On success with `imported.length > 0`, main emits [`library:changed`](#librarychanged).

### `llm:sendMessage`

Sends a user message and **returns a handle, not a reply**: `{ runId }`. The reply itself arrives over [`llm:delta`](#llmdelta) / [`llm:done`](#llmdone) / [`llm:error`](#llmerror), because a token stream has no length at call time and `invoke` cannot express one.

Everything that follows is correlated by that `runId`, and the renderer must **drop deltas whose `runId` is not the active run** — otherwise a cancelled run's in-flight tokens append themselves to its successor's message.

`history` is supplied by the renderer and defaults to `[]`. `context` is optional game context.

Provider construction throws `LLM_NO_KEY` when the cloud path has no credential, and it throws at _construction_ — so a keyless environment (CI included) cannot use the cloud provider at all. A local provider (`kind: 'local'`) needs no credential, which is what makes this channel testable without secrets.

### `llm:cancel`

Cancels a run by `runId`. Cancellation is cooperative and asynchronous: the resolution of this call is not the end of the stream. Expect a terminal `llm:done` with `finishReason: 'aborted'`, and expect deltas to arrive in between.

Cancelling a run that already finished is not an error.

### `settings:get`

The whole settings document, validated. Secrets are not in it — see below.

### `settings:set`

Applies a **patch**.

The request field is `settingsPatchSchema`, and the reason is a fixed bug worth not reintroducing. The obvious spelling, `settingsSchema.partial()`, makes each key optional but leaves each field's `.default()` in place — so zod's _output_, which is what the handler receives, came back as the entire document filled with defaults. A patch naming one field reset every other setting the user had chosen. `.partial()` on a schema with defaults is not a patch type.

Returns the full settings document as persisted, so the renderer never has to guess how its patch merged.

### `settings:setSecret`

Stores a secret under a key from `secretKeySchema` (`llmApiKey`, `foxSessionToken`).

**The value travels main-ward only.** It is never returned by any channel, never logged, never included in an error `context`, and never written to a log at any level — not even a redacted-looking prefix. Storage goes through `safeStorage`.

If `safeStorage.isEncryptionAvailable()` is false, the app **refuses to persist**, holds the value in memory for the session, and warns in the UI (`SETTINGS_ENCRYPTION_UNAVAILABLE`). Writing an unencrypted key to disk because encryption was unavailable would be the worst of the three options and is not one of them.

### `settings:hasSecret`

Whether a secret is present: `{ present: boolean }`.

**A boolean is the entire renderer-visible surface of every secret.** There is deliberately no `settings:getSecret` — not gated, not dev-only, not "for testing". The renderer needs to render "key configured ✓" and to enable a button; both are decidable from a boolean. A channel that returned the value would put every stored credential one `page.evaluate` away.

## Events

Main → renderer, one-way. Payload schemas are `EVENTS` in [`ipc.ts:116`](../packages/shared/src/ipc.ts#L116).

Events have no reply and no delivery guarantee to a listener that is not yet mounted. A renderer that subscribes late has missed what came before, so anything the UI must not miss belongs in a channel response, not only in an event.

### `llm:delta`

A fragment of a streaming reply: `{ runId, chunk }`, where `chunk` is a `chatChunkSchema` discriminated union (`text` | `tool_call` | `tool_result` | …). High-frequency; this is the reason events exist here at all.

`tool_call` arguments **arrive fragmented across chunks** and the consumer accumulates them. A consumer that JSON-parses each `argumentsDelta` on arrival will fail on almost every real call.

Filter on `runId` against the active run before applying anything.

### `llm:done`

Terminal for a run: `{ runId, finishReason }`, one of `stop | length | tool_calls | aborted | error`. Exactly one terminal event per run. `tool_calls` is not a failure — it means the model stopped to call a tool and the conversation continues.

### `llm:error`

`{ runId, error }` with the same envelope as everywhere else, carrying a `code` for the renderer to translate. Also terminal.

### `library:changed`

`{ reason: 'import' | 'delete' | 'watch' }`. The library changed; **the renderer refetches** rather than receiving the new contents. Sending the payload would make this event a second source of truth for a list `library:list` already owns, and the two would disagree.

`reason` is for logging and for deciding whether to preserve selection, not a diff.

### `menu:command`

`{ command: 'openSgf' }`. The native menu asking the renderer to run a flow the renderer owns.

Main has the menu; the renderer has the open-SGF flow. Main opening the dialog itself would make the accelerator and the in-app button two independent implementations of one feature, which is how they drift apart. So main asks and the renderer runs its single implementation.

`command` is a one-member enum today. Dispatch it through a lookup keyed by the enum, not an `if` or a single-case `switch`: with one member those compare something that is always true, and deleting the comparison instead means the next command added silently runs `openSgf`. A `Record<MenuCommand, () => void>` makes `tsc` name the file when the enum widens. See [`useMainProcessEvents.ts`](../apps/desktop/src/renderer/src/hooks/useMainProcessEvents.ts).

There is no `menu:setLabels`. Menu labels are localised in main, which reads the locale itself — a channel for pushing labels renderer→main would have made the renderer the authority on a menu it does not own.

### `engine:status`

`engineInfoSchema` — the engine's lifecycle state, not analysis results.

**In M1 this only ever reports `unavailable`**, and every other feature must still work when it does. A build that disabled itself because no engine was found would satisfy a badge test and fail the requirement.

M2 will coalesce analysis ticks to roughly 20/s before sending. Engines emit far faster than a UI can usefully paint, and forwarding every tick makes the renderer the bottleneck.

## Adding a channel

1. Add it to `CHANNELS` or `EVENTS` in [`ipc.ts`](../packages/shared/src/ipc.ts) with both schemas.
2. Add a test case in `packages/shared/test/ipc.test.ts`. A meta-test fails if you do not (A9), and `ipc-meta.test.ts` proves that meta-test is not vacuous by running it against an injected channel.
3. Register the handler through `register.ts` — never `ipcMain.handle` directly, which typechecks while skipping validation and error mapping (R4).
4. Expose it by name in the preload. No generic passthrough.
5. Document it here, with a `### ` heading naming it in backticks. The doc test fails until you do.
