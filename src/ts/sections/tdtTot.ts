import { DescriptorTag } from '../../models/descriptor'
import type { TotSection, TdtSection } from '../../models/si'
import { decodeLocalTimeOffset, findDescriptor, parseDescriptors } from '../descriptors'
import { parseMjdTime } from './tstime'

export {
  bcdToNumber,
  calendarToMjd,
  mjdToCalendar,
  numberToBcd,
  parseDuration,
  parseJstTime,
  parseMjdTime,
} from './tstime'

export function decodeTdt(section: Uint8Array): TdtSection {
  return { utc: parseMjdTime(section, 3) }
}

export function decodeTot(section: Uint8Array): TotSection {
  const utc = parseMjdTime(section, 3)
  let offset = 8
  const descriptorsLength = ((section[offset] & 0x0f) << 8) | section[offset + 1]
  offset += 2
  const end = Math.min(offset + descriptorsLength, section.length - 4)
  const descriptors = parseDescriptors(section.subarray(offset, end))

  let localTimeOffsetMinutes = 0
  let localTimeOffsetPolarity = 0
  const localTimeOffset = findDescriptor(descriptors, DescriptorTag.LocalTimeOffset)
  if (localTimeOffset) {
    const [entry] = decodeLocalTimeOffset(localTimeOffset.data)
    if (entry) {
      localTimeOffsetPolarity = entry.polarity
      localTimeOffsetMinutes = entry.polarity === 1 ? -entry.offsetMinutes : entry.offsetMinutes
    }
  }

  return { utc, localTimeOffsetMinutes, localTimeOffsetPolarity, descriptors }
}
