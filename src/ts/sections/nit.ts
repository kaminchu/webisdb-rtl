import { DescriptorTag } from '../../models/descriptor'
import type { NitSection, NitTransportStream } from '../../models/si'
import { decodeNetworkName, findDescriptor, parseDescriptors } from '../descriptors'

export function decodeNit(section: Uint8Array): NitSection {
  const networkId = (section[3] << 8) | section[4]
  const version = (section[5] >> 1) & 0x1f

  const networkDescriptorsLength = ((section[8] & 0x0f) << 8) | section[9]
  const networkDescriptors = parseDescriptors(section.subarray(10, 10 + networkDescriptorsLength))

  let networkName: string | null = null
  const networkNameDescriptor = findDescriptor(networkDescriptors, DescriptorTag.NetworkName)
  if (networkNameDescriptor) networkName = decodeNetworkName(networkNameDescriptor.data)

  let offset = 10 + networkDescriptorsLength
  const transportStreamLoopLength = ((section[offset] & 0x0f) << 8) | section[offset + 1]
  offset += 2
  const loopEnd = Math.min(offset + transportStreamLoopLength, section.length - 4)

  const transportStreams: NitTransportStream[] = []
  while (offset + 6 <= loopEnd) {
    const transportStreamId = (section[offset] << 8) | section[offset + 1]
    const originalNetworkId = (section[offset + 2] << 8) | section[offset + 3]
    const descriptorsLength = ((section[offset + 4] & 0x0f) << 8) | section[offset + 5]
    const descriptors = parseDescriptors(
      section.subarray(offset + 6, offset + 6 + descriptorsLength),
    )
    transportStreams.push({ transportStreamId, originalNetworkId, descriptors })
    offset += 6 + descriptorsLength
  }

  return {
    networkId,
    networkName,
    version,
    transportStreams,
    descriptors: networkDescriptors,
  }
}
