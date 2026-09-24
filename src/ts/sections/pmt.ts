import type { PmtSection, PmtStream } from '../../models/si'
import { parseDescriptors } from '../descriptors'

export function decodePmt(section: Uint8Array): PmtSection {
  const programNumber = (section[3] << 8) | section[4]
  const version = (section[5] >> 1) & 0x1f
  const end = section.length - 4

  const pcrPid = ((section[8] & 0x1f) << 8) | section[9]
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11]
  const programInfo = parseDescriptors(section.subarray(12, 12 + programInfoLength))

  const streams: PmtStream[] = []
  let offset = 12 + programInfoLength
  while (offset + 5 <= end) {
    const streamType = section[offset]
    const pid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2]
    const esInfoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4]
    const descriptors = parseDescriptors(section.subarray(offset + 5, offset + 5 + esInfoLength))
    streams.push({ pid, streamType, descriptors })
    offset += 5 + esInfoLength
  }

  return { programNumber, version, pcrPid, programInfo, streams }
}
