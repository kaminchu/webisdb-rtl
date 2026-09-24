import { describe, expect, it } from 'vitest'
import type { TsPacket } from './packet'
import { TsStatisticsCollector } from './statistics'

function makePacket(
  pid: number,
  continuityCounter: number,
  overrides: Partial<TsPacket> = {},
): TsPacket {
  return {
    pid,
    transportErrorIndicator: false,
    payloadUnitStartIndicator: false,
    transportPriority: false,
    scramblingControl: 0,
    adaptationFieldControl: 1,
    continuityCounter,
    discontinuityIndicator: false,
    randomAccessIndicator: false,
    payload: Uint8Array.from([0x00]),
    ...overrides,
  }
}

describe('TsStatisticsCollector', () => {
  it('counts packets, bytes, errors and PIDs', () => {
    const stats = new TsStatisticsCollector()
    stats.record(makePacket(0x0000, 0), 188)
    stats.record(makePacket(0x0100, 0), 188)
    stats.record(makePacket(0x0100, 1), 188)
    stats.record(makePacket(0x0100, 2, { transportErrorIndicator: true }), 188)
    stats.setStreamType(0x0100, 0x1b, 'AVC video')

    const snapshot = stats.snapshot()
    expect(snapshot.packets).toBe(4)
    expect(snapshot.bytes).toBe(752)
    expect(snapshot.packetsWithError).toBe(1)
    expect(snapshot.pids).toEqual([
      { pid: 0x0000, packets: 1 },
      { pid: 0x0100, packets: 3, streamType: 0x1b, description: 'AVC video' },
    ])
  })

  it('counts continuity counter errors for payload packets', () => {
    const stats = new TsStatisticsCollector()
    stats.record(makePacket(0x0100, 0))
    stats.record(makePacket(0x0100, 1))
    stats.record(makePacket(0x0100, 3))
    expect(stats.snapshot().ccErrors).toBe(1)
  })

  it('ignores continuity for packets without payload', () => {
    const stats = new TsStatisticsCollector()
    stats.record(makePacket(0x0100, 0))
    stats.record(makePacket(0x0100, 0, { payload: new Uint8Array(0), adaptationFieldControl: 2 }))
    stats.record(makePacket(0x0100, 1))
    expect(stats.snapshot().ccErrors).toBe(0)
  })

  it('measures a sliding-window bitrate with an injected clock', () => {
    let clock = 0
    const stats = new TsStatisticsCollector({ now: () => clock, windowMs: 1000 })
    stats.record(makePacket(0x0100, 0))
    clock = 1000
    stats.record(makePacket(0x0100, 1))
    expect(stats.snapshot().bitrate).toBe(1504)
  })

  it('resets counters', () => {
    const stats = new TsStatisticsCollector()
    stats.record(makePacket(0x0100, 0))
    stats.reset()
    expect(stats.snapshot()).toMatchObject({
      packets: 0,
      bytes: 0,
      ccErrors: 0,
      bitrate: 0,
      pids: [],
    })
  })
})
