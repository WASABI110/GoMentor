import type { InputHTMLAttributes } from 'react'

/**
 * Text input primitive.
 *
 * Forwards all native props so call sites keep full control over validation,
 * auto-complete, and keyboard handling.
 */
export function Input({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input className={`ui-input ${className}`} {...props} />
}
