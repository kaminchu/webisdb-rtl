import { describe, expect, it } from 'vitest'
import type { PesPacket } from '../models/media'
import type {
  EitSection,
  NitSection,
  PatSection,
  PmtSection,
  SdtSection,
  TdtSection,
  TotSection,
} from '../models/si'
import { Demuxer, classifyStream } from './demuxer'
import {
  asciiBytes,
  encodeAribText,
  buildDataComponent,
  buildEit,
  buildNit,
  buildPat,
  buildPes,
  buildPmt,
  buildSdt,
  buildTdt,
  buildTot,
  pesToPackets,
  sectionToPackets,
} from './sectionBuilder'

interface Captured {
  pat: PatSection[]
  pmt: PmtSection[]
  sdt: SdtSection[]
  eit: EitSection[]
  nit: NitSection[]
  tdt: TdtSection[]
  tot: TotSection[]
  pes: PesPacket[]
}

function createDemuxer(): { demuxer: Demuxer; captured: Captured } {
  const captured: Captured = {
    pat: [],
    pmt: [],
    sdt: [],
    eit: [],
    nit: [],
    tdt: [],
    tot: [],
    pes: [],
  }
  const demuxer = new Demuxer({
    onPat: (section) => captured.pat.push(section),
    onPmt: (section) => captured.pmt.push(section),
    onSdt: (section) => captured.sdt.push(section),
    onEit: (section) => captured.eit.push(section),
    onNit: (section) => captured.nit.push(section),
    onTdt: (section) => captured.tdt.push(section),
    onTot: (section) => captured.tot.push(section),
    onPes: (packet) => captured.pes.push(packet),
  })
  return { demuxer, captured }
}

function buildSingleProgram() {
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
      { streamType: 0x0f, pid: 0x102 },
      { streamType: 0x06, pid: 0x103, descriptors: buildDataComponent(0x0008) },
    ],
  })
  return { pat, pmt }
}

