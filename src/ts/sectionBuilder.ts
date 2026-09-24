import { crc32 } from './crc32'
import { TS_PACKET_SIZE, TS_SYNC_BYTE } from './packet'
import { calendarToMjd, numberToBcd } from './sections/tstime'

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff]
}

function withCrc(bytes: number[]): Uint8Array {
  const body = Uint8Array.from(bytes)
  const crc = crc32(body)
  return Uint8Array.from([
    ...bytes,
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
  ])
}

export interface LongSectionOptions {
  sectionNumber?: number
  lastSectionNumber?: number
}

export function buildLongSection(
  tableId: number,
  tableIdExtension: number,
  version: number,
  body: number[],
  options: LongSectionOptions = {},
): Uint8Array {
  const sectionNumber = options.sectionNumber ?? 0
  const lastSectionNumber = options.lastSectionNumber ?? 0
  const fields = [
    ...u16(tableIdExtension),
    (version << 1) | 0x01,
    sectionNumber,
    lastSectionNumber,
    ...body,
  ]
  const sectionLength = fields.length + 4
  return withCrc([tableId, 0xb0 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff, ...fields])
}

export function buildDescriptor(tag: number, data: number[] | Uint8Array): number[] {
  const bytes = Array.isArray(data) ? data : Array.from(data)
  return [tag, bytes.length, ...bytes]
}

const ARIB_GR: Record<string, number[]> = {
  Ｎ: [0xa3, 0xce],
  Ｈ: [0xa3, 0xc8],
  Ｋ: [0xa3, 0xcb],
  総: [0xc1, 0xed],
  合: [0xb9, 0xe7],
  こ: [0xa4, 0xb3],
  ん: [0xa4, 0xf3],
  に: [0xa4, 0xcb],
  ち: [0xa4, 0xc1],
  は: [0xa4, 0xcf],
  テ: [0xa5, 0xc6],
  ス: [0xa5, 0xb9],
  ト: [0xa5, 0xc8],
}

export function encodeAribText(text: string): Uint8Array {
  const bytes: number[] = []
  let ascii = false
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code >= 0x20 && code <= 0x7e) {
      if (!ascii) bytes.push(0x0e)
      ascii = true
      bytes.push(code)
      continue
    }
    const pair = ARIB_GR[char]
    if (!pair) throw new Error(`encodeAribText: unsupported character ${char}`)
    if (ascii) bytes.push(0x0f)
    ascii = false
    bytes.push(...pair.map((byte) => byte & 0x7f))
  }
  return Uint8Array.from(bytes)
}

export function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff))
}

export function buildServiceDescriptor(
  serviceType: number,
  provider: Uint8Array,
  name: Uint8Array,
): number[] {
  return buildDescriptor(0x48, [
    serviceType,
    provider.length,
    ...Array.from(provider),
    name.length,
    ...Array.from(name),
  ])
}

export function buildShortEvent(language: string, name: Uint8Array, text: Uint8Array): number[] {
  return buildDescriptor(0x4d, [
    ...Array.from(asciiBytes(language)).slice(0, 3),
    name.length,
    ...Array.from(name),
    text.length,
    ...Array.from(text),
  ])
}

export function buildExtendedEvent(
  text: Uint8Array,
  items: { description: Uint8Array; text: Uint8Array }[] = [],
): number[] {
  const itemBytes: number[] = []
  for (const item of items) {
    itemBytes.push(item.description.length, ...Array.from(item.description))
    itemBytes.push(item.text.length, ...Array.from(item.text))
  }
  return buildDescriptor(0x4e, [
    0x00,
    0x6a,
    0x70,
    0x6e,
    itemBytes.length,
    ...itemBytes,
    text.length,
    ...Array.from(text),
  ])
}

export function buildContent(genres: number[]): number[] {
  const data: number[] = []
  for (const genre of genres) {
    data.push(genre & 0xff, 0x00)
  }
  return buildDescriptor(0x54, data)
}

