import { describe, expect, it } from 'vitest'
import type { Event } from '../../models'
import { createMemoryKeyValueStore } from '../db'
import { EventRepository, pruneExpiredEvents } from './events'

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
