import { describe, expect, it } from 'vitest'
import type { Event } from '../../models'
import { createMemoryKeyValueStore } from '../db'
import {
  EventRepository,
  mergeEitSnapshot,
  pruneExpiredEvents,
  resolveEventOverlaps,
} from './events'

function makeEvent(overrides: Partial<Event> & { serviceId: number; eventId: number }): Event {
  return {
    startTime: new Date('2026-01-01T00:00:00Z'),
    duration: 1800,
    title: `event ${overrides.eventId}`,
    ...overrides,
  }
}

function createRepo() {
  const store = createMemoryKeyValueStore()
  return { store, repo: new EventRepository(store) }
}

describe('resolveEventOverlaps', () => {
  it('drops the older copy when two events overlap', () => {
    const older = makeEvent({
      serviceId: 1,
      eventId: 1,
      title: 'older',
      startTime: new Date('2026-01-01T01:00:00Z'),
      duration: 3600,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const newer = makeEvent({
      serviceId: 1,
      eventId: 2,
      title: 'newer',
      startTime: new Date('2026-01-01T01:30:00Z'),
      duration: 1800,
      updatedAt: new Date('2026-01-01T02:00:00Z'),
    })
    expect(resolveEventOverlaps([older, newer]).map((event) => event.title)).toEqual(['newer'])
  })

  it('keeps non-overlapping events in start order', () => {
    const first = makeEvent({
      serviceId: 1,
      eventId: 1,
      startTime: new Date('2026-01-01T01:00:00Z'),
      duration: 1800,
    })
    const second = makeEvent({
      serviceId: 1,
      eventId: 2,
      startTime: new Date('2026-01-01T02:00:00Z'),
      duration: 1800,
    })
    expect(resolveEventOverlaps([second, first]).map((event) => event.eventId)).toEqual([1, 2])
  })
})

describe('mergeEitSnapshot', () => {
  const cached = [
    makeEvent({
      serviceId: 1,
      eventId: 1,
      title: 'history',
      startTime: new Date('2026-01-01T00:00:00Z'),
      duration: 1800,
    }),
    makeEvent({
      serviceId: 1,
      eventId: 2,
      title: 'future stale',
      startTime: new Date('2026-01-01T03:00:00Z'),
      duration: 1800,
    }),
  ]

  it('keeps non-overlapping cache and adds the fresh snapshot', () => {
    const fresh = [
      makeEvent({
        serviceId: 1,
        eventId: 9,
        title: 'fresh',
        startTime: new Date('2026-01-01T01:00:00Z'),
        duration: 1800,
      }),
    ]
    const merged = mergeEitSnapshot(cached, fresh)
    expect(merged.map((event) => event.title).toSorted()).toEqual([
      'fresh',
      'future stale',
      'history',
    ])
  })

  it('prefers the fresh copy when it overlaps cached history', () => {
    const merged = mergeEitSnapshot(cached, [
      makeEvent({
        serviceId: 1,
        eventId: 9,
        title: 'fresh',
        startTime: new Date('2026-01-01T03:00:00Z'),
        duration: 1800,
        updatedAt: new Date('2026-01-01T03:00:00Z'),
      }),
    ])
    expect(merged.map((event) => event.title).toSorted()).toEqual(['fresh', 'history'])
  })

  it('returns the cache unchanged when the snapshot is empty', () => {
    expect(mergeEitSnapshot(cached, [])).toBe(cached)
  })
})

describe('EventRepository', () => {
  it('queries all events ordered by start time', async () => {
    const { repo } = createRepo()
    await repo.putEvents([
      makeEvent({ serviceId: 1, eventId: 2, startTime: new Date('2026-01-01T02:00:00Z') }),
      makeEvent({ serviceId: 1, eventId: 1, startTime: new Date('2026-01-01T01:00:00Z') }),
    ])
    const events = await repo.queryEvents()
    expect(events.map((event) => event.eventId)).toEqual([1, 2])
  })

  it('filters by service, time range and limit', async () => {
    const { repo } = createRepo()
    await repo.putEvents([
      makeEvent({ serviceId: 1, eventId: 1, startTime: new Date('2026-01-01T01:00:00Z') }),
      makeEvent({ serviceId: 1, eventId: 2, startTime: new Date('2026-01-01T05:00:00Z') }),
      makeEvent({ serviceId: 2, eventId: 3, startTime: new Date('2026-01-01T03:00:00Z') }),
    ])
    const filtered = await repo.queryEvents({
      serviceId: 1,
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-01T04:00:00Z'),
    })
    expect(filtered.map((event) => event.eventId)).toEqual([1])

    const limited = await repo.queryEvents({ limit: 2 })
    expect(limited).toHaveLength(2)
  })

  it('updates an event with the same service and event id', async () => {
    const { repo } = createRepo()
    await repo.putEvents([makeEvent({ serviceId: 1, eventId: 1, title: 'old' })])
    await repo.putEvents([makeEvent({ serviceId: 1, eventId: 1, title: 'new' })])
    const events = await repo.queryEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.title).toBe('new')
  })

  it('deletes events starting before a date', async () => {
    const { repo } = createRepo()
    await repo.putEvents([
      makeEvent({ serviceId: 1, eventId: 1, startTime: new Date('2026-01-01T01:00:00Z') }),
      makeEvent({ serviceId: 1, eventId: 2, startTime: new Date('2026-01-02T01:00:00Z') }),
    ])
    const removed = await repo.deleteEventsBefore(new Date('2026-01-01T12:00:00Z'))
    expect(removed).toBe(1)
    expect(await repo.queryEvents()).toHaveLength(1)
  })

  it('deletes every event for a service', async () => {
    const { repo } = createRepo()
    await repo.putEvents([
      makeEvent({ serviceId: 1, eventId: 1 }),
      makeEvent({ serviceId: 1, eventId: 2 }),
      makeEvent({ serviceId: 2, eventId: 3 }),
    ])
    expect(await repo.deleteEventsForService(1)).toBe(2)
    expect(await repo.queryEvents()).toHaveLength(1)
  })

  it('keeps the cache before the snapshot and replaces overlapping programs', async () => {
    const { repo } = createRepo()
    await repo.putEvents([
      makeEvent({
        serviceId: 1,
        eventId: 1,
        title: 'old history',
        startTime: new Date('2026-01-01T00:00:00Z'),
        duration: 1800,
      }),
      makeEvent({
        serviceId: 1,
        eventId: 2,
        title: 'stale overlapping',
        startTime: new Date('2026-01-01T01:00:00Z'),
        duration: 3600,
      }),
      makeEvent({
        serviceId: 3,
        eventId: 4,
        title: 'untouched service',
        startTime: new Date('2026-01-01T02:00:00Z'),
        duration: 1800,
      }),
    ])
    await repo.replaceEventsForServices([
      makeEvent({
        serviceId: 1,
        eventId: 9,
        title: 'fresh',
        startTime: new Date('2026-01-01T01:00:00Z'),
        duration: 1800,
      }),
    ])
    const events = await repo.queryEvents()
    expect(events.map((event) => event.title).toSorted()).toEqual([
      'fresh',
      'old history',
      'untouched service',
    ])
    expect(events.filter((event) => event.serviceId === 1).map((event) => event.eventId)).toEqual([
      1, 9,
    ])
  })

  it('keeps non-overlapping cached programs after the snapshot start', async () => {
    const { repo } = createRepo()
    await repo.putEvents([
      makeEvent({
        serviceId: 1,
        eventId: 1,
        title: 'later cached',
        startTime: new Date('2026-01-01T05:00:00Z'),
        duration: 1800,
      }),
    ])
    await repo.replaceEventsForServices([
      makeEvent({
        serviceId: 1,
        eventId: 9,
        title: 'fresh',
        startTime: new Date('2026-01-01T01:00:00Z'),
        duration: 1800,
      }),
    ])
    const events = await repo.queryEvents()
    expect(events.map((event) => event.title)).toEqual(['fresh', 'later cached'])
  })

  it('prefers the fresh copy when times overlap', async () => {
    const { repo } = createRepo()
    await repo.putEvents([
      makeEvent({
        serviceId: 1,
        eventId: 1,
        title: 'cached',
        startTime: new Date('2026-01-01T01:00:00Z'),
        duration: 3600,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ])
    await repo.replaceEventsForServices([
      makeEvent({
        serviceId: 1,
        eventId: 2,
        title: 'fresh',
        startTime: new Date('2026-01-01T01:30:00Z'),
        duration: 1800,
        updatedAt: new Date('2026-01-01T01:30:00Z'),
      }),
    ])
    const events = await repo.queryEvents()
    expect(events.map((event) => event.title)).toEqual(['fresh'])
  })
})

describe('pruneExpiredEvents', () => {
  const now = new Date('2026-01-01T12:00:00Z')

  it('removes events whose end time has passed', async () => {
    const store = createMemoryKeyValueStore()
    await new EventRepository(store).putEvents([
      makeEvent({
        serviceId: 1,
        eventId: 1,
        startTime: new Date('2026-01-01T10:00:00Z'),
        duration: 1800,
      }),
      makeEvent({
        serviceId: 1,
        eventId: 2,
        startTime: new Date('2026-01-01T11:30:00Z'),
        duration: 1800,
      }),
      makeEvent({
        serviceId: 1,
        eventId: 3,
        startTime: new Date('2026-01-01T13:00:00Z'),
        duration: 1800,
      }),
    ])
    expect(await pruneExpiredEvents(store, now)).toBe(1)
    const remaining = await new EventRepository(store).queryEvents()
    expect(remaining.map((event) => event.eventId)).toEqual([2, 3])
  })

  it('honours a retention window', async () => {
    const store = createMemoryKeyValueStore()
    await new EventRepository(store).putEvents([
      makeEvent({
        serviceId: 1,
        eventId: 1,
        startTime: new Date('2026-01-01T10:00:00Z'),
        duration: 1800,
      }),
      makeEvent({
        serviceId: 1,
        eventId: 2,
        startTime: new Date('2026-01-01T11:30:00Z'),
        duration: 1800,
      }),
    ])
    expect(await pruneExpiredEvents(store, now, 60 * 60 * 1000)).toBe(1)
    expect(await new EventRepository(store).queryEvents()).toHaveLength(1)
  })
})
