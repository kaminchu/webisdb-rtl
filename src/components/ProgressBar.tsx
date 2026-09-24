import styles from './ProgressBar.module.css'

export interface ProgressBarProps {
  value: number
  label?: string
  tone?: 'default' | 'good' | 'warn' | 'bad'
}

export function ProgressBar({ value, label, tone = 'default' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  return (
    <div className={styles.wrap}>
      {label && <span className={styles.label}>{label}</span>}
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 100)}
        aria-label={label}
      >
        <div
          className={[styles.fill, styles[tone]].join(' ')}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </div>
  )
}
