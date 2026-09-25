import type { Event, EventQuery } from '../../models'
import { EventIndex, StoreName, toEpochMs, type KeyValueStore } from '../db'

/** How long after a program ends it is kept for catch-up display. */
export const DEFAULT_EVENT_RETENTION_MS = 0

export function eventKey(event: Event): [number, number] {
  return [event.serviceId, event.eventId]
}

export function eventEndMs(event: Event): number {
  return toEpochMs(event.startTime) + event.duration * 1000
}

function updatedAtMs(event: Event): number {
  return event.updatedAt ? toEpochMs(event.updatedAt) : 0
}

/**
 * Resolve time overlaps, preferring newer `updatedAt` and, on a tie, the event
 * that appears later in the input. Callers put fresh EIT after cached history so
 * an updated copy always wins its time slot.
 */
export function resolveEventOverlaps(events: Event[]): Event[] {
  const ranked = events.map((event, order) => ({ event, order }))
  ranked.sort((a, b) => toEpochMs(a.event.startTime) - toEpochMs(b.event.startTime))
  const result: { event: Event; order: number }[] = []
  for (const candidate of ranked) {
    const previous = result[result.length - 1]
    if (previous && toEpochMs(candidate.event.startTime) < eventEndMs(previous.event)) {
      const candidateUpdated = updatedAtMs(candidate.event)
      const previousUpdated = updatedAtMs(previous.event)
      const preferNew =
        candidateUpdated !== previousUpdated
          ? candidateUpdated > previousUpdated
          : candidate.order > previous.order
      if (preferNew) result[result.length - 1] = candidate
      continue
    }
    result.push(candidate)
  }
  return result.map((entry) => entry.event)
}

/**
 * Merge a fresh EIT snapshot with cached history. Non-overlapping cached events
 * are kept, while a cached event that overlaps a fresh one is dropped in favour
 * of the fresh copy, so updates never duplicate a time slot.
 */
export function mergeEitSnapshot(cached: Event[], fresh: Event[]): Event[] {
  if (fresh.length === 0) return cached
  return resolveEventOverlaps([...cached, ...fresh])
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

  /**
   * Merge a fresh EIT snapshot into the cache: programs before the snapshot are
   * preserved, the rest is replaced, and time overlaps prefer the fresh copy.
   */
  async replaceEventsForServices(events: Event[]): Promise<void> {
    if (events.length === 0) return
    const byService = new Map<number, Event[]>()
    for (const event of events) {
      const list = byService.get(event.serviceId) ?? []
      list.push(event)
      byService.set(event.serviceId, list)
    }
    for (const [serviceId, fresh] of byService) {
      const cached = await this.queryEvents({ serviceId })
      const merged = mergeEitSnapshot(cached, fresh)
      await this.deleteEventsForService(serviceId)
      await this.putEvents(merged)
    }
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
