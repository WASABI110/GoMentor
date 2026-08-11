import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../state/chatStore'
import { useGameStore } from '../state/gameStore'
import { ErrorNotice } from '../components/ErrorNotice'

/**
 * The teacher conversation.
 *
 * ## The draft is local state, and the transcript is not
 *
 * What the user is typing belongs to this component: nothing else reads it, it
 * does not survive a panel unmount in any useful sense, and putting it in the
 * store would re-render every subscriber on each keystroke. The transcript,
 * `streaming`, and `status` are in `chatStore` because a delta arriving from main
 * must reach them whether or not this panel is mounted.
 *
 * ## `streaming` renders as its own node, not appended into `messages`
 *
 * A partial answer is not a message yet — `finishRun('aborted')` and `failRun`
 * both discard it. Appending it to the transcript optimistically would leave a
 * truncated assistant turn behind on cancel, which the next `send` would then
 * submit as history and the model would treat as something it had actually said.
 */
export function TeacherPanel(): React.JSX.Element {
  const { t } = useTranslation(['teacher', 'common'])
  const [draft, setDraft] = useState('')

  const messages = useChatStore((state) => state.messages)
  const streaming = useChatStore((state) => state.streaming)
  const status = useChatStore((state) => state.status)
  const error = useChatStore((state) => state.error)
  const send = useChatStore((state) => state.send)
  const cancel = useChatStore((state) => state.cancel)

  const gameId = useGameStore((state) => state.game?.id)
  const cursor = useGameStore((state) => state.cursor)

  const activeRunId = useChatStore((state) => state.activeRunId)
  const busy = status === 'streaming'

  function submit(): void {
    const content = draft.trim()
    // An empty prompt is not an error to report, just nothing to do — and
    // `llm:sendMessage` requires `content.min(1)`, so sending it would come back
    // as IPC_INVALID_REQUEST and read to the user as a failure they caused.
    if (content === '' || busy) return
    setDraft('')
    void send(
      content,
      // Context only when a record is open. `moveNumber` is the cursor, so the
      // teacher is asked about the position on screen rather than about the end
      // of the game.
      gameId === undefined ? undefined : { gameId, moveNumber: cursor },
    )
  }

  return (
    <aside
      className="panel panel--teacher"
      data-testid="teacher-panel"
      // The run the visible partial answer belongs to. In the DOM rather than only
      // in the store because it is genuinely part of what this panel is showing —
      // "these tokens are from run X" — and because the alternative considered was
      // exposing the store on `window` for the e2e spec, which is a test-only
      // backdoor into renderer state and would be dead weight in a packaged build
      // where `import.meta.env.DEV` is false. An attribute is inert, is the same in
      // every build, and carries no secret: a runId is a UUID main issued, not
      // user content.
      data-run-id={activeRunId ?? ''}
    >
      <h2>{t('teacher:title')}</h2>

      {error !== null && <ErrorNotice error={error} />}

      {messages.length === 0 && streaming === '' ? (
        <p className="placeholder" data-testid="teacher-empty">
          {t('teacher:empty')}
        </p>
      ) : (
        <ol className="chat-log" data-testid="chat-log">
          {messages.map((message) => (
            <li key={message.id} className={`chat-turn chat-turn--${message.role}`}>
              <span className="chat-turn__role">
                {message.role === 'user'
                  ? t('teacher:role.user')
                  : t('teacher:role.assistant')}
              </span>
              <span className="chat-turn__content">{message.content}</span>
            </li>
          ))}
          {streaming !== '' && (
            <li className="chat-turn chat-turn--assistant" data-testid="chat-streaming">
              <span className="chat-turn__role">{t('teacher:role.assistant')}</span>
              <span className="chat-turn__content">{streaming}</span>
            </li>
          )}
        </ol>
      )}

      {busy && streaming === '' && (
        <p className="placeholder" data-testid="teacher-thinking">
          {t('teacher:thinking')}
        </p>
      )}

      <div className="chat-compose">
        <textarea
          className="chat-input"
          data-testid="chat-input"
          rows={3}
          value={draft}
          placeholder={t('teacher:placeholder')}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line. `isComposing` guards the
            // IME: a Chinese or Japanese user pressing Enter to accept candidate
            // characters would otherwise submit a half-typed prompt.
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            className="button"
            data-testid="chat-stop"
            onClick={() => {
              void cancel()
            }}
          >
            {t('teacher:stop')}
          </button>
        ) : (
          <button
            type="button"
            className="button"
            data-testid="chat-send"
            disabled={draft.trim() === ''}
            onClick={submit}
          >
            {t('teacher:send')}
          </button>
        )}
      </div>
    </aside>
  )
}
