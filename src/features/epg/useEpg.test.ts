import { describe, expect, it } from 'vitest'
import type { ConfiguredChannel, Event } from '../../models'
import { buildChannelGuide } from './useEpg'

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
