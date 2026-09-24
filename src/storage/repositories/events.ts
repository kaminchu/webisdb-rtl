import type { Event, EventQuery } from '../../models'
import { EventIndex, StoreName, toEpochMs, type KeyValueStore } from '../db'

/** How long after a program ends it is kept for catch-up display. */
export const DEFAULT_EVENT_RETENTION_MS = 0

export function eventKey(event: Event): [number, number] {
  return [event.serviceId, event.eventId]
}

export class EventRepository {
  readonly #store: KeyValueStore

  constructor(store: KeyValueStore) {
    this.#store = store
  }

  async putEvents(events: Event[]): Promise<void> {
    if (events.length === 0) return
    await this.#store.putAll(StoreName.Events, events)
  }

  async queryEvents(query: EventQuery = {}): Promise<Event[]> {
    const events =
      query.serviceId !== undefined
        ? await this.#store.getAllByIndex<Event>(StoreName.Events, EventIndex.ServiceId, {
            only: query.serviceId,
          })
        : await this.#store.getAll<Event>(StoreName.Events)

    const from = query.from ? query.from.getTime() : undefined
    const to = query.to ? query.to.getTime() : undefined

    const filtered = events.filter((event) => {
      const start = toEpochMs(event.startTime)
      if (from !== undefined && start < from) return false
      if (to !== undefined && start > to) return false
      return true
    })
    filtered.sort((a, b) => toEpochMs(a.startTime) - toEpochMs(b.startTime))
    return query.limit !== undefined ? filtered.slice(0, query.limit) : filtered
  }

  deleteEventsBefore(date: Date): Promise<number> {
    return this.#store.deleteByIndex(StoreName.Events, EventIndex.StartTime, {
      upper: date,
      upperOpen: true,
    })
  }

  deleteEventsForService(serviceId: number): Promise<number> {
    return this.#store.deleteByIndex(StoreName.Events, EventIndex.ServiceId, {
      only: serviceId,
    })
  }
}

export async function pruneExpiredEvents(
  store: KeyValueStore,
  now: Date = new Date(),
  retentionMs: number = DEFAULT_EVENT_RETENTION_MS,
): Promise<number> {
  const cutoff = now.getTime() - retentionMs
  const events = await store.getAll<Event>(StoreName.Events)
  let removed = 0
  for (const event of events) {
    const end = toEpochMs(event.startTime) + event.duration * 1000
    if (end < cutoff) {
      await store.delete(StoreName.Events, eventKey(event))
      removed++
    }
  }
  return removed
}