export function buildDataComponent(dataComponentId: number, extra: number[] = []): number[] {
  return buildDescriptor(0xc9, [(dataComponentId >> 8) & 0xff, dataComponentId & 0xff, ...extra])
}

export function buildAvcVideo(profile: number, compatibility: number, level: number): number[] {
  return buildDescriptor(0x28, [1, profile, compatibility, level])
}

export function buildNetworkName(name: Uint8Array): number[] {
  return buildDescriptor(0x40, Array.from(name))
}

export function buildLocalTimeOffset(
  countryCode: string,
  offsetMinutes: number,
  polarity: number,
  changeTime: Date,
  nextOffsetMinutes: number,
): number[] {
  const code = [...asciiBytes(countryCode)].slice(0, 3)
  const data = [
    ...code,
    0x02 | (polarity & 0x01),
    numberToBcd(Math.floor(offsetMinutes / 60)),
    numberToBcd(offsetMinutes % 60),
    ...encodeUtcTime(changeTime),
    numberToBcd(Math.floor(nextOffsetMinutes / 60)),
    numberToBcd(nextOffsetMinutes % 60),
  ]
  return buildDescriptor(0x58, data)
}

function encodeMjd(date: Date): number[] {
  const mjd = calendarToMjd({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  })
  return u16(mjd)
}

export function encodeUtcTime(date: Date): number[] {
  return [
    ...encodeMjd(date),
    numberToBcd(date.getUTCHours()),
    numberToBcd(date.getUTCMinutes()),
    numberToBcd(date.getUTCSeconds()),
  ]
}

export function encodeJstTime(date: Date): number[] {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000)
  return encodeUtcTime(jst)
}

export interface PatBuilderOptions {
  transportStreamId: number
  version?: number
  programs: { programNumber: number; pid: number }[]
  networkPid?: number
}

export function buildPat(options: PatBuilderOptions): Uint8Array {
  const body: number[] = []
  for (const program of options.programs) {
    body.push(...u16(program.programNumber), ...u16(program.pid & 0x1fff))
  }
  if (options.networkPid !== undefined) body.push(...u16(0), ...u16(options.networkPid & 0x1fff))
  return buildLongSection(0x00, options.transportStreamId, options.version ?? 0, body)
}

export interface PmtBuilderStream {
  streamType: number
  pid: number
  descriptors?: number[]
}

export interface PmtBuilderOptions {
  programNumber: number
  version?: number
  pcrPid: number
  programInfo?: number[]
  streams: PmtBuilderStream[]
}

export function buildPmt(options: PmtBuilderOptions): Uint8Array {
  const programInfo = options.programInfo ?? []
  const body: number[] = [
    ...u16(options.pcrPid & 0x1fff),
    0xf0 | ((programInfo.length >> 8) & 0x0f),
    programInfo.length & 0xff,
    ...programInfo,
  ]
  for (const stream of options.streams) {
    const descriptors = stream.descriptors ?? []
    body.push(
      stream.streamType,
      ...u16(stream.pid & 0x1fff),
      0xf0 | ((descriptors.length >> 8) & 0x0f),
      descriptors.length & 0xff,
      ...descriptors,
    )
  }
  return buildLongSection(0x02, options.programNumber, options.version ?? 0, body)
}

export interface SdtBuilderService {
  serviceId: number
  serviceType: number
  provider: Uint8Array
  name: Uint8Array
  runningStatus?: number
}

export interface SdtBuilderOptions {
  transportStreamId: number
  originalNetworkId: number
  version?: number
  services: SdtBuilderService[]
}

export function buildSdt(options: SdtBuilderOptions): Uint8Array {
  const body: number[] = [...u16(options.originalNetworkId), 0xff]
  for (const service of options.services) {
    const descriptor = buildServiceDescriptor(service.serviceType, service.provider, service.name)
    const runningStatus = service.runningStatus ?? 0
    body.push(
      ...u16(service.serviceId),
      0xfc,
      ((runningStatus & 0x07) << 5) | ((descriptor.length >> 8) & 0x0f),
      descriptor.length & 0xff,
      ...descriptor,
    )
  }
  return buildLongSection(0x42, options.transportStreamId, options.version ?? 0, body)
}

