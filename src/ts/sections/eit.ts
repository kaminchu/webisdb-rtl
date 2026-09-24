import { DescriptorTag } from '../../models/descriptor'
import type { Event } from '../../models/service'
import type { EitSection } from '../../models/si'
import {
  decodeContent,
  decodeExtendedEvent,
  decodeShortEvent,
  findDescriptor,
  parseDescriptors,
} from '../descriptors'
import { parseDuration, parseJstTime } from './tstime'

const RUNNING_STATUS_RUNNING = 4

export function isEitTableId(tableId: number): boolean {
  return tableId >= 0x4e && tableId <= 0x5f
}

export function decodeEit(section: Uint8Array): EitSection {
  const tableId = section[0]
  const serviceId = (section[3] << 8) | section[4]
  const version = (section[5] >> 1) & 0x1f
  const transportStreamId = (section[8] << 8) | section[9]
  const originalNetworkId = (section[10] << 8) | section[11]
  const end = section.length - 4

  const presentFollowing = tableId === 0x4e || tableId === 0x4f
  const schedule = tableId >= 0x50 && tableId <= 0x5f
  const events: Event[] = []

  let offset = 14
  while (offset + 12 <= end) {
    const eventId = (section[offset] << 8) | section[offset + 1]
    const startTime = parseJstTime(section, offset + 2)
    const duration = parseDuration(section, offset + 7)
    const runningStatus = (section[offset + 10] >> 5) & 0x07
    const descriptorsLoopLength = ((section[offset + 10] & 0x0f) << 8) | section[offset + 11]
    const descriptors = parseDescriptors(
      section.subarray(offset + 12, offset + 12 + descriptorsLoopLength),
    )

    let title = ''
    let description: string | undefined
    const shortEvent = findDescriptor(descriptors, DescriptorTag.ShortEvent)
    if (shortEvent) {
      const info = decodeShortEvent(shortEvent.data)
      title = info.eventName
      if (info.text) description = info.text
    }
    const extendedEvent = findDescriptor(descriptors, DescriptorTag.ExtendedEvent)
    if (extendedEvent) {
      const info = decodeExtendedEvent(extendedEvent.data)
      if (info.text) description = description ? `${description}\n${info.text}` : info.text
    }
    const content = findDescriptor(descriptors, DescriptorTag.ContentDescriptor)
    const genres = content ? decodeContent(content.data) : []

    events.push({
      eventId,
      serviceId,
      transportStreamId,
      startTime,
      duration,
      title,
      running: runningStatus === RUNNING_STATUS_RUNNING,
      ...(description !== undefined ? { description } : {}),
      ...(genres.length > 0 ? { genres } : {}),
    })
    offset += 12 + descriptorsLoopLength
  }

  return {
    tableId,
    serviceId,
    transportStreamId,
    originalNetworkId,
    version,
    presentFollowing,
    schedule,
    events,
  }
}
