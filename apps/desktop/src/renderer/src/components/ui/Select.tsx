import type { SelectHTMLAttributes } from 'react'

/**
 * Select primitive.
 */
export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select className={`ui-select ${className}`} {...props}>
      {children}
    </select>
  )
}
