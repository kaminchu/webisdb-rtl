import { useEffect } from 'react'
import { AUTO_DISMISS_MS, dismissNotification } from '../app/notifications'
import { useStore, type AppNotification } from '../app/store'
import styles from './ErrorToaster.module.css'

interface ErrorToastProps {
  notification: AppNotification
}

function ErrorToast({ notification }: ErrorToastProps) {
  const { id, context, message, count } = notification
  return (
    <div className={styles.item} role="alert">
      <div className={styles.body}>
        <span className={styles.context}>{context}</span>
        <span className={styles.message}>{message}</span>
        {count > 1 && <span className={styles.count}>×{count}</span>}
      </div>
      <button
        type="button"
        className={styles.close}
        aria-label="閉じる"
        onClick={() => dismissNotification(id)}
      >
        ×
      </button>
    </div>
  )
}

export function ErrorToaster() {
  const notifications = useStore((s) => s.notifications)
  const latest = notifications.at(-1)

  useEffect(() => {
    if (!latest) return
    const timer = setTimeout(() => dismissNotification(latest.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [latest])

  if (notifications.length === 0) return null
  return (
    <div className={styles.list} aria-live="polite">
      {notifications.map((notification) => (
        <ErrorToast key={notification.id} notification={notification} />
      ))}
    </div>
  )
}
