import { store, type AppNotification } from './store'

/** On-screen error lifetime before it dismisses itself. */
export const AUTO_DISMISS_MS = 8000
const MAX_NOTIFICATIONS = 5

let nextId = 1

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const result = new Error(String((error as { message: unknown }).message))
    const stack = (error as { stack?: unknown }).stack
    if (typeof stack === 'string') result.stack = stack
    return result
  }
  return new Error(String(error))
}

/**
 * Log an error to the console and queue it for the bottom-left error list.
 * Identical errors are collapsed into a single entry with a repeat count.
 */
export function reportError(context: string, error: unknown): void {
  const normalized = toError(error)
  console.error(`[${context}]`, normalized)
  const message = normalized.message
  const at = Date.now()
  store.setState((prev) => {
    const existing = prev.notifications.find(
      (item) => item.context === context && item.message === message,
    )
    if (existing) {
      return {
        notifications: prev.notifications.map((item) =>
          item.id === existing.id ? { ...item, count: item.count + 1, at } : item,
        ),
      }
    }
    const notification: AppNotification = {
      id: nextId++,
      context,
      message,
      count: 1,
      at,
    }
    return { notifications: [...prev.notifications, notification].slice(-MAX_NOTIFICATIONS) }
  })
}

export function dismissNotification(id: number): void {
  store.setState((prev) => ({
    notifications: prev.notifications.filter((item) => item.id !== id),
  }))
}
