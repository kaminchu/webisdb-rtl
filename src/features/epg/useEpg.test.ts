import { describe, expect, it } from 'vitest'
import type { Event, Service } from '../../models'
import { buildProgramGuide } from './useEpg'

const NOW = new Date('2026-01-01T03:00:00.000Z')

function makeEvent(overrides: Partial<Event>): Event {
  return {
    eventId: 1,
    serviceId: 1,
    startTime: NOW,
    duration: 3600,
    title: '番組',
    ...overrides,
  }
}

describe('buildProgramGuide', () => {
  it('merges, dedupes, filters and groups events by service', () => {
    const services: Service[] = [
      { serviceId: 1, name: 'NHK総合' },
      { serviceId: 2, name: 'Eテレ' },
    ]
    const events: Event[] = [
      makeEvent({
        eventId: 1,
        serviceId: 1,
        startTime: new Date(NOW.getTime() - 30 * 60_000),
        title: 'A',
        running: true,
      }),
      makeEvent({
        eventId: 1,
        serviceId: 1,
        startTime: new Date(NOW.getTime() - 30 * 60_000),
        title: 'A-old',
        running: false,
        updatedAt: new Date(NOW.getTime() + 1000),
      }),
      makeEvent({
        eventId: 2,
        serviceId: 1,
        startTime: new Date(NOW.getTime() + 30 * 60_000),
        title: 'B',
      }),
      makeEvent({
        eventId: 3,
        serviceId: 2,
        startTime: new Date(NOW.getTime() + 10 * 3_600_000),
        title: 'far',
      }),
      makeEvent({
        eventId: 4,
        serviceId: 1,
        startTime: new Date(NOW.getTime() - 5 * 3_600_000),
        title: 'past',
      }),
    ]

    const guide = buildProgramGuide(events, services, { now: NOW, hours: 6, pastHours: 1 })

    expect(guide.total).toBe(2)
    expect(guide.groups).toHaveLength(1)
    expect(guide.groups[0].serviceName).toBe('NHK総合')
    expect(guide.groups[0].events.map((event) => event.title)).toEqual(['A', 'B'])
  })

  it('falls back to a generated name for unknown services', () => {
    const guide = buildProgramGuide([makeEvent({ serviceId: 9 })], [], { now: NOW })
    expect(guide.groups[0].serviceName).toBe('サービス 9')
  })

  it('returns an empty guide when there are no events', () => {
    const guide = buildProgramGuide([], [], { now: NOW })
    expect(guide.groups).toHaveLength(0)
    expect(guide.total).toBe(0)
  })
})
