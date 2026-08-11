import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Last resort for a render fault.
 *
 * ## What this is *not* for
 *
 * Not for IPC failures. A bridge call resolves to `{ ok: false, error }` rather
 * than throwing (`directory-structure.md` §Forbidden patterns), so every domain
 * failure is already a state a panel renders. If a failed `settings:get` reached
 * this boundary, that would mean somebody wrapped a bridge call in a `throw`, and
 * the fix is there, not here.
 *
 * What does reach here is a genuine programming error during render — an undefined
 * field dereferenced in a panel, a bad hook call. Without a boundary React 19
 * unmounts the whole tree and leaves a blank window, which looks to a user exactly
 * like the app failing to start.
 *
 * ## The caught error is logged, not displayed
 *
 * A render fault's `message` and `stack` can carry values from the record being
 * drawn — coordinates, player names, and in the worst case a fragment of the SGF
 * itself. `logging-guidelines.md` forbids game records in logs and forbids stack
 * traces crossing to the renderer; the same reasoning applies to painting one into
 * the DOM, where a screenshot in a bug report would carry it further than any log
 * would. So the user gets a localised sentence, and `console.error` — which stays
 * in the renderer's own devtools and is never shipped — gets the detail a developer
 * needs.
 *
 * Class component because that is the only form React gives for `componentDidCatch`;
 * there is no hook equivalent.
 */

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Renderer devtools only. Not sent to main's logger: that would put the stack
    // and component tree into a file on disk, which is what the guideline above
    // rules out.
    console.error('render fault', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) return <RenderFault />
    return this.props.children
  }
}

/**
 * The fallback, as a function component so it can use `useTranslation`.
 *
 * `errors:title` and `errors:unknown` rather than a new pair of keys: the sentence
 * a user needs here is the same one any unrecognised failure gets, and adding
 * keys that only this path uses would leave them untranslated in every locale
 * added later without anything noticing — `check-i18n.ts` would pass, since it
 * compares catalogues to each other.
 */
function RenderFault(): React.JSX.Element {
  const { t } = useTranslation('errors')

  return (
    <div className="render-fault" role="alert" data-testid="render-fault">
      <h1>{t('title')}</h1>
      <p>{t('unknown')}</p>
    </div>
  )
}
