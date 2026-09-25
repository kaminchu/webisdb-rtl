import { DescriptorTag } from '../models/descriptor'
import type { PesPacket } from '../models/media'
import type {
  EitSection,
  NitSection,
  PatSection,
  PmtSection,
  PmtStream,
  SdtSection,
  TdtSection,
  TotSection,
} from '../models/si'
import type { StreamKind } from '../models/transportStream'
import { decodeDataComponent } from './descriptors'
import { PacketReader } from './packet'
import type { TsPacket } from './packet'
import { decodeEit, isEitTableId } from './sections/eit'
import { decodeNit } from './sections/nit'
import { decodePat } from './sections/pat'
import { decodePmt } from './sections/pmt'
import { decodeSdt } from './sections/sdt'
import { decodeTdt, decodeTot } from './sections/tdtTot'
import { SectionAssembler } from './sections'

const PID_PAT = 0x0000
const PID_NIT = 0x0010
const PID_SDT = 0x0011
const PID_EIT = 0x0012
const PID_TDT_TOT = 0x0014
const PID_EIT_MOBILE = 0x0026
const PID_EIT_PARTIAL = 0x0027

/** ARIB STD-B10 Table 5-1: terrestrial EIT is carried on 0x12, 0x26 and 0x27. */
const EIT_PIDS = new Set([PID_EIT, PID_EIT_MOBILE, PID_EIT_PARTIAL])

/**
 * ISDB-T one-seg PMT PID range. The partial-reception stream carries no
 * decodable PAT, so the PMT is discovered directly on these PIDs.
 */
const PID_ONESEG_PMT_MIN = 0x1fc8
const PID_ONESEG_PMT_MAX = 0x1fcf

const TABLE_PAT = 0x00
const TABLE_PMT = 0x02
const TABLE_NIT_ACTUAL = 0x40
const TABLE_NIT_OTHER = 0x41
const TABLE_SDT_ACTUAL = 0x42
const TABLE_SDT_OTHER = 0x46
const TABLE_TDT = 0x70
const TABLE_TOT = 0x73

const STREAM_TYPE_VIDEO = 0x1b
const STREAM_TYPE_AUDIO = 0x0f
const STREAM_TYPE_PRIVATE = 0x06
const DATA_COMPONENT_CAPTION = 0x0008
const DATA_COMPONENT_ONESEG_CAPTION = 0x0012

// ISO/IEC 13818-1 PES syntax: these stream IDs have no optional PES header.
const PES_WITHOUT_OPTIONAL_HEADER = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff])

/** Cap a length-0 (unbounded) PES assembly so a missing PUSI cannot leak memory. */
const MAX_PES_ASSEMBLY_BYTES = 1 << 20

export interface DemuxerCallbacks {
  onPat?: (section: PatSection) => void
  onPmt?: (section: PmtSection) => void
  onSdt?: (section: SdtSection) => void
  onEit?: (section: EitSection) => void
  onNit?: (section: NitSection) => void
  onTdt?: (section: TdtSection) => void
  onTot?: (section: TotSection) => void
  onPes?: (packet: PesPacket) => void
  onPacket?: (packet: TsPacket) => void
}

interface PesAssembly {
  chunks: Uint8Array[]
  length: number
}

interface StreamInfo {
  kind: StreamKind
  streamType: number
}

export function classifyStream(stream: PmtStream): StreamKind {
  if (stream.streamType === STREAM_TYPE_VIDEO) return 'video'
  if (stream.streamType === STREAM_TYPE_AUDIO) return 'audio'
  if (stream.streamType === STREAM_TYPE_PRIVATE) {
    const descriptor = stream.descriptors.find((item) => item.tag === DescriptorTag.DataComponent)
    if (descriptor) {
      const id = decodeDataComponent(descriptor.data).dataComponentId
      if (id === DATA_COMPONENT_CAPTION || id === DATA_COMPONENT_ONESEG_CAPTION) return 'caption'
    }
    return 'data'
  }
  return 'other'
}

