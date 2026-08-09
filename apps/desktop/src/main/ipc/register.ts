import { ipcMain } from 'electron'
import {
  CHANNELS,
  isAppError,
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  type ErrorEnvelope,
  type IpcResult,
} from '@gomentor/shared'
import { scoped } from '../logger'
import { issuePaths } from '../redact'

/**
 * The one way an IPC handler is registered.
 *
 * Every handler goes through `handle()`, which:
 *
 * 1. **Validates the request** against the channel's schema, always. The
 *    renderer is not trusted — not because a user is an attacker, but because a
 *    renderer bug that sends the wrong shape must fail at the boundary with a
 *    typed error rather than halfway through a handler with a `TypeError`.
 * 2. **Validates the response in dev only.** Fail loud in dev, fast in prod
 *    (`design.md` §IPC). A response-shape bug is a programming error, so dev is
 *    where it needs to be caught; paying the parse cost in production for every
 *    `llm:delta`-adjacent call would be a real cost for no user benefit.
 * 3. **Maps every throw to a typed envelope.** No exception crosses the
 *    boundary as an exception: Electron would serialise it as a bare string,
 *    losing the `code` the renderer needs to translate the message
 *    (`error-handling.md`).
 *
 * ## Why the result is a union rather than a rejected promise
 *
 * `ipcRenderer.invoke` rejects with an `Error` whose message is a stringified
 * remote error. The `code` cannot survive that, and the renderer's whole error
 * story is `code` → i18n lookup. Returning `{ ok: false, error }` keeps the
 * envelope structured.
 *
 * The union then stays a union all the way to the renderer. This comment
 * previously said the preload unwrapped it back into a throw "so renderer call
 * sites still read like normal async code" — that was written before it was
 * tested, and Stage 5 measured it false. `contextBridge` does not carry an
 * Error's own properties: an `AppError` thrown inside a bridged function is
 * caught in the page as a plain `Error` with `name: 'Error'`, `Object.keys()`
 * empty, and `code` and `context` both `undefined`. Only `message` survives —
 * which is precisely the failure this union exists to avoid, reintroduced one
 * layer later. Returning the envelope as *data* preserves `code`, `message`, and
 * nested `context`, measured end-to-end in a real sandboxed window.
 */

const logger = scoped('main:ipc')

/**
 * Response validation is dev-only, and this is the switch. Read once at module
 * load: `app.isPackaged` would be the more direct signal, but importing `app`
 * here would make this module untestable outside Electron, and the handlers
 * integration test needs exactly that.
 */
const validateResponses = process.env['NODE_ENV'] !== 'production'

/** What a handler body looks like: validated request in, response data out. */
export type Handler<C extends ChannelName> = (
  request: ChannelRequest<C>,
) => ChannelResponse<C> | Promise<ChannelResponse<C>>

/**
 * Converts anything thrown into a wire envelope.
 *
 * A non-`AppError` becomes `IPC_HANDLER_FAILED` rather than being passed
 * through with its own message as the code, because the renderer switches on
 * `code` against a closed enum — an unrecognised code would fall through to no
 * message at all. The original is logged with its cause; only the code and a
 * generic message cross over.
 */
function toEnvelope(error: unknown): ErrorEnvelope {
  if (isAppError(error)) return error.toEnvelope()
  return {
    code: 'IPC_HANDLER_FAILED',
    // Deliberately generic. The real message is in the log, where it can carry
    // detail; this string is developer-facing and the renderer must not use it
    // as primary UI text (`error-handling.md` line 65).
    message: 'The operation failed',
  }
}

/**
 * Registers a handler for one channel.
 *
 * The channel must be a key of `CHANNELS`; there is no escape hatch for an
 * ad-hoc channel, which is what makes the A9 meta-test's claim — every channel
 * has coverage — mean something.
 */
export function handle<C extends ChannelName>(channel: C, handler: Handler<C>): void {
  const contract = CHANNELS[channel]

  ipcMain.handle(channel, async (_event, raw: unknown): Promise<IpcResult<unknown>> => {
    const requestResult = contract.request.safeParse(raw)
    if (!requestResult.success) {
      logger.warn('invalid request', {
        channel,
        issues: issuePaths(requestResult.error),
      })
      return {
        ok: false,
        error: {
          code: 'IPC_INVALID_REQUEST',
          message: `Request for ${channel} failed validation`,
          context: { issues: issuePaths(requestResult.error) },
        },
      }
    }

    try {
      // `as ChannelRequest<C>`: zod's inferred output for `contract.request` is
      // correct but TypeScript cannot see through the generic indexed access to
      // prove it. The narrowing has genuinely happened — `safeParse` succeeded
      // against the channel's own schema — so this is not an assertion standing
      // in for a missing check.
      const data = await handler(requestResult.data as ChannelRequest<C>)

      if (validateResponses) {
        const responseResult = contract.response.safeParse(data)
        if (!responseResult.success) {
          // A handler returning the wrong shape is our bug, so it is `error`,
          // not `warn`, and it fails the call rather than passing the bad shape
          // through. Silently returning it would move the failure into the
          // renderer, where the cause is invisible.
          logger.error('handler returned an invalid response', {
            channel,
            issues: issuePaths(responseResult.error),
          })
          return {
            ok: false,
            error: {
              code: 'IPC_INVALID_RESPONSE',
              message: `Response from ${channel} failed validation`,
              context: { issues: issuePaths(responseResult.error) },
            },
          }
        }
      }

      logger.debug('handled', { channel })
      return { ok: true, data }
    } catch (error) {
      // `failure` logs the code, context, and cause — main-process only.
      logger.failure('handler threw', error, { channel })
      return { ok: false, error: toEnvelope(error) }
    }
  })
}

/**
 * Removes every registered handler. Used between test cases and on teardown;
 * `ipcMain.handle` throws on a duplicate registration, so a second `registerAll`
 * without this would fail rather than replace.
 */
export function removeAllHandlers(channels: readonly ChannelName[]): void {
  for (const channel of channels) ipcMain.removeHandler(channel)
}
