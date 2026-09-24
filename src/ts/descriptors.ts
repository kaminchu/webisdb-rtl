import { decodeAribText } from '../data/arib/decode'
import { DescriptorTag } from '../models/descriptor'
import type { Descriptor } from '../models/descriptor'
import type { AvcConfig } from '../models/media'
import { bcdToNumber, parseMjdTime } from './sections/tstime'

export function parseDescriptors(bytes: Uint8Array): Descriptor[] {
  const descriptors: Descriptor[] = []
  let offset = 0
  while (offset + 2 <= bytes.length) {
    const tag = bytes[offset]
    const length = bytes[offset + 1]
    if (offset + 2 + length > bytes.length) break
    descriptors.push({ tag, data: bytes.slice(offset + 2, offset + 2 + length) })
    offset += 2 + length
  }
  return descriptors
}

export function findDescriptor(descriptors: Descriptor[], tag: number): Descriptor | undefined {
  return descriptors.find((descriptor) => descriptor.tag === tag)
}

export interface ServiceDescriptorInfo {
  serviceType: number
  providerName: string
  serviceName: string
}

export function decodeServiceDescriptor(data: Uint8Array): ServiceDescriptorInfo {
  const serviceType = data[0]
  const providerLength = data[1]
  const providerName = decodeAribText(data.subarray(2, 2 + providerLength))
  const nameOffset = 2 + providerLength
  const nameLength = nameOffset < data.length ? data[nameOffset] : 0
  const serviceName = decodeAribText(data.subarray(nameOffset + 1, nameOffset + 1 + nameLength))
  return { serviceType, providerName, serviceName }
}

export function decodeNetworkName(data: Uint8Array): string {
  return decodeAribText(data)
}

export interface ShortEventInfo {
  language: string
  eventName: string
  text: string
}

export function decodeShortEvent(data: Uint8Array): ShortEventInfo {
  const language = String.fromCharCode(data[0], data[1], data[2])
  let offset = 3
  const nameLength = data[offset]
  offset++
  const eventName = decodeAribText(data.subarray(offset, offset + nameLength))
  offset += nameLength
  if (offset >= data.length) return { language, eventName, text: '' }
  const textLength = data[offset]
  offset++
  const text = decodeAribText(data.subarray(offset, offset + textLength))
  return { language, eventName, text }
}

export interface ExtendedEventItem {
  description: string
  text: string
}

export interface ExtendedEventInfo {
  language: string
  items: ExtendedEventItem[]
  text: string
}

export function decodeExtendedEvent(data: Uint8Array): ExtendedEventInfo {
  const language = String.fromCharCode(data[1], data[2], data[3])
  const itemsLength = data[4]
  let offset = 5
  const itemsEnd = offset + itemsLength
  const items: ExtendedEventItem[] = []
  while (offset < itemsEnd && offset + 1 <= data.length) {
    const descriptionLength = data[offset]
    offset++
    const description = decodeAribText(data.subarray(offset, offset + descriptionLength))
    offset += descriptionLength
    if (offset >= data.length) break
    const textLength = data[offset]
    offset++
    const text = decodeAribText(data.subarray(offset, offset + textLength))
    offset += textLength
    items.push({ description, text })
  }
  const textLength = offset < data.length ? data[offset] : 0
  offset++
  const text = decodeAribText(data.subarray(offset, offset + textLength))
  return { language, items, text }
}

export function decodeContent(data: Uint8Array): number[] {
  const genres: number[] = []
  for (let i = 0; i + 1 < data.length; i += 2) {
    genres.push(((data[i] >> 4) << 4) | (data[i + 1] >> 4))
  }
  return genres
}

export interface LocalTimeOffsetEntry {
  countryCode: string
  countryRegionId: number
  polarity: number
  offsetMinutes: number
  changeTime: Date
  nextOffsetMinutes: number
}

export function decodeLocalTimeOffset(data: Uint8Array): LocalTimeOffsetEntry[] {
  const entries: LocalTimeOffsetEntry[] = []
  let offset = 0
  while (offset + 13 <= data.length) {
    const countryCode = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2])
    const flags = data[offset + 3]
    const countryRegionId = flags >> 2
    const polarity = flags & 0x01
    const offsetMinutes = bcdToNumber(data[offset + 4]) * 60 + bcdToNumber(data[offset + 5])
    const changeTime = parseMjdTime(data, offset + 6)
    const nextOffsetMinutes = bcdToNumber(data[offset + 11]) * 60 + bcdToNumber(data[offset + 12])
    entries.push({
      countryCode,
      countryRegionId,
      polarity,
      offsetMinutes,
      changeTime,
      nextOffsetMinutes,
    })
    offset += 13
  }
  return entries
}

export function decodeAvcVideo(data: Uint8Array): AvcConfig {
  return {
    configurationVersion: data[0],
    avcProfileIndication: data[1],
    profileCompatibility: data[2],
    avcLevelIndication: data[3],
    description: data.slice(0),
  }
}

export interface DataComponentInfo {
  dataComponentId: number
  data: Uint8Array
}

export function decodeDataComponent(data: Uint8Array): DataComponentInfo {
  return { dataComponentId: (data[0] << 8) | data[1], data: data.slice(2) }
}

export function decodeStreamIdentifier(data: Uint8Array): number {
  return data[0]
}

export { DescriptorTag }
