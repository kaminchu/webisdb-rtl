import { Button } from '../../components/Button'
import type { Event } from '../../models'
import { formatDuration, formatJstRange } from './time'
import styles from './ProgramModal.module.css'

export interface ProgramModalProps {
  event: Event
  serviceName: string
  onClose(): void
  onWatch(): void
}

export function ProgramModal({ event, serviceName, onClose, onWatch }: ProgramModalProps) {
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="番組情報"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{event.title || '（タイトルなし）'}</h2>
          <button type="button" className={styles.close} aria-label="閉じる" onClick={onClose}>
            ×
          </button>
        </header>

        <dl className={styles.meta}>
          <div>
            <dt>チャンネル</dt>
            <dd>{serviceName}</dd>
          </div>
          <div>
            <dt>放送時間</dt>
            <dd>{formatJstRange(event.startTime, event.duration)}</dd>
          </div>
          <div>
            <dt>長さ</dt>
            <dd>{formatDuration(event.duration)}</dd>
          </div>
          {event.running && (
            <div>
              <dt>状態</dt>
              <dd className={styles.running}>放送中</dd>
            </div>
          )}
        </dl>

        <p className={styles.description}>{event.description || '番組の詳細情報はありません。'}</p>

        <div className={styles.actions}>
          <Button type="button" onClick={onClose}>
            閉じる
          </Button>
          <Button type="button" variant="primary" onClick={onWatch}>
            このチャンネルを視聴する
          </Button>
        </div>
      </div>
    </div>
  )
}
