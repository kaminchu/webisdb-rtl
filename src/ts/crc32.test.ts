import { describe, expect, it } from 'vitest'
import { crc32, readCrc32, verifySectionCrc } from './crc32'

function appendCrc(bytes: number[]): Uint8Array {
  const body = Uint8Array.from(bytes)
  const crc = crc32(body)
  return Uint8Array.from([
    ...bytes,
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
  ])
}

describe('crc32', () => {
  it('matches the CRC-32/MPEG-2 check value', () => {
    const bytes = new TextEncoder().encode('123456789')
    expect(crc32(bytes)).toBe(0x0376e6e7)
  })

  it('honours start and length', () => {
    const bytes = new TextEncoder().encode('xx123456789yy')
    expect(crc32(bytes, 2, 9)).toBe(0x0376e6e7)
  })

  it('round-trips an appended checksum', () => {
    const section = appendCrc([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00])
    expect(verifySectionCrc(section)).toBe(true)
    expect(readCrc32(section, section.length - 4)).toBe(crc32(section, 0, section.length - 4))
  })

  it('rejects a corrupted section', () => {
    const section = appendCrc([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00])
    const corrupted = section.slice()
    corrupted[4] ^= 0xff
    expect(verifySectionCrc(corrupted)).toBe(false)
  })

  it('rejects sections shorter than the checksum', () => {
    expect(verifySectionCrc(Uint8Array.from([0x00, 0x01, 0x02]))).toBe(false)
  })
})
