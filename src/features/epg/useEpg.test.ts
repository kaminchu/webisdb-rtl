import { describe, expect, it } from 'vitest'
import type { ConfiguredChannel, Event } from '../../models'
import { accumulateLiveEvents, buildChannelGuide, groupServiceIdsByChannel } from './useEpg'

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

const channel = (
  overrides: Partial<ConfiguredChannel> & { physicalChannel: number },
): ConfiguredChannel => overrides

describe('buildChannelGuide', () => {
  it('keeps every configured channel even without events', () => {
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 13, name: 'NHK Eテレ' }), channel({ physicalChannel: 15 })],
      [],
      new Map(),
      new Map(),
      { now: NOW },
    )
    expect(guide.entries).toHaveLength(2)
    expect(guide.entries[0].serviceName).toBe('NHK Eテレ')
    expect(guide.entries[1].serviceName).toBe('ch 15')
    expect(guide.total).toBe(0)
  })

  it('attaches events by configured service id within the window', () => {
    const events = [
      makeEvent({ eventId: 1, serviceId: 10, title: 'A', running: true }),
      makeEvent({
        eventId: 2,
        serviceId: 10,
        title: 'far',
        startTime: new Date(NOW.getTime() + 10 * 3_600_000),
      }),
      makeEvent({
        eventId: 3,
        serviceId: 10,
        title: 'past',
        startTime: new Date(NOW.getTime() - 5 * 3_600_000),
      }),
    ]
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 17, serviceId: 10, name: 'BSN' })],
      events,
      new Map(),
      new Map(),
      { now: NOW, hours: 6, pastHours: 1 },
    )
    expect(guide.entries[0].events.map((event) => event.title)).toEqual(['A'])
    expect(guide.total).toBe(1)
  })

  it('shows every fetched event and sizes the range to it in auto mode', () => {
    const events = [
      makeEvent({ eventId: 1, serviceId: 10, title: 'now', running: true }),
      makeEvent({
        eventId: 2,
        serviceId: 10,
        title: 'far',
        startTime: new Date(NOW.getTime() + 10 * 3_600_000),
      }),
      makeEvent({
        eventId: 3,
        serviceId: 10,
        title: 'past',
        startTime: new Date(NOW.getTime() - 2 * 3_600_000),
      }),
    ]
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 17, serviceId: 10, name: 'BSN' })],
      events,
      new Map(),
      new Map(),
      { now: NOW, auto: true },
    )
    expect(guide.entries[0].events.map((event) => event.title)).toEqual(['past', 'now', 'far'])
    expect(guide.rangeStart.getTime()).toBe(NOW.getTime() - 2 * 3_600_000)
    expect(guide.rangeEnd.getTime()).toBe(NOW.getTime() + 11 * 3_600_000)
  })

  it('falls back to the fixed window in auto mode with no events', () => {
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 17, serviceId: 10 })],
      [],
      new Map(),
      new Map(),
      { now: NOW, auto: true, hours: 2, pastHours: 1 },
    )
    expect(guide.rangeStart.getTime()).toBe(NOW.getTime() - 3_600_000)
    expect(guide.rangeEnd.getTime()).toBe(NOW.getTime() + 2 * 3_600_000)
  })

  it('uses scan-discovered service ids for a channel', () => {
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 19 })],
      [makeEvent({ eventId: 4, serviceId: 99, title: 'NST' })],
      new Map([[99, 'NST新潟総合テレビ']]),
      new Map([[19, [99]]]),
      { now: NOW },
    )
    expect(guide.entries[0].serviceName).toBe('NST新潟総合テレビ')
    expect(guide.entries[0].events).toHaveLength(1)
  })

  it('keeps events for a previously viewed channel via stored services', () => {
    const channels = [channel({ physicalChannel: 19 })]
    const serviceIds = groupServiceIdsByChannel({
      channels,
      scanServices: new Map(),
      storedServices: [{ serviceId: 99, name: 'NST', physicalChannel: 19 }],
      liveChannel: 13,
      liveServices: [],
    })
    const guide = buildChannelGuide(
      channels,
      [makeEvent({ eventId: 4, serviceId: 99, title: 'NST' })],
      new Map([[99, 'NST']]),
      serviceIds,
      { now: NOW },
    )
    expect(guide.entries[0].events).toHaveLength(1)
    expect(guide.entries[0].events[0].title).toBe('NST')
  })

  it('attaches the simple station logo per channel', () => {
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 19, serviceId: 99 })],
      [],
      new Map([[99, 'NST新潟総合テレビ']]),
      new Map(),
      { now: NOW, serviceLogos: new Map([[99, 'NST']]) },
    )
    expect(guide.entries[0].serviceName).toBe('NST新潟総合テレビ')
    expect(guide.entries[0].logo).toBe('NST')
  })

  it('falls back to another known service id for the logo', () => {
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 19 })],
      [],
      new Map(),
      new Map([[19, [99]]]),
      { now: NOW, serviceLogos: new Map([[99, 'NST']]) },
    )
    expect(guide.entries[0].logo).toBe('NST')
  })

  it('merges duplicate events preferring the running copy', () => {
    const guide = buildChannelGuide(
      [channel({ physicalChannel: 13, serviceId: 1 })],
      [
        makeEvent({ eventId: 1, serviceId: 1, title: 'A-old', running: false }),
        makeEvent({
          eventId: 1,
          serviceId: 1,
          title: 'A',
          running: true,
          updatedAt: new Date(NOW.getTime() + 1000),
        }),
      ],
      new Map(),
      new Map(),
      { now: NOW },
    )
    expect(guide.entries[0].events.map((event) => event.title)).toEqual(['A'])
  })
})

describe('accumulateLiveEvents', () => {
  it('returns the current list untouched when nothing new arrives', () => {
    const current = [makeEvent({ eventId: 1 })]
    expect(accumulateLiveEvents(current, [])).toBe(current)
  })

  it('appends and de-duplicates events by service and event id', () => {
    const current = [makeEvent({ eventId: 1, title: 'old' })]
    const next = accumulateLiveEvents(current, [
      makeEvent({ eventId: 1, title: 'new', updatedAt: new Date(NOW.getTime() + 1000) }),
      makeEvent({ eventId: 2, title: 'second' }),
    ])
    expect(next.map((event) => event.title).toSorted()).toEqual(['new', 'second'])
  })

  it('prefers the running copy over a stale one', () => {
    const current = [makeEvent({ eventId: 1, title: 'stale', running: false })]
    const next = accumulateLiveEvents(current, [
      makeEvent({ eventId: 1, title: 'live', running: true }),
    ])
    expect(next).toHaveLength(1)
    expect(next[0].title).toBe('live')
  })
})
