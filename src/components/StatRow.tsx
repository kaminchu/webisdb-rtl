import type { ReactNode } from 'react'
import styles from './StatRow.module.css'

export interface StatRowProps {
  label: ReactNode
  value: ReactNode
}

export function StatRow({ label, value }: StatRowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  )
}
