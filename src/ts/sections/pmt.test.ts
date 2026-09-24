import { describe, expect, it } from 'vitest'
import { buildDataComponent, buildDescriptor, buildPmt } from '../sectionBuilder'
import { decodePmt } from './pmt'

describe('decodePmt', () => {
  it('decodes the PCR PID and elementary streams', () => {
    const section = buildPmt({
      programNumber: 1,
      version: 2,
      pcrPid: 0x101,
      streams: [
        { streamType: 0x1b, pid: 0x101 },
        { streamType: 0x0f, pid: 0x102, descriptors: buildDescriptor(0x52, [0x02]) },
        { streamType: 0x06, pid: 0x103, descriptors: buildDataComponent(0x0008) },
      ],
    })
    const pmt = decodePmt(section)
    expect(pmt.programNumber).toBe(1)
    expect(pmt.version).toBe(2)
    expect(pmt.pcrPid).toBe(0x101)
    expect(pmt.streams).toHaveLength(3)
    expect(pmt.streams[0]).toMatchObject({ pid: 0x101, streamType: 0x1b })
    expect(pmt.streams[1].descriptors[0].tag).toBe(0x52)
    expect(pmt.streams[2].descriptors[0].tag).toBe(0xc9)
  })
})
