import { create } from 'zustand'
import type {
  ChatChunk,
  ChatContext,
  ChatMessage,
  ErrorEnvelope,
  RunStatus,
} from '@gomentor/shared'

/**
 * The teacher conversation, and the stream currently filling it.
 *
 * ## Every event is filtered by `runId`, and that is the load-bearing part
 *
 * `llm:sendMessage` returns a handle, not a reply — the reply arrives as
 * `llm:delta` / `llm:done` / `llm:error` events (`ipc.ts` records why: a stream
 * cannot be modelled as one round trip). Nothing guarantees those events stop
 * arriving after a cancel. `llm:cancel` asks main to stop a run; deltas already in
 * flight, or emitted before the provider notices, still land here.
 *
 * So a chunk whose `runId` is not the active one is **dropped**, not appended.
 * Without that check, cancelling one question and asking another appends the
 * abandoned answer into the middle of the new one — and it looks like the model
 * produced word salad rather than like a bug in this file.
 *
 * ## A renderer reload loses the run, on purpose
 *
 * The run is owned by main (the agent loop and its tools live there), but its
 * identity lives in *this* store's `activeRunId`, which dies with the window.
 * After a reload every `llm:delta` for the old run fails the filter above —
 * including the terminal one — so the panel shows its initial empty state and
 * the in-flight answer is gone from view. Main still finishes (or cancels) the
 * run; nothing is orphaned. Re-attaching a new window to an old runId would
 * need main to buffer and replay a stream, which no milestone has asked for;
 * the accepted cost is that a reload during an answer loses that answer.
 *
 * ## The streaming text is accumulated here, not in React state
 *
 * `state-management.md` §Common Mistakes: token deltas arrive faster than React
 * can usefully re-render. The partial answer lives in `streaming`, and the UI reads
 * it at whatever cadence it paints. It is deliberately *not* a `ChatMessage` in
 * `messages` until the run finishes — a half-written message in the list would be
 * indistinguishable from a complete one to anything that later persists or exports
 * the conversation.
 *
 * ## Tool-call arguments accumulate as text, and are not parsed here
 *
 * `chatChunkSchema` says `argumentsDelta` "arrives fragmented across chunks; the
 * consumer accumulates". Mid-stream that text is *not valid JSON* — parsing each
 * fragment would throw on almost every chunk. The renderer only ever displays which
 * tool is running; whoever executes the call parses the completed arguments against
 * that tool's own schema, per `toolCallSchema`. The `tool_result` chunk is stored
 * the same way — verbatim, whole, unparsed. The M3 agent loop in main sends the
 * *complete* outcome in one chunk (the model reads the same text), so there is
 * nothing to accumulate; the ~120-character step preview is applied where it is
 * displayed, never to the stored state.
 */

/**
 * One tool step, shown as a row under the assistant turn that requested it.
 *
 * The same shape serves both halves of the display: while the run streams, the
 * rows live in `toolCalls` and fill in incrementally; at `llm:done` they are
 * filed under the finished message's id in `stepsByMessage`, so the transcript
 * keeps showing what the teacher did after the answer is complete. A step that
 * vanishes the moment `done` arrives would tell the user the tool ran only
 * while it was running.
 */
export interface ToolStep {
  id: string
  name: string
  /** Concatenated `argumentsDelta` fragments. Not parsed, not necessarily JSON yet. */
  argumentsText: string
  /**
   * The full result content, from the `tool_result` chunk matching this call's
   * id. Absent until then. Held whole — the ~120-character bound is a display
   * decision in the component, not a state decision here; truncating in the
   * store would make "expand" a lie about data that did arrive.
   */
  resultText?: string
}

interface ChatState {
  /** Completed turns, in order. Never contains a partially streamed answer. */
  messages: ChatMessage[]
  /** The run whose events this store accepts. `null` when nothing is streaming. */
  activeRunId: string | null
  status: RunStatus
  /** The answer so far for `activeRunId`. Cleared when the run ends. */
  streaming: string
  /** Tool calls seen in the current run, in arrival order. */
  toolCalls: ToolStep[]
  /**
   * Steps of finished turns, keyed by the assistant message that requested
   * them. Populated at `llm:done` from `toolCalls`, so a completed turn keeps
   * showing its steps after the streaming buffer is cleared.
   */
  stepsByMessage: Record<string, readonly ToolStep[]>
  /** Last failure, from the send itself or from an `llm:error` event. */
  error: ErrorEnvelope | null

  send: (content: string, context?: ChatContext) => Promise<void>
  cancel: () => Promise<void>
  /** Feed from the `llm:delta` subscription. Ignores foreign runs. */
  receiveChunk: (runId: string, chunk: ChatChunk) => void
  /** Feed from `llm:done`. */
  finishRun: (runId: string, finishReason: string) => void
  /** Feed from `llm:error`. */
  failRun: (runId: string, error: ErrorEnvelope) => void
  clear: () => void
}

/**
 * Ids for locally created messages.
 *
 * `crypto.randomUUID` rather than a counter: a counter restarts at 1 when the store
 * is recreated, and two messages sharing an id make React reuse the wrong DOM node
 * and any future persistence layer overwrite one with the other. Available in the
 * renderer without a Node import — it is a Web Crypto global, so this stays inside
 * the "no Node APIs in the renderer" rule.
 */
