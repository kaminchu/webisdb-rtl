import { DescriptorTag } from '../../models/descriptor'
import type { SdtSection, SdtService } from '../../models/si'
import { decodeServiceDescriptor, findDescriptor, parseDescriptors } from '../descriptors'

export function decodeSdt(section: Uint8Array): SdtSection {
  const transportStreamId = (section[3] << 8) | section[4]
  const version = (section[5] >> 1) & 0x1f
  const originalNetworkId = (section[8] << 8) | section[9]
  const end = section.length - 4

  const services: SdtService[] = []
  let offset = 11
  while (offset + 5 <= end) {
    const serviceId = (section[offset] << 8) | section[offset + 1]
    const descriptorsLoopLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4]
    const descriptors = parseDescriptors(
      section.subarray(offset + 5, offset + 5 + descriptorsLoopLength),
    )

    let serviceType = 0
    let providerName = ''
    let serviceName = ''
    const serviceDescriptor = findDescriptor(descriptors, DescriptorTag.ServiceDescriptor)
    if (serviceDescriptor) {
      const info = decodeServiceDescriptor(serviceDescriptor.data)
      serviceType = info.serviceType
      providerName = info.providerName
      serviceName = info.serviceName
    }

    services.push({ serviceId, serviceType, providerName, serviceName })
    offset += 5 + descriptorsLoopLength
  }

  return { transportStreamId, originalNetworkId, version, services }
}
