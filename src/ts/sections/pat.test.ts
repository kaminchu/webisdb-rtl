import { describe, expect, it } from 'vitest'
import { buildPat } from '../sectionBuilder'
import { decodePat } from './pat'

describe('decodePat', () => {
  it('decodes programs and the network PID', () => {
    const section = buildPat({
      transportStreamId: 0x1234,
      version: 3,
      programs: [
        { programNumber: 1, pid: 0x100 },
        { programNumber: 2, pid: 0x200 },
      ],
      networkPid: 0x0010,
    })
    const pat = decodePat(section)
    expect(pat.transportStreamId).toBe(0x1234)
    expect(pat.version).toBe(3)
    expect(pat.programs).toEqual([
      { programNumber: 1, pid: 0x100 },
      { programNumber: 2, pid: 0x200 },
    ])
    expect(pat.networkPid).toBe(0x0010)
  })

  it('defaults the network PID when absent', () => {
    const pat = decodePat(buildPat({ transportStreamId: 1, programs: [] }))
    expect(pat.networkPid).toBe(0x0010)
    expect(pat.programs).toEqual([])
  })
})
