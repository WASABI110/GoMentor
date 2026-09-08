import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolStep } from '../state/chatStore'
import {
  ARGS_PREVIEW_LIMIT,
  RESULT_PREVIEW_LIMIT,
  looksLikeErrorResult,
  summariseText,
} from './tool-steps'
import { Button } from './ui'

/**
 * The tool steps of one assistant turn (M3 Stage 3, R5).
 *
 * Each `tool_call` the agent loop made becomes a row — tool name plus its
 * arguments — and the matching `tool_result` fills in what came back. Used for
 * both halves of the display: while a run streams, the rows are its in-flight
 * calls; on a finished turn they are the steps `chatStore` filed under that
 * message, so the transcript keeps showing what the teacher did after the
 * answer lands.
 *
 * ## The rows render main- and model-produced identifiers verbatim
 *
 * A tool *name* is one of the three registry names, and the payloads are JSON
 * main or the model wrote — data, not prose. They are therefore not translated,
 * and they reach the DOM as `<code>` text nodes: the same escape-everything
 * property the transcript relies on for markdown, with no parser involved.
 *
 * Why the error marker is a shape read rather than a field: see
 * `tool-steps.ts`, next to the helper.
 */

interface ToolStepsProps {
  readonly steps: readonly ToolStep[]
}

export function ToolSteps({ steps }: ToolStepsProps): React.JSX.Element | null {
  const { t } = useTranslation('teacher')
  if (steps.length === 0) return null

  return (
    <ol className="chat-steps" data-testid="chat-steps" aria-label={t('steps.title')}>
      {steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
    </ol>
  )
}

function StepRow({ step }: { readonly step: ToolStep }): React.JSX.Element {
  const { t } = useTranslation('teacher')
  const args = summariseText(step.argumentsText, ARGS_PREVIEW_LIMIT)

  return (
    <li className="chat-step" data-testid="chat-step" data-tool={step.name}>
      <span className="chat-step__name">{step.name}</span>
      {step.argumentsText !== '' && (
        <code className="chat-step__args" data-testid="chat-step-args">
          {args}
        </code>
      )}
      {step.resultText === undefined ? (
        <span className="chat-step__pending" data-testid="chat-step-pending">
          {t('steps.running')}
        </span>
      ) : (
        <StepResult content={step.resultText} />
      )}
    </li>
  )
}

function StepResult({ content }: { readonly content: string }): React.JSX.Element {
  const { t } = useTranslation('teacher')
  const [expanded, setExpanded] = useState(false)
  const truncated = content.length > RESULT_PREVIEW_LIMIT
  const shown =
    expanded || !truncated ? content : summariseText(content, RESULT_PREVIEW_LIMIT)

  return (
    <span
      className={`chat-step__result${
        looksLikeErrorResult(content) ? ' chat-step__result--error' : ''
      }`}
    >
      <code data-testid="chat-step-result">{shown}</code>
      {truncated && (
        <Button
          type="button"
          className="button chat-step__toggle"
          data-testid="chat-step-result-toggle"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current)
          }}
        >
          {expanded ? t('steps.collapse') : t('steps.expand')}
        </Button>
      )}
    </span>
  )
}
