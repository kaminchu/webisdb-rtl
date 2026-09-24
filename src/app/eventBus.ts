/** Minimal typed event bus for decoupled app-wide notifications. */

export type EventMap = Record<string, unknown>

export type Handler<T> = (payload: T) => void

export class EventBus<M extends EventMap> {
  #handlers = new Map<keyof M, Set<Handler<never>>>()

  on<K extends keyof M>(event: K, handler: Handler<M[K]>): () => void {
    let set = this.#handlers.get(event)
    if (!set) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    set.add(handler as Handler<never>)
    return () => set.delete(handler as Handler<never>)
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.#handlers.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        ;(handler as Handler<M[K]>)(payload)
      } catch (error) {
        console.error(`[eventBus] handler for "${String(event)}" threw`, error)
      }
    }
  }

  clear(): void {
    this.#handlers.clear()
  }
}