export interface EitBuilderEvent {
  eventId: number
  startTime: Date
  duration: number
  runningStatus?: number
  title?: Uint8Array
  text?: Uint8Array
  extendedText?: Uint8Array
  genres?: number[]
}

export interface EitBuilderOptions {
  tableId: number
  serviceId: number
  transportStreamId: number
  originalNetworkId: number
  version?: number
  events: EitBuilderEvent[]
}

export function buildEit(options: EitBuilderOptions): Uint8Array {
  const body: number[] = [
    ...u16(options.transportStreamId),
    ...u16(options.originalNetworkId),
    0x00,
    options.tableId,
  ]
  for (const event of options.events) {
    const descriptors: number[] = []
    if (event.title)
      descriptors.push(...buildShortEvent('jpn', event.title, event.text ?? new Uint8Array(0)))
    if (event.extendedText) descriptors.push(...buildExtendedEvent(event.extendedText))
    if (event.genres) descriptors.push(...buildContent(event.genres))
    const hours = Math.floor(event.duration / 3600)
    const minutes = Math.floor((event.duration % 3600) / 60)
    const seconds = event.duration % 60
    body.push(
      ...u16(event.eventId),
      ...encodeJstTime(event.startTime),
      numberToBcd(hours),
      numberToBcd(minutes),
      numberToBcd(seconds),
      ((event.runningStatus ?? 0) << 5) | ((descriptors.length >> 8) & 0x0f),
      descriptors.length & 0xff,
      ...descriptors,
    )
  }
  return buildLongSection(options.tableId, options.serviceId, options.version ?? 0, body)
}

export interface NitBuilderTs {
  transportStreamId: number
  originalNetworkId: number
  descriptors?: number[]
}

export interface NitBuilderOptions {
  networkId: number
  version?: number
  networkName?: Uint8Array
  networkDescriptors?: number[]
  transportStreams: NitBuilderTs[]
}

export function buildNit(options: NitBuilderOptions): Uint8Array {
  const networkDescriptors =
    options.networkDescriptors ?? (options.networkName ? buildNetworkName(options.networkName) : [])

  const loop: number[] = []
  for (const ts of options.transportStreams) {
    const descriptors = ts.descriptors ?? []
    loop.push(
      ...u16(ts.transportStreamId),
      ...u16(ts.originalNetworkId),
      0xf0 | ((descriptors.length >> 8) & 0x0f),
      descriptors.length & 0xff,
      ...descriptors,
    )
  }

  const body: number[] = [
    0xf0 | ((networkDescriptors.length >> 8) & 0x0f),
    networkDescriptors.length & 0xff,
    ...networkDescriptors,
    0xf0 | ((loop.length >> 8) & 0x0f),
    loop.length & 0xff,
    ...loop,
  ]
  return buildLongSection(0x40, options.networkId, options.version ?? 0, body)
}

export function buildTdt(date: Date): Uint8Array {
  const utc = encodeUtcTime(date)
  const sectionLength = utc.length
  return Uint8Array.from([0x70, 0x70 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff, ...utc])
}

export function buildTot(
  date: Date,
  offsetMinutes = 540,
  polarity = 0,
  options: { countryCode?: string; changeTime?: Date; nextOffsetMinutes?: number } = {},
): Uint8Array {
  const utc = encodeUtcTime(date)
  const descriptor = buildLocalTimeOffset(
    options.countryCode ?? 'JPN',
    offsetMinutes,
    polarity,
    options.changeTime ?? date,
    options.nextOffsetMinutes ?? offsetMinutes,
  )
  const descriptorsLength = descriptor.length
  const sectionLength = utc.length + 2 + descriptorsLength + 4
  return withCrc([
    0x73,
    0x70 | ((sectionLength >> 8) & 0x0f),
    sectionLength & 0xff,
    ...utc,
    0xf0 | ((descriptorsLength >> 8) & 0x0f),
    descriptorsLength & 0xff,
    ...descriptor,
  ])
}