export class Demuxer {
  private readonly callbacks: DemuxerCallbacks
  private readonly reader = new PacketReader()
  private readonly sections = new SectionAssembler()
  private readonly pmtPids = new Set<number>()
  private readonly pmts = new Map<number, PmtSection>()
  private readonly programPids = new Map<number, number>()
  private readonly selectedStreams = new Map<number, StreamInfo>()
  private readonly pesBuffers = new Map<number, PesAssembly>()
  private selectedServiceId: number | null = null

  constructor(callbacks: DemuxerCallbacks = {}) {
    this.callbacks = callbacks
  }

  push(bytes: Uint8Array): void {
    for (const packet of this.reader.push(bytes)) this.pushPacket(packet)
  }

  pushPacket(packet: TsPacket): void {
    this.callbacks.onPacket?.(packet)
    if (packet.transportErrorIndicator) return

    if (this.isSectionPid(packet.pid)) {
      for (const section of this.sections.push(packet)) this.dispatchSection(packet.pid, section)
      return
    }

    if (this.selectedStreams.has(packet.pid)) this.assemblePes(packet)
  }

  selectService(serviceId: number): void {
    this.selectedServiceId = serviceId
    this.selectedStreams.clear()
    this.pesBuffers.clear()
    const pmt = this.pmts.get(serviceId)
    if (pmt) this.applySelectedPmt(pmt)
  }

  get selectedService(): number | null {
    return this.selectedServiceId
  }

  reset(): void {
    this.reader.reset()
    this.sections.reset()
    this.pmtPids.clear()
    this.pmts.clear()
    this.programPids.clear()
    this.selectedStreams.clear()
    this.pesBuffers.clear()
    this.selectedServiceId = null
  }

  private isOneSegPmt(pid: number): boolean {
    return pid >= PID_ONESEG_PMT_MIN && pid <= PID_ONESEG_PMT_MAX
  }

  private isSectionPid(pid: number): boolean {
    return (
      pid === PID_PAT ||
      pid === PID_NIT ||
      pid === PID_SDT ||
      EIT_PIDS.has(pid) ||
      pid === PID_TDT_TOT ||
      this.pmtPids.has(pid) ||
      this.isOneSegPmt(pid)
    )
  }

  private dispatchSection(pid: number, section: Uint8Array): void {
    const tableId = section[0]
    if (pid === PID_PAT && tableId === TABLE_PAT) {
      this.handlePat(section)
    } else if ((this.pmtPids.has(pid) || this.isOneSegPmt(pid)) && tableId === TABLE_PMT) {
      this.handlePmt(section)
    } else if (pid === PID_SDT && (tableId === TABLE_SDT_ACTUAL || tableId === TABLE_SDT_OTHER)) {
      this.callbacks.onSdt?.(decodeSdt(section))
    } else if (EIT_PIDS.has(pid) && isEitTableId(tableId)) {
      this.callbacks.onEit?.(decodeEit(section))
    } else if (pid === PID_NIT && (tableId === TABLE_NIT_ACTUAL || tableId === TABLE_NIT_OTHER)) {
      this.callbacks.onNit?.(decodeNit(section))
    } else if (pid === PID_TDT_TOT && tableId === TABLE_TDT) {
      this.callbacks.onTdt?.(decodeTdt(section))
    } else if (pid === PID_TDT_TOT && tableId === TABLE_TOT) {
      this.callbacks.onTot?.(decodeTot(section))
    }
  }

  private handlePat(section: Uint8Array): void {
    const pat = decodePat(section)
    for (const program of pat.programs) {
      this.pmtPids.add(program.pid)
      this.programPids.set(program.programNumber, program.pid)
    }
    if (this.selectedServiceId === null && pat.programs.length > 0) {
      this.selectService(pat.programs[0].programNumber)
    }
    this.callbacks.onPat?.(pat)
  }

  private handlePmt(section: Uint8Array): void {
    const pmt = decodePmt(section)
    this.pmts.set(pmt.programNumber, pmt)
    if (this.selectedServiceId === null) this.selectService(pmt.programNumber)
    else if (pmt.programNumber === this.selectedServiceId) this.applySelectedPmt(pmt)
    this.callbacks.onPmt?.(pmt)
  }

