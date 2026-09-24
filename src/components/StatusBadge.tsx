import type { IQSourceState } from '../iq/IQSource'
import styles from './StatusBadge.module.css'

type StatusState = IQSourceState | 'none'

const LABELS: Record<StatusState, string> = {
  none: '未接続',
  closed: '停止',
  opening: '接続中',
  open: '待機',
  starting: '開始中',
  running: '受信中',
  stopping: '停止中',
  error: 'エラー',
}

const TONES: Record<StatusState, 'default' | 'good' | 'warn' | 'bad'> = {
  none: 'default',
  closed: 'default',
  opening: 'warn',
  open: 'default',
  starting: 'warn',
  running: 'good',
  stopping: 'warn',
  error: 'bad',
}

export interface StatusBadgeProps {
  state: StatusState
  label?: string
}

export function StatusBadge({ state, label }: StatusBadgeProps) {
  return (
    <span className={[styles.badge, styles[TONES[state]]].join(' ')} data-state={state}>
      <span className={styles.dot} />
      {label ?? LABELS[state]}
    </span>
  )
}