function messageId(): string {
  return crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * The assistant turn assembled from a finished run.
 *
 * Built only at `llm:done`, from the accumulated text — so a message enters
 * `messages` complete or not at all.
 */
function assistantMessage(state: ChatState): ChatMessage {
  return {
    id: messageId(),
    role: 'assistant',
    content: state.streaming,
    // Omitted rather than empty when no tool ran: `toolCalls` is optional in
    // `chatMessageSchema`, and an empty array would serialise into every message.
    ...(state.toolCalls.length > 0
      ? {
          toolCalls: state.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            // The completed arguments text is handed on unparsed. Parsing belongs
            // where the tool's schema is, not here.
            arguments: { raw: call.argumentsText },
          })),
        }
      : {}),
    createdAt: nowIso(),
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  activeRunId: null,
  status: 'idle',
  streaming: '',
  toolCalls: [],
  stepsByMessage: {},
  error: null,

  send: async (content, context) => {
    const { messages, status } = get()

    // A second send while one is streaming would leave the first run's events
    // arriving against a new `activeRunId` — the interleaving this store filters
    // for. Refused as state rather than queued: M1 has one conversation and one
    // input box, and a queue nobody can observe is untested machinery.
    if (status === 'streaming' || status === 'awaiting_tool') return

    const userMessage: ChatMessage = {
      id: messageId(),
      role: 'user',
      content,
      createdAt: nowIso(),
    }

    // The user's turn is appended before the request, so their message appears
    // immediately rather than after a network round trip.
    set({
      messages: [...messages, userMessage],
      error: null,
      streaming: '',
      toolCalls: [],
      status: 'streaming',
    })

    const result = await window.gomentor.llm.sendMessage({
      content,
      // `history` is the conversation *before* this turn. Sending `messages` after
      // the append would include the new question twice — once as history and once
      // as `content` — which reads to the model as the user repeating themselves.
      history: messages,
      ...(context === undefined ? {} : { context }),
    })

    if (!result.ok) {
      // The user's message stays in the list. Removing it would erase what they
      // typed because the send failed, and they would have to retype it to retry.
      set({ status: 'error', error: result.error, activeRunId: null })
      return
    }

    set({ activeRunId: result.data.runId })
  },

  cancel: async () => {
    const runId = get().activeRunId
    if (runId === null) return

    // Cleared *before* awaiting, not after. Between the request and its response,
    // deltas from the cancelled run are still arriving; leaving `activeRunId` set
    // until the await resolves would accept every one of them.
    set({ activeRunId: null, status: 'idle', streaming: '', toolCalls: [] })

    const result = await window.gomentor.llm.cancel({ runId })
    if (!result.ok) {
      // The local state is already back to idle and stays that way: from the
      // user's point of view the cancel happened. This records that main may still
      // be running the request.
      set({ error: result.error })
    }
  },

  receiveChunk: (runId, chunk) => {
    const state = get()
    // The filter this store exists for. See the header note.
    if (runId !== state.activeRunId) return

    switch (chunk.type) {
      case 'text':
        set({ streaming: state.streaming + chunk.delta })
        return

      case 'tool_call': {
        const existing = state.toolCalls.findIndex((call) => call.id === chunk.id)
        if (existing === -1) {
          set({
            toolCalls: [
              ...state.toolCalls,
              { id: chunk.id, name: chunk.name, argumentsText: chunk.argumentsDelta },
            ],
            status: 'awaiting_tool',
          })
          return
        }
        // Same id again means more argument text for a call already seen —
        // appended, not replaced. Replacing would keep only the final fragment,
        // leaving `{"coord": "d4"}` as `4"}`.
        set({
          toolCalls: state.toolCalls.map((call, index) =>
            index === existing
              ? { ...call, argumentsText: call.argumentsText + chunk.argumentsDelta }
              : call,
          ),
        })
        return
      }

      case 'tool_result': {
        // The result's content belongs to the agent loop in main, which decides
        // what to do next with it; the renderer keeps it so the step row can show
        // what came back. Filed against the call id the chunk names — a result
        // with no matching call is dropped rather than invented, the same way a
        // chunk from a foreign run is.
        const matched = state.toolCalls.some((call) => call.id === chunk.toolCallId)
        set({
          toolCalls: matched
            ? state.toolCalls.map((call) =>
                call.id === chunk.toolCallId
                  ? // Held whole; the component decides how much of it to show.
                    { ...call, resultText: chunk.content }
                  : call,
              )
            : state.toolCalls,
          status: 'streaming',
        })
        return
      }

      case 'done':
        // A `done` *chunk* is not the `llm:done` event. Both can arrive; the run is
        // finished by `finishRun` so there is one place that appends the message.
        return
    }
  },

  finishRun: (runId, finishReason) => {
    const state = get()
    if (runId !== state.activeRunId) return

    // An aborted run has no answer worth keeping — appending a truncated one would
    // put a half sentence in the transcript as though the teacher had said it.
    if (finishReason === 'aborted') {
      set({ activeRunId: null, status: 'idle', streaming: '', toolCalls: [] })
      return
    }

    const message = assistantMessage(state)
    set({
      messages: [...state.messages, message],
      // The run's steps are filed under the turn that asked for them, so the
      // transcript keeps showing what the teacher did after the answer lands.
      // Spread rather than assigned: under `exactOptionalPropertyTypes` a run
      // with no tools must not write an empty entry against its message.
      ...(state.toolCalls.length > 0
        ? { stepsByMessage: { ...state.stepsByMessage, [message.id]: state.toolCalls } }
        : {}),
      activeRunId: null,
      status: 'done',
      streaming: '',
      toolCalls: [],
    })
  },

  failRun: (runId, error) => {
    const state = get()
    if (runId !== state.activeRunId) return

    // The partial answer is discarded rather than committed. A failed run's text
    // stops mid-sentence, and in the transcript that is indistinguishable from a
    // complete reply.
    set({
      activeRunId: null,
      status: 'error',
      error,
      streaming: '',
      toolCalls: [],
    })
  },

  clear: () => {
    set({
      messages: [],
      activeRunId: null,
      status: 'idle',
      streaming: '',
      toolCalls: [],
      stepsByMessage: {},
      error: null,
    })
  },
}))
