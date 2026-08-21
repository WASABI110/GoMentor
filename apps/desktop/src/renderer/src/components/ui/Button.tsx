import type { ButtonHTMLAttributes } from 'react'

/**
 * Primary action button primitive.
 *
 * The component is intentionally thin: it forwards every native prop and only
 * supplies the project's button styling. That keeps the escape hatch wide open
 * (a caller can still pass `className` to override) while making the common
 * path consistent.
 */
export function Button({
  className = '',
  type = 'button',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button type={type} className={`ui-button ${className}`} {...props}>
      {children}
    </button>
  )
}
