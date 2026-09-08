import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { ChatMessage } from '@gomentor/shared'
import { useChatStore } from '../state/chatStore'
import { useGameStore } from '../state/gameStore'
import { ErrorNotice } from './ErrorNotice'
import { ToolSteps } from './ToolSteps'
import { Button } from './ui'

/**
 * The teacher conversation: transcript, streaming partial, and composer.
 *
 * ## Markdown is rendered as React elements, never as HTML
 *
 * Model output is untrusted input - the renderer's CSP and sandbox exist partly
 * because of what this panel displays. `react-markdown` parses to a tree and
 * emits React elements; raw HTML in the reply is escaped by default because no
 * `rehype-raw` plugin is configured. Do not add one, and do not hand-roll an
 * HTML renderer for the same content: the escape-everything default is the
 * security property, and it comes from the library doing less, not more.
 *
 * ## Links do not navigate
 *
 * The default `<a>` would navigate the whole BrowserWindow away from the app,
 * and M1 has no `shell:openExternal` channel to hand the URL to the OS instead.
 * The custom renderer keeps the anchor (so the URL is copyable and visible to
 * assistive tech) but swallows the click. When an open-external channel lands,
 * replace the `preventDefault` with the invoke - the component is the one place
 * that needs to change.
 *
 * ## Images render as their alt text
 *
 * CSP (`img-src 'self' data:`) already blocks remote images, so a default `<img>`
 * would paint a broken-image icon for every remote URL the model emits. Rendering
 * the alt text is the honest degradation, and it also keeps model output from
 * turning the transcript into a layout puzzle.
 *
 * ## User turns are plain text, assistant turns are markdown
 *
 * Rendering the user's own words as markdown would change what they typed -
 * `*emphasis*` becoming italic is a small thing, but the transcript's job is to
 * show what was sent. Only the assistant speaks markdown, and only the assistant
 * is rendered through the parser.
 */
const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault()
      }}
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="chat-md__image-alt">[{alt ?? 'image'}]</span>,
}

export function TeacherChat(): React.JSX.Element {
  const { t } = useTranslation(['teacher'])
  const [draft, setDraft] = useState('')

  const messages = useChatStore((state) => state.messages)
  const streaming = useChatStore((state) => state.streaming)
  const status = useChatStore((state) => state.status)
  const error = useChatStore((state) => state.error)
  const send = useChatStore((state) => state.send)
  const cancel = useChatStore((state) => state.cancel)
  const toolCalls = useChatStore((state) => state.toolCalls)
  const stepsByMessage = useChatStore((state) => state.stepsByMessage)

  const gameId = useGameStore((state) => state.game?.id)
  const cursor = useGameStore((state) => state.cursor)

  // `awaiting_tool` is part of busy: while a tool runs, the run is still
  // producing this answer, so the composer must keep showing Stop — and `send`
  // already refuses a second send in that state, so an enabled Send button
  // there would be a control that does nothing when clicked.
  const busy = status === 'streaming' || status === 'awaiting_tool'

  function submit(): void {
    const content = draft.trim()
    // An empty prompt is not an error to report, just nothing to do - and
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

  function turn(message: ChatMessage, extraClassName = ''): React.JSX.Element {
    return (
      <li
        key={message.id}
        className={`chat-turn chat-turn--${message.role} ${extraClassName}`}
      >
        <span className="chat-turn__role">
          {message.role === 'user'
            ? t('teacher:role.user')
            : t('teacher:role.assistant')}
        </span>
        {/* See the header note for why user text is not parsed as markdown. */}
        {message.role === 'user' ? (
          <span className="chat-turn__content">{message.content}</span>
        ) : (
          <div className="chat-turn__content chat-md">
            {/* The steps this turn's run performed, filed here by the store at
                `llm:done`. Above the prose: the answer is grounded in them, so
                the reading order is what the teacher did, then what it said. */}
            <ToolSteps steps={stepsByMessage[message.id] ?? []} />
            <ReactMarkdown components={markdownComponents}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </li>
    )
  }

  // The streaming turn exists while text is arriving *or* while the run is
  // working through tool calls that have produced no text yet — a tool-only
  // stretch is exactly when the step rows are the only visible progress.
  const showStreaming = streaming !== '' || toolCalls.length > 0

  return (
    <>
      {error !== null && <ErrorNotice error={error} />}

      {messages.length === 0 && !showStreaming ? (
        <p className="placeholder" data-testid="teacher-empty">
          {t('teacher:empty')}
        </p>
      ) : (
        <ol className="chat-log" data-testid="chat-log">
          {messages.map((message) => turn(message))}
          {showStreaming && (
            <li className="chat-turn chat-turn--assistant" data-testid="chat-streaming">
              <span className="chat-turn__role">{t('teacher:role.assistant')}</span>
              {/*
                The run's steps while they happen: a row appears the moment the
                model starts a tool call (arguments still arriving in fragments)
                and its result fills in when the loop reports it. The same rows
                move under the finished message at `llm:done`.
              */}
              <ToolSteps steps={toolCalls} />
              {/*
                The partial answer goes through the same renderer as a finished
                one. Parsing half-written markdown is well-defined - an unclosed
                `**` is text until its partner arrives - and using two renderers
                would make the text visibly "snap" at `llm:done` for reasons the
                user cannot attribute to anything.
              */}
              {streaming !== '' && (
                <div className="chat-turn__content chat-md">
                  <ReactMarkdown components={markdownComponents}>
                    {streaming}
                  </ReactMarkdown>
                </div>
              )}
            </li>
          )}
        </ol>
      )}

      {busy && !showStreaming && (
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
          <Button
            type="button"
            className="button"
            data-testid="chat-stop"
            onClick={() => {
              void cancel()
            }}
          >
            {t('teacher:stop')}
          </Button>
        ) : (
          <Button
            type="button"
            className="button"
            data-testid="chat-send"
            disabled={draft.trim() === ''}
            onClick={submit}
          >
            {t('teacher:send')}
          </Button>
        )}
      </div>
    </>
  )
}
