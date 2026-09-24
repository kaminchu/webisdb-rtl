import { describe, expect, it } from 'vitest'
import { findSyncByte, PacketReader, parsePacket, TS_PACKET_SIZE, TS_SYNC_BYTE } from './packet'

function buildPacket(
  pid: number,
  options: {
    pusi?: boolean
    cc?: number
    tei?: boolean
    adaptation?: number[]
    payload?: number[]
  },
): Uint8Array {
  const pusi = options.pusi ?? false
  const cc = options.cc ?? 0
  const tei = options.tei ?? false
  const adaptation = options.adaptation ?? []
  const payload = options.payload ?? []
  const afc = adaptation.length > 0 ? 3 : 1
  const adaptationField = adaptation.length > 0 ? [adaptation.length, ...adaptation] : []
  const header = [
    TS_SYNC_BYTE,
    (tei ? 0x80 : 0x00) | (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f),
    pid & 0xff,
    (afc << 4) | (cc & 0x0f),
  ]
  const body = [...adaptationField, ...payload]
  const padding = TS_PACKET_SIZE - header.length - body.length
  return Uint8Array.from([...header, ...body, ...Array.from({ length: padding }, () => 0xff)])
}

describe('parsePacket', () => {
  it('parses header fields and payload', () => {
    const packet = buildPacket(0x1fff, { pusi: true, cc: 5, payload: [1, 2, 3] })
    const parsed = parsePacket(packet)
    expect(parsed).not.toBeNull()
    expect(parsed?.pid).toBe(0x1fff)
    expect(parsed?.payloadUnitStartIndicator).toBe(true)
    expect(parsed?.continuityCounter).toBe(5)
    expect(parsed?.transportErrorIndicator).toBe(false)
    expect(Array.from(parsed?.payload ?? []).slice(0, 3)).toEqual([1, 2, 3])
    expect(parsed?.payload.length).toBe(TS_PACKET_SIZE - 4)
  })

  it('detects the transport error indicator', () => {
    const parsed = parsePacket(buildPacket(0x0100, { tei: true }))
    expect(parsed?.transportErrorIndicator).toBe(true)
  })

  it('extracts PCR and adaptation flags', () => {
    const base = 100
    const extension = 200
    const p0 = (base >> 25) & 0xff
    const p1 = (base >> 17) & 0xff
    const p2 = (base >> 9) & 0xff
    const p3 = (base >> 1) & 0xff
    const p4 = ((base & 0x01) << 7) | 0x7e | ((extension >> 8) & 0x01)
    const p5 = extension & 0xff
    const adaptation = [0x50, p0, p1, p2, p3, p4, p5]
    const parsed = parsePacket(buildPacket(0x0100, { adaptation }))
    expect(parsed?.discontinuityIndicator).toBe(false)
    expect(parsed?.randomAccessIndicator).toBe(true)
    expect(parsed?.pcr).toBe(base * 300 + extension)
  })

  it('returns null for a short or unsynced buffer', () => {
    expect(parsePacket(new Uint8Array(10))).toBeNull()
    expect(parsePacket(Uint8Array.from([0x00, ...Array.from({ length: 200 }, () => 0)]))).toBeNull()
  })
})

describe('findSyncByte', () => {
  it('finds the next sync byte', () => {
    expect(findSyncByte(Uint8Array.from([1, 2, TS_SYNC_BYTE, 4]))).toBe(2)
    expect(findSyncByte(Uint8Array.from([1, 2, 3]))).toBe(-1)
  })
})

describe('PacketReader', () => {
  it('returns whole packets and buffers a partial packet', () => {
    const reader = new PacketReader()
    const packet = buildPacket(0x0000, { payload: [9, 9, 9] })
    expect(reader.push(packet.subarray(0, 100))).toHaveLength(0)
    expect(reader.bufferedBytes).toBe(100)
    const packets = reader.push(packet.subarray(100))
    expect(packets).toHaveLength(1)
    expect(packets[0].pid).toBe(0x0000)
    expect(reader.bufferedBytes).toBe(0)
  })

  it('resyncs on the next 0x47 after garbage', () => {
    const reader = new PacketReader()
    const packet = buildPacket(0x0042, { payload: [1] })
    const garbage = Uint8Array.from([0x00, 0x11, 0x22])
    const merged = new Uint8Array(garbage.length + packet.length)
    merged.set(garbage)
    merged.set(packet, garbage.length)
    const packets = reader.push(merged)
    expect(packets).toHaveLength(1)
    expect(packets[0].pid).toBe(0x0042)
  })
})