function encodeTimestamp(value: number, marker: number): number[] {
  const b0 = (marker << 4) | ((Math.floor(value / 0x40000000) & 0x07) << 1) | 0x01
  const b1 = Math.floor(value / 0x400000) & 0xff
  const b2 = ((Math.floor(value / 0x8000) & 0x7f) << 1) | 0x01
  const b3 = Math.floor(value / 0x80) & 0xff
  const b4 = ((value & 0x7f) << 1) | 0x01
  return [b0, b1, b2, b3, b4]
}

export interface PesBuilderOptions {
  pts?: number
  dts?: number
  packetLength?: number
}

export function buildPes(
  streamId: number,
  payload: Uint8Array,
  options: PesBuilderOptions = {},
): Uint8Array {
  const ptsDtsFlags = options.pts !== undefined ? (options.dts !== undefined ? 0x03 : 0x02) : 0x00
  const optional: number[] = []
  if (options.pts !== undefined) optional.push(...encodeTimestamp(options.pts, 0x02))
  if (options.dts !== undefined) optional.push(...encodeTimestamp(options.dts, 0x01))
  const header = [0x80, ptsDtsFlags << 6, optional.length, ...optional]
  const packetLength = options.packetLength ?? header.length + payload.length
  return Uint8Array.from([
    0x00,
    0x00,
    0x01,
    streamId,
    (packetLength >> 8) & 0xff,
    packetLength & 0xff,
    ...header,
    ...Array.from(payload),
  ])
}

export function pesToPackets(pid: number, pes: Uint8Array, ccStart = 0): Uint8Array {
  const payloads: { pusi: boolean; data: Uint8Array }[] = []
  for (let offset = 0; offset < pes.length; offset += TS_PACKET_SIZE - 4) {
    payloads.push({ pusi: offset === 0, data: pes.subarray(offset, offset + TS_PACKET_SIZE - 4) })
  }
  return buildTsPackets(pid, payloads, ccStart)
}

export function buildTsPackets(
  pid: number,
  payloads: { pusi: boolean; data: Uint8Array }[],
  ccStart = 0,
): Uint8Array {
  const out: number[] = []
  let cc = ccStart & 0x0f
  for (const { pusi, data } of payloads) {
    if (data.length > TS_PACKET_SIZE - 4) throw new Error('payload exceeds packet size')
    const padding = TS_PACKET_SIZE - 4 - data.length
    let adaptation: number[] = []
    let adaptationFieldControl = 1
    if (padding === 1) {
      adaptation = [0]
      adaptationFieldControl = 3
    } else if (padding > 1) {
      adaptation = [padding - 1, 0x00, ...Array.from({ length: padding - 2 }, () => 0xff)]
      adaptationFieldControl = 3
    }
    out.push(
      TS_SYNC_BYTE,
      (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f),
      pid & 0xff,
      (adaptationFieldControl << 4) | cc,
      ...adaptation,
      ...Array.from(data),
    )
    cc = (cc + 1) & 0x0f
  }
  return Uint8Array.from(out)
}

export function sectionToPackets(section: Uint8Array, pid: number, ccStart = 0): Uint8Array {
  const first = new Uint8Array(section.length + 1)
  first[0] = 0
  first.set(section, 1)
  const payloads: { pusi: boolean; data: Uint8Array }[] = []
  for (let offset = 0; offset < first.length; offset += TS_PACKET_SIZE - 4) {
    payloads.push({ pusi: offset === 0, data: first.subarray(offset, offset + TS_PACKET_SIZE - 4) })
  }
  return buildTsPackets(pid, payloads, ccStart)
}
