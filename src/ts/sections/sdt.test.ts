import { describe, expect, it } from 'vitest'
import { buildDescriptor, buildSdt, encodeAribText } from '../sectionBuilder'
import { decodeSdt } from './sdt'

describe('decodeSdt', () => {
  it('decodes service names and providers', () => {
    const section = buildSdt({
      transportStreamId: 0x1234,
      originalNetworkId: 0x7fff,
      version: 1,
      services: [
        {
          serviceId: 0x0101,
          serviceType: 0x01,
          provider: encodeAribText('ＮＨＫ'),
          name: encodeAribText('総合'),
        },
      ],
    })
    const sdt = decodeSdt(section)
    expect(sdt.transportStreamId).toBe(0x1234)
    expect(sdt.originalNetworkId).toBe(0x7fff)
    expect(sdt.version).toBe(1)
    expect(sdt.services).toHaveLength(1)
    expect(sdt.services[0]).toEqual({
      serviceId: 0x0101,
      serviceType: 0x01,
      providerName: 'ＮＨＫ',
      serviceName: '総合',
    })
  })

  it('decodes the simple logo from the logo transmission descriptor', () => {
    const section = buildSdt({
      transportStreamId: 0x1234,
      originalNetworkId: 0x7fff,
      services: [
        {
          serviceId: 0x7db8,
          serviceType: 0x01,
          provider: encodeAribText('ＮＨＫ'),
          name: encodeAribText('総合'),
          descriptors: buildDescriptor(0xcf, [0x03, ...encodeAribText('NST')]),
        },
      ],
    })
    const [service] = decodeSdt(section).services
    expect(service.logo).toBe('NST')
  })
})
