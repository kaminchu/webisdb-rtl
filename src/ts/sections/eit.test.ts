import { describe, expect, it } from 'vitest'
import { asciiBytes, buildEit, encodeAribText } from '../sectionBuilder'
import { decodeEit, isEitTableId } from './eit'

describe('decodeEit', () => {
  it('decodes a present/following event in JST', () => {
    const start = new Date(Date.UTC(2024, 5, 15, 10, 30, 0))
    const section = buildEit({
      tableId: 0x4e,
      serviceId: 0x0101,
      transportStreamId: 0x1234,
      originalNetworkId: 0x7fff,
      version: 1,
      events: [
        {
          eventId: 0x0101,
          startTime: start,
          duration: 3661,
          runningStatus: 4,
          title: encodeAribText('こんにちは'),
          text: asciiBytes('news'),
          extendedText: encodeAribText('テスト'),
          genres: [0x70, 0x10],
        },
      ],
    })
    const eit = decodeEit(section)
    expect(eit.tableId).toBe(0x4e)
    expect(eit.serviceId).toBe(0x0101)
    expect(eit.transportStreamId).toBe(0x1234)
    expect(eit.originalNetworkId).toBe(0x7fff)
    expect(eit.presentFollowing).toBe(true)
    expect(eit.schedule).toBe(false)
    expect(eit.events).toHaveLength(1)
    expect(eit.events[0].eventId).toBe(0x0101)
    expect(eit.events[0].startTime.getTime()).toBe(start.getTime())
    expect(eit.events[0].duration).toBe(3661)
    expect(eit.events[0].running).toBe(true)
    expect(eit.events[0].title).toBe('こんにちは')
    expect(eit.events[0].description).toBe('news\nテスト')
    expect(eit.events[0].genres).toEqual([0x70, 0x10])
  })

  it('flags schedule table IDs', () => {
    const section = buildEit({
      tableId: 0x50,
      serviceId: 0x0101,
      transportStreamId: 0x1234,
      originalNetworkId: 0x7fff,
      events: [],
    })
    const eit = decodeEit(section)
    expect(eit.schedule).toBe(true)
    expect(eit.presentFollowing).toBe(false)
    expect(isEitTableId(0x5f)).toBe(true)
    expect(isEitTableId(0x6f)).toBe(false)
  })
})
