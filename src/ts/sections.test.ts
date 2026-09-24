import { describe, expect, it } from 'vitest'
import { PacketReader, parsePacket } from './packet'
import { SectionAssembler } from './sections'
import { buildPat, buildPmt, buildTdt, buildTsPackets, sectionToPackets } from './sectionBuilder'

function packetsOf(bytes: Uint8Array) {
  return new PacketReader().push(bytes)
}

function onlyPacket(bytes: Uint8Array) {
  return parsePacket(bytes, 0)!
}

describe('SectionAssembler', () => {
  it('reassembles a single complete section', () => {
    const assembler = new SectionAssembler()
    const pat = buildPat({ transportStreamId: 1, programs: [{ programNumber: 1, pid: 0x100 }] })
    const out = packetsOf(sectionToPackets(pat, 0x0000)).flatMap((packet) => assembler.push(packet))
    expect(out).toHaveLength(1)
    expect(Array.from(out[0])).toEqual(Array.from(pat))
  })

  it('extracts multiple sections from one packet after the pointer field', () => {
    const assembler = new SectionAssembler()
    const pat = buildPat({ transportStreamId: 1, programs: [{ programNumber: 1, pid: 0x100 }] })
    const pmt = buildPmt({
      programNumber: 1,
      pcrPid: 0x101,
      streams: [{ streamType: 0x1b, pid: 0x101 }],
    })
    const packet = onlyPacket(
      buildTsPackets(0x0000, [{ pusi: true, data: Uint8Array.from([0, ...pat, ...pmt]) }]),
    )
    const out = assembler.push(packet)
    expect(out).toHaveLength(2)
    expect(Array.from(out[0])).toEqual(Array.from(pat))
    expect(Array.from(out[1])).toEqual(Array.from(pmt))
  })

  it('reassembles a section spanning several packets', () => {
    const assembler = new SectionAssembler()
    const programs = Array.from({ length: 120 }, (_, index) => ({
      programNumber: index + 1,
      pid: 0x100 + index,
    }))
    const pat = buildPat({ transportStreamId: 1, programs })
    const packets = packetsOf(sectionToPackets(pat, 0x0000))
    expect(packets.length).toBeGreaterThan(1)
    const out: Uint8Array[] = []
    for (const packet of packets) out.push(...assembler.push(packet))
    expect(out).toHaveLength(1)
    expect(out[0].length).toBe(pat.length)
  })

  it('uses the pointer field to finish a previous section', () => {
    const assembler = new SectionAssembler()
    const a = buildPat({ transportStreamId: 1, programs: [{ programNumber: 1, pid: 0x100 }] })
    const b = buildPmt({ programNumber: 1, pcrPid: 0x101, streams: [] })
    const split = 2
    const part1 = Uint8Array.from([0, ...a.subarray(0, a.length - split)])
    const packet1 = onlyPacket(buildTsPackets(0x0000, [{ pusi: true, data: part1 }]))
    const part2 = Uint8Array.from([split, ...a.subarray(a.length - split), ...b])
    const packet2 = onlyPacket(buildTsPackets(0x0000, [{ pusi: true, data: part2 }], 1))
    expect(assembler.push(packet1)).toHaveLength(0)
    const out = assembler.push(packet2)
    expect(out).toHaveLength(2)
    expect(Array.from(out[0])).toEqual(Array.from(a))
    expect(Array.from(out[1])).toEqual(Array.from(b))
  })

  it('drops sections with an invalid CRC', () => {
    const assembler = new SectionAssembler()
    const pat = buildPat({ transportStreamId: 1, programs: [{ programNumber: 1, pid: 0x100 }] })
    const corrupted = pat.slice()
    corrupted[3] ^= 0xff
    const out = packetsOf(sectionToPackets(corrupted, 0x0000)).flatMap((packet) =>
      assembler.push(packet),
    )
    expect(out).toHaveLength(0)
  })

  it('accepts sections without CRC (TDT) and when validation is disabled', () => {
    const assembler = new SectionAssembler()
    const tdt = buildTdt(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)))
    const out = packetsOf(sectionToPackets(tdt, 0x0014)).flatMap((packet) => assembler.push(packet))
    expect(out).toHaveLength(1)
    expect(Array.from(out[0])).toEqual(Array.from(tdt))

    const lenient = new SectionAssembler({ validateCrc: false })
    const pat = buildPat({ transportStreamId: 1, programs: [{ programNumber: 1, pid: 0x100 }] })
    const corrupted = pat.slice()
    corrupted[3] ^= 0xff
    const lenientOut = packetsOf(sectionToPackets(corrupted, 0x0000)).flatMap((packet) =>
      lenient.push(packet),
    )
    expect(lenientOut).toHaveLength(1)
  })
})
