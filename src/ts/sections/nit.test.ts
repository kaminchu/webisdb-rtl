import { describe, expect, it } from 'vitest'
import { buildNit, encodeAribText } from '../sectionBuilder'
import { decodeNit } from './nit'

describe('decodeNit', () => {
  it('decodes the network name and transport streams', () => {
    const section = buildNit({
      networkId: 0x1234,
      version: 4,
      networkName: encodeAribText('テスト'),
      transportStreams: [{ transportStreamId: 0x1234, originalNetworkId: 0x7fff }],
    })
    const nit = decodeNit(section)
    expect(nit.networkId).toBe(0x1234)
    expect(nit.version).toBe(4)
    expect(nit.networkName).toBe('テスト')
    expect(nit.transportStreams).toHaveLength(1)
    expect(nit.transportStreams[0].transportStreamId).toBe(0x1234)
    expect(nit.transportStreams[0].originalNetworkId).toBe(0x7fff)
  })

  it('returns a null network name when the descriptor is absent', () => {
    const section = buildNit({
      networkId: 1,
      networkDescriptors: [],
      transportStreams: [],
    })
    expect(decodeNit(section).networkName).toBeNull()
  })
})
