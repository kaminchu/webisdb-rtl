import { expect, it } from 'vitest'
import { createEmptyDiagnostics } from './store'
import { receivedServices, receivedTransportStreamId } from './serviceInfo'

it('discovers one-seg via PMT and uses SDT for its name without selecting full-seg services', () => {
  const diagnostics = createEmptyDiagnostics()
  diagnostics.pmt = { programNumber: 32144, version: 0, pcrPid: 512, programInfo: [], streams: [] }
  expect(receivedServices(diagnostics)[0].serviceId).toBe(32144)
  diagnostics.sdt = {
    transportStreamId: 32258,
    originalNetworkId: 32258,
    version: 0,
    services: [
      { serviceId: 31760, serviceType: 1, serviceName: 'BSN1', providerName: '' },
      { serviceId: 32144, serviceType: 192, serviceName: 'BSNワンセグ', providerName: '' },
    ],
  }
  expect(receivedServices(diagnostics).map((s) => s.name)).toEqual(['BSNワンセグ'])
  expect(receivedTransportStreamId(diagnostics)).toBe(32258)
})

it('carries the simple logo from SDT into discovered services', () => {
  const diagnostics = createEmptyDiagnostics()
  diagnostics.pmt = { programNumber: 32144, version: 0, pcrPid: 512, programInfo: [], streams: [] }
  diagnostics.sdt = {
    transportStreamId: 32258,
    originalNetworkId: 32258,
    version: 0,
    services: [
      { serviceId: 32144, serviceType: 192, serviceName: 'NST携帯', providerName: '', logo: 'NST' },
    ],
  }
  expect(receivedServices(diagnostics)[0].logo).toBe('NST')
})

it('identifies the NIT transport carrying the received partial-reception service', () => {
  const diagnostics = createEmptyDiagnostics()
  diagnostics.pmt = { programNumber: 32144, version: 0, pcrPid: 512, programInfo: [], streams: [] }
  diagnostics.nit = {
    networkId: 32258,
    networkName: '',
    version: 0,
    descriptors: [],
    transportStreams: [
      { transportStreamId: 1, originalNetworkId: 1, descriptors: [] },
      {
        transportStreamId: 32258,
        originalNetworkId: 32258,
        descriptors: [{ tag: 0xfb, data: Uint8Array.from([0x7d, 0x90]) }],
      },
    ],
  }
  expect(receivedTransportStreamId(diagnostics)).toBe(32258)
})
