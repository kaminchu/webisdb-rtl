import styles from './Spinner.module.css'

export interface SpinnerProps {
  size?: 'sm' | 'md'
  label?: string
  className?: string
}

export function Spinner({ size = 'sm', label = '読み込み中', className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={[styles.spinner, styles[size], className].filter(Boolean).join(' ')}
    />
  )
}
