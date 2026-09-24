import type { Service } from '../models'
import type { AppState } from './store'

export function receivedServices(diagnostics: AppState['diagnostics']): Service[] {
  const ids = new Set(diagnostics.services.map((service) => service.serviceId))
  if (diagnostics.pmt) ids.add(diagnostics.pmt.programNumber)
  return [...ids].map((serviceId) => {
    const sdt = diagnostics.sdt?.services.find((service) => service.serviceId === serviceId)
    return sdt
      ? {
          serviceId,
          name: sdt.serviceName,
          providerName: sdt.providerName,
          serviceType: sdt.serviceType,
        }
      : (diagnostics.services.find((service) => service.serviceId === serviceId) ?? {
          serviceId,
          name: `サービス ${serviceId}`,
        })
  })
}

export function receivedTransportStreamId(diagnostics: AppState['diagnostics']): number | null {
  if (diagnostics.pat) return diagnostics.pat.transportStreamId
  if (diagnostics.sdt) return diagnostics.sdt.transportStreamId
  const serviceId = diagnostics.pmt?.programNumber
  const streams = diagnostics.nit?.transportStreams ?? []
  const matching = streams.find((stream) =>
    stream.descriptors.some((descriptor) => {
      if (descriptor.tag !== 0xfb) return false
      for (let i = 0; i + 1 < descriptor.data.length; i += 2) {
        if (((descriptor.data[i] << 8) | descriptor.data[i + 1]) === serviceId) return true
      }
      return false
    }),
  )
  return matching?.transportStreamId ?? (streams.length === 1 ? streams[0].transportStreamId : null)
}
