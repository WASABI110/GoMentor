import { z } from 'zod'

/**
 * LLM teacher conversation.
 *
 * `sendMessage` returns a runId rather than the reply, because the reply is a
 * stream. The renderer correlates `llm:delta` events by runId. Modelling it as
 * request/response would either block or need chunked-invoke hacks.
 */

export const chatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool'])
export type ChatRole = z.infer<typeof chatRoleSchema>

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Validated against the tool's own zod schema at dispatch, not here. */
  arguments: z.record(z.unknown()),
})
export type ToolCall = z.infer<typeof toolCallSchema>

export const toolResultSchema = z.object({
  toolCallId: z.string(),
  /** Serialised result. Shape depends on the tool. */
  content: z.string(),
  isError: z.boolean().default(false),
})
export type ToolResult = z.infer<typeof toolResultSchema>

export const chatMessageSchema = z.object({
  id: z.string(),
  role: chatRoleSchema,
  content: z.string(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolResult: toolResultSchema.optional(),
  createdAt: z.string(),
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

/**
 * One streamed fragment. Discriminated so the renderer can branch without
 * inspecting optional fields.
 */
export const chatChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    /** Arrives fragmented across chunks; the consumer accumulates. */
    argumentsDelta: z.string(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    finishReason: z.enum(['stop', 'length', 'tool_calls', 'aborted', 'error']),
  }),
])
export type ChatChunk = z.infer<typeof chatChunkSchema>

export const runStatusSchema = z.enum([
  'idle',
  'streaming',
  'awaiting_tool',
  'done',
  'error',
])
export type RunStatus = z.infer<typeof runStatusSchema>

/**
 * What the teacher can see. The renderer sends this so the agent loop can
 * ground its answer in the position under discussion.
 */
export const chatContextSchema = z.object({
  gameId: z.string().optional(),
  moveNumber: z.number().int().min(0).optional(),
})
export type ChatContext = z.infer<typeof chatContextSchema>
