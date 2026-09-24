import { describe, expect, it } from 'vitest'
import { RS_CODEWORD_SIZE, SYNC_BYTE, TS_PACKET_SIZE } from './energyDispersal'
import { TsGenerator } from './tsGenerator'

function makePacket(first: number): Uint8Array {
  const packet = new Uint8Array(TS_PACKET_SIZE)
  packet[0] = SYNC_BYTE
  packet[1] = first
  for (let i = 2; i < TS_PACKET_SIZE; i++) packet[i] = (first + i) & 0xff
  return packet
}

describe('TsGenerator', () => {
  it('emits 188-byte packets that start with the sync byte', () => {
    const generator = new TsGenerator()
    generator.pushBlock(makePacket(1))
    generator.pushBlock(makePacket(2))
    const out = generator.takeBytes()
    expect(out).toHaveLength(2 * TS_PACKET_SIZE)
    expect(out[0]).toBe(SYNC_BYTE)
    expect(out[TS_PACKET_SIZE]).toBe(SYNC_BYTE)
    expect(generator.stats.packets).toBe(2)
    expect(generator.stats.syncErrors).toBe(0)
  })

  it('accepts 204-byte RS codewords and strips the parity', () => {
    const generator = new TsGenerator()
    const codeword = new Uint8Array(RS_CODEWORD_SIZE)
    codeword.set(makePacket(9), 0)
    for (let i = TS_PACKET_SIZE; i < RS_CODEWORD_SIZE; i++) codeword[i] = 0xee
    generator.pushBlock(codeword)
    const out = generator.takeBytes()
    expect(out).toHaveLength(TS_PACKET_SIZE)
    expect(out[0]).toBe(SYNC_BYTE)
    expect(out[TS_PACKET_SIZE - 1]).toBe(codeword[TS_PACKET_SIZE - 1])
  })

  it('rotates a trailing sync byte to the front', () => {
    const generator = new TsGenerator()
    const rotated = new Uint8Array(TS_PACKET_SIZE)
    rotated.set(makePacket(4).subarray(1), 0)
    rotated[TS_PACKET_SIZE - 1] = SYNC_BYTE
    generator.pushBlock(rotated)
    const out = generator.takeBytes()
    expect(out[0]).toBe(SYNC_BYTE)
    expect(out[1]).toBe(4)
  })

  it('counts sync errors', () => {
    const generator = new TsGenerator()
    const broken = makePacket(5)
    broken[0] = 0x00
    broken[TS_PACKET_SIZE - 1] = 0x00
    generator.pushBlock(broken)
    expect(generator.stats.syncErrors).toBe(1)
  })

  it('rejects blocks of the wrong size', () => {
    const generator = new TsGenerator()
    expect(() => generator.pushBlock(new Uint8Array(100))).toThrow()
  })
})
