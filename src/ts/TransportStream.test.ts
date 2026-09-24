import { describe, expect, it } from 'vitest'
import type { PesPacket } from '../models/media'
import type { PmtSection, TsStatistics } from '../models/si'
import { TransportStream } from './TransportStream'
import {
  asciiBytes,
  buildDataComponent,
  buildPat,
  buildPes,
  buildPmt,
  pesToPackets,
  sectionToPackets,
} from './sectionBuilder'

function setup() {
  const pesPackets: PesPacket[] = []
  const pmts: PmtSection[] = []
  const statistics: TsStatistics[] = []
  const stream = new TransportStream({
    onPes: (packet) => pesPackets.push(packet),
    onPmt: (pmt) => pmts.push(pmt),
    onStatistics: (snapshot) => statistics.push(snapshot),
  })
  return { stream, pesPackets, pmts, statistics }
}

const pat = buildPat({
  transportStreamId: 0x1234,
  programs: [{ programNumber: 1, pid: 0x100 }],
  networkPid: 0x0010,
})
const pmt = buildPmt({
  programNumber: 1,
  pcrPid: 0x101,
  streams: [
    { streamType: 0x1b, pid: 0x101 },
    { streamType: 0x06, pid: 0x103, descriptors: buildDataComponent(0x0008) },
  ],
})

describe('TransportStream', () => {
  it('drives sections, PES and statistics', () => {
    const { stream, pesPackets, pmts, statistics } = setup()
    stream.push(sectionToPackets(pat, 0x0000))
    stream.push(sectionToPackets(pmt, 0x0100))
    stream.push(pesToPackets(0x0101, buildPes(0xe0, asciiBytes('abc'), { pts: 42 })))
    stream.push(pesToPackets(0x0103, buildPes(0xbd, asciiBytes('cap'), { pts: 43 })))

    expect(pmts).toHaveLength(1)
    expect(pesPackets).toHaveLength(2)
    expect(pesPackets[0].kind).toBe('video')
    expect(pesPackets[0].pts).toBe(42)
    expect(pesPackets[1].kind).toBe('caption')

    const snapshot = stream.getStatistics()
    expect(snapshot.packets).toBe(4)
    expect(snapshot.pids.find((pid) => pid.pid === 0x0101)?.streamType).toBe(0x1b)
    expect(statistics.length).toBe(4)
    expect(stream.selectedService).toBe(1)
  })

  it('resets state', () => {
    const { stream } = setup()
    stream.push(sectionToPackets(pat, 0x0000))
    expect(stream.getStatistics().packets).toBe(1)
    stream.reset()
    expect(stream.getStatistics().packets).toBe(0)
    expect(stream.selectedService).toBeNull()
  })

  it('exposes service selection', () => {
    const { stream } = setup()
    stream.push(sectionToPackets(pat, 0x0000))
    stream.selectService(1)
    expect(stream.selectedService).toBe(1)
  })
})
