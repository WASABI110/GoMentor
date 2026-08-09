import { BrowserWindow } from 'electron'
import { EVENTS, type EventName, type EventPayload } from '@gomentor/shared'
import { scoped } from '../logger'

/**
 * Main → renderer push. The counterpart to `register.ts`'s invoke handling.
 *
 * ## Why events exist at all, given invoke
 *
 * Invoke is request/response, which cannot model a stream. `llm:sendMessage`
 * returns a `runId` immediately and the tokens arrive here, correlated by that
 * id (`design.md` §IPC). Modelling streaming as invoke would mean either
 * blocking until the reply completed — no incremental rendering — or a chunked
 * invoke protocol, which is this, reinvented worse.
 *
 * ## Payloads are validated in dev, like responses
 *
 * Same reasoning as `register.ts`: an event with the wrong shape is a
 * programming error, and the renderer's handler will fail somewhere far from the
 * cause. Dev catches it at the send site.
 */

const logger = scoped('main:ipc')

const validatePayloads = process.env['NODE_ENV'] !== 'production'

/**
 * Sends to every open window.
 *
 * Broadcast rather than targeted because M1 has one window and the events are
 * all state-changed notifications that any window should act on. When a second
 * window type arrives, the streaming events (`llm:*`) will need targeting by
 * `runId` owner — a `runId` belongs to whichever window asked, and delivering
 * another window's tokens to it would interleave two conversations.
 */
export function emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
  if (validatePayloads) {
    const result = EVENTS[event].safeParse(payload)
    if (!result.success) {
      // Logged and dropped rather than thrown: an event send is usually inside a
      // stream loop or a filesystem callback, where a throw would take down the
      // operation that was working. Paths only, never values — an `llm:delta`
      // payload is model output.
      logger.error('event payload failed validation', {
        event,
        issues: result.error.issues.map((issue) => issue.path.join('.')),
      })
      return
    }
  }

  for (const window of BrowserWindow.getAllWindows()) {
    // A window closed between the enumeration and the send would throw on a
    // destroyed WebContents. Common during quit, and not worth an error line.
    if (window.isDestroyed()) continue
    window.webContents.send(event, payload)
  }
}
