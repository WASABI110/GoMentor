import { useTranslation } from 'react-i18next'
import type { ErrorEnvelope } from '@gomentor/shared'

/**
 * An error envelope, rendered as a localised sentence.
 *
 * ## `code` is the message; `message` is not
 *
 * `directory-structure.md` §Forbidden patterns: "Never render a raw error
 * `message` as primary UI text." The envelope's `message` is developer-facing and
 * may interpolate a filesystem path or a value read from the user's file, so it is
 * a log payload, not UI copy. The `code` is the only field with a translation, and
 * the fallback for an unrecognised one is `errors:unknown` rather than the raw
 * message — a code this build does not know is still not a licence to print
 * whatever main happened to put in the string.
 *
 * `title` is set as the tooltip deliberately: it is the same localised sentence,
 * not the untranslated message. There is nowhere in this component that the
 * developer text reaches the DOM.
 */
export function ErrorNotice({ error }: { error: ErrorEnvelope }): React.JSX.Element {
  const { t } = useTranslation('errors')

  // `defaultValue` rather than a `??`: i18next returns the key itself for a miss,
  // so a `??` would never fire and the user would see `code.SOMETHING_NEW`.
  const text = t(`code.${error.code}`, { defaultValue: t('unknown') })

  return (
    <p className="error-notice" role="alert" data-testid="error-notice" title={text}>
      {text}
    </p>
  )
}