describe('Demuxer', () => {
  it('dispatches all PSI/SI tables', () => {
    const { demuxer, captured } = createDemuxer()
    const { pat, pmt } = buildSingleProgram()
    const sdt = buildSdt({
      transportStreamId: 0x1234,
      originalNetworkId: 0x7fff,
      services: [
        {
          serviceId: 1,
          serviceType: 1,
          provider: encodeAribText('NHK'),
          name: encodeAribText('S1'),
        },
      ],
    })
    const eit = buildEit({
      tableId: 0x4e,
      serviceId: 1,
      transportStreamId: 0x1234,
      originalNetworkId: 0x7fff,
      events: [
        {
          eventId: 1,
          startTime: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)),
          duration: 60,
          runningStatus: 4,
          title: encodeAribText('T'),
        },
      ],
    })
    const nit = buildNit({
      networkId: 1,
      networkName: encodeAribText('N'),
      transportStreams: [{ transportStreamId: 0x1234, originalNetworkId: 0x7fff }],
    })
    const tdt = buildTdt(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)))
    const tot = buildTot(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)), 540, 0)

    demuxer.push(sectionToPackets(pat, 0x0000))
    demuxer.push(sectionToPackets(pmt, 0x0100))
    demuxer.push(sectionToPackets(sdt, 0x0011))
    demuxer.push(sectionToPackets(eit, 0x0012))
    demuxer.push(sectionToPackets(nit, 0x0010))
    demuxer.push(sectionToPackets(tdt, 0x0014))
    demuxer.push(sectionToPackets(tot, 0x0014))

    expect(captured.pat).toHaveLength(1)
    expect(captured.pmt).toHaveLength(1)
    expect(captured.sdt).toHaveLength(1)
    expect(captured.sdt[0].services[0].serviceName).toBe('S1')
    expect(captured.eit).toHaveLength(1)
    expect(captured.nit).toHaveLength(1)
    expect(captured.tdt).toHaveLength(1)
    expect(captured.tot).toHaveLength(1)
    expect(demuxer.selectedService).toBe(1)
  })

  it('dispatches EIT from every terrestrial EIT PID', () => {
    const { demuxer, captured } = createDemuxer()
    const eit = buildEit({
      tableId: 0x4e,
      serviceId: 1,
      transportStreamId: 0x1234,
      originalNetworkId: 0x7fff,
      events: [],
    })
    for (const pid of [0x0012, 0x0026, 0x0027]) {
      demuxer.push(sectionToPackets(eit, pid))
    }
    expect(captured.eit).toHaveLength(3)
  })

  it('assembles PES and extracts PTS/DTS', () => {
    const { demuxer, captured } = createDemuxer()
    const { pat, pmt } = buildSingleProgram()
    demuxer.push(sectionToPackets(pat, 0x0000))
    demuxer.push(sectionToPackets(pmt, 0x0100))

    const payload = asciiBytes('hello world')
    const pes = buildPes(0xe0, payload, { pts: 90000, dts: 45000 })
    demuxer.push(pesToPackets(0x0101, pes))

    expect(captured.pes).toHaveLength(1)
    expect(captured.pes[0]).toMatchObject({
      pid: 0x0101,
      kind: 'video',
      streamId: 0xe0,
      pts: 90000,
      dts: 45000,
    })
    expect(Array.from(captured.pes[0].data)).toEqual(Array.from(payload))
  })

  it('assembles a PES packet spanning several TS packets', () => {
    const { demuxer, captured } = createDemuxer()
    const { pat, pmt } = buildSingleProgram()
    demuxer.push(sectionToPackets(pat, 0x0000))
    demuxer.push(sectionToPackets(pmt, 0x0100))

    const payload = Uint8Array.from({ length: 500 }, (_, index) => index & 0xff)
    const pes = buildPes(0xe0, payload, { pts: 1000 })
    demuxer.push(pesToPackets(0x0101, pes))

    expect(captured.pes).toHaveLength(1)
    expect(captured.pes[0].data.length).toBe(500)
    expect(Array.from(captured.pes[0].data)).toEqual(Array.from(payload))
  })

  it('classifies caption and audio streams', () => {
    const { demuxer, captured } = createDemuxer()
    const { pat, pmt } = buildSingleProgram()
    demuxer.push(sectionToPackets(pat, 0x0000))
    demuxer.push(sectionToPackets(pmt, 0x0100))

    demuxer.push(pesToPackets(0x0102, buildPes(0xc0, asciiBytes('a'), { pts: 1 })))
    demuxer.push(pesToPackets(0x0103, buildPes(0xbd, asciiBytes('c'), { pts: 2 })))

    expect(captured.pes.find((packet) => packet.pid === 0x0102)?.kind).toBe('audio')
    expect(captured.pes.find((packet) => packet.pid === 0x0103)?.kind).toBe('caption')
  })

  it('selects another service and switches elementary stream PIDs', () => {
    const { demuxer, captured } = createDemuxer()
    const pat = buildPat({
      transportStreamId: 0x1234,
      programs: [
        { programNumber: 1, pid: 0x100 },
        { programNumber: 2, pid: 0x200 },
      ],
    })
    const pmt1 = buildPmt({
      programNumber: 1,
      pcrPid: 0x101,
      streams: [{ streamType: 0x1b, pid: 0x101 }],
    })
    const pmt2 = buildPmt({
      programNumber: 2,
      pcrPid: 0x201,
      streams: [{ streamType: 0x1b, pid: 0x201 }],
    })

    demuxer.push(sectionToPackets(pat, 0x0000))
    demuxer.push(sectionToPackets(pmt1, 0x0100))
    demuxer.push(sectionToPackets(pmt2, 0x0200))

    demuxer.push(pesToPackets(0x0201, buildPes(0xe0, asciiBytes('two'), { pts: 2 })))
    expect(captured.pes).toHaveLength(0)

    demuxer.selectService(2)
    demuxer.push(pesToPackets(0x0201, buildPes(0xe0, asciiBytes('two'), { pts: 3 })))
    expect(captured.pes).toHaveLength(1)
    expect(captured.pes[0].pid).toBe(0x0201)
    expect(demuxer.selectedService).toBe(2)
  })

  it('ignores packets flagged with the transport error indicator', () => {
    const { demuxer, captured } = createDemuxer()
    const { pat } = buildSingleProgram()
    const packets = sectionToPackets(pat, 0x0000)
    const corrupted = packets.slice()
    corrupted[1] |= 0x80
    demuxer.push(corrupted)
    expect(captured.pat).toHaveLength(0)
  })
})

describe('classifyStream', () => {
  it('maps stream types to kinds', () => {
    expect(classifyStream({ pid: 1, streamType: 0x1b, descriptors: [] })).toBe('video')
    expect(classifyStream({ pid: 1, streamType: 0x0f, descriptors: [] })).toBe('audio')
    expect(
      classifyStream({
        pid: 1,
        streamType: 0x06,
        descriptors: [{ tag: 0xc9, data: Uint8Array.from([0x00, 0x08]) }],
      }),
    ).toBe('caption')
    expect(classifyStream({ pid: 1, streamType: 0x06, descriptors: [] })).toBe('data')
    expect(classifyStream({ pid: 1, streamType: 0x99, descriptors: [] })).toBe('other')
  })
})
