import type { ReactNode } from 'react'
import styles from './Panel.module.css'

export interface PanelProps {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}

export function Panel({ title, actions, children, className }: PanelProps) {
  return (
    <section className={[styles.panel, className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  )
}