  private applySelectedPmt(pmt: PmtSection): void {
    this.selectedStreams.clear()
    for (const stream of pmt.streams) {
      this.selectedStreams.set(stream.pid, {
        kind: classifyStream(stream),
        streamType: stream.streamType,
      })
    }
  }

  private assemblePes(packet: TsPacket): void {
    const pid = packet.pid
    const payload = packet.payload
    if (payload.length === 0) return

    if (packet.payloadUnitStartIndicator) {
      const previous = this.pesBuffers.get(pid)
      if (previous) {
        this.pesBuffers.delete(pid)
        this.emitPes(pid, previous)
      }
      this.pesBuffers.set(pid, { chunks: [payload], length: payload.length })
    } else {
      const current = this.pesBuffers.get(pid)
      if (!current) return
      current.chunks.push(payload)
      current.length += payload.length
    }

    const current = this.pesBuffers.get(pid)
    if (!current) return
    if (this.isPesComplete(current)) {
      this.pesBuffers.delete(pid)
      this.emitPes(pid, current)
    } else if (current.length > MAX_PES_ASSEMBLY_BYTES) {
      this.pesBuffers.delete(pid)
    }
  }

  private isPesComplete(assembly: PesAssembly): boolean {
    if (assembly.length < 6) return false
    const header = assembly.chunks[0]
    if (header.length < 6) return false
    const packetLength = (header[4] << 8) | header[5]
    if (packetLength === 0) return false
    return assembly.length >= 6 + packetLength
  }

  private emitPes(pid: number, assembly: PesAssembly): void {
    const buffer = new Uint8Array(assembly.length)
    let position = 0
    for (const chunk of assembly.chunks) {
      buffer.set(chunk, position)
      position += chunk.length
    }

    if (buffer.length < 6) return
    if (buffer[0] !== 0x00 || buffer[1] !== 0x00 || buffer[2] !== 0x01) return

    const streamId = buffer[3]
    const packetLength = (buffer[4] << 8) | buffer[5]

    let offset = 6
    let pts: number | undefined
    let dts: number | undefined
    if (!PES_WITHOUT_OPTIONAL_HEADER.has(streamId) && offset + 3 <= buffer.length) {
      const flags = buffer[offset + 1]
      const headerDataLength = buffer[offset + 2]
      const ptsDtsFlags = (flags >> 6) & 0x03
      let cursor = offset + 3
      if ((ptsDtsFlags & 0x02) !== 0 && cursor + 5 <= buffer.length) {
        pts = readTimestamp(buffer, cursor)
        cursor += 5
      }
      if ((ptsDtsFlags & 0x01) !== 0 && cursor + 5 <= buffer.length) {
        dts = readTimestamp(buffer, cursor)
        cursor += 5
      }
      offset = offset + 3 + headerDataLength
    }

    let data = buffer.subarray(Math.min(offset, buffer.length))
    if (packetLength > 0) {
      const payloadLength = packetLength - (offset - 6)
      if (payloadLength >= 0 && data.length > payloadLength) data = data.subarray(0, payloadLength)
    }

    const info = this.selectedStreams.get(pid)
    const stream: PesPacket = {
      pid,
      kind: info?.kind ?? 'other',
      streamId,
      data: data.slice(0),
      ...(pts !== undefined ? { pts } : {}),
      ...(dts !== undefined ? { dts } : {}),
    }
    this.callbacks.onPes?.(stream)
  }
}

function readTimestamp(bytes: Uint8Array, offset: number): number {
  const b0 = (bytes[offset] >> 1) & 0x07
  const b1 = bytes[offset + 1]
  const b2 = (bytes[offset + 2] >> 1) & 0x7f
  const b3 = bytes[offset + 3]
  const b4 = (bytes[offset + 4] >> 1) & 0x7f
  return b0 * 0x40000000 + b1 * 0x400000 + b2 * 0x8000 + b3 * 0x80 + b4
}
