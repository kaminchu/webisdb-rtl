import { verifySectionCrc } from './crc32'
import type { TsPacket } from './packet'

const MAX_SECTION_LENGTH = 4096
const TOT_TABLE_ID = 0x73

export interface SectionAssemblerOptions {
  validateCrc?: boolean
}

export class SectionAssembler {
  private readonly buffers = new Map<number, Uint8Array>()
  private readonly validateCrc: boolean

  constructor(options: SectionAssemblerOptions = {}) {
    this.validateCrc = options.validateCrc ?? true
  }

  push(packet: TsPacket): Uint8Array[] {
    if (packet.transportErrorIndicator) return []
    const payload = packet.payload
    if (payload.length === 0) return []

    const pid = packet.pid
    const sections: Uint8Array[] = []

    if (packet.payloadUnitStartIndicator) {
      const pointer = Math.min(payload[0], payload.length - 1)
      const after = payload.subarray(1)
      if (pointer > 0 && this.buffers.has(pid)) {
        sections.push(...this.append(pid, after.subarray(0, pointer)))
      }
      this.buffers.delete(pid)
      sections.push(...this.append(pid, after.subarray(pointer)))
    } else {
      if (!this.buffers.has(pid)) return []
      sections.push(...this.append(pid, payload))
    }

    return sections
  }

  reset(): void {
    this.buffers.clear()
  }

  private append(pid: number, bytes: Uint8Array): Uint8Array[] {
    const previous = this.buffers.get(pid)
    let buffer: Uint8Array
    if (previous && previous.length > 0) {
      buffer = new Uint8Array(previous.length + bytes.length)
      buffer.set(previous)
      buffer.set(bytes, previous.length)
    } else {
      buffer = bytes
    }

    const sections: Uint8Array[] = []
    let offset = 0
    while (offset + 3 <= buffer.length) {
      const sectionLength = ((buffer[offset + 1] & 0x0f) << 8) | buffer[offset + 2]
      const total = 3 + sectionLength
      if (total > MAX_SECTION_LENGTH) {
        this.buffers.delete(pid)
        return sections
      }
      if (buffer.length - offset < total) break
      const section = buffer.slice(offset, offset + total)
      if (this.isValid(section)) sections.push(section)
      offset += total
    }

    const rest = buffer.slice(offset)
    if (rest.length > 0) this.buffers.set(pid, rest)
    else this.buffers.delete(pid)
    return sections
  }

  private isValid(section: Uint8Array): boolean {
    const tableId = section[0]
    const syntax = (section[1] & 0x80) !== 0
    const hasCrc = syntax || tableId === TOT_TABLE_ID
    if (!hasCrc) return true
    if (!this.validateCrc) return true
    return verifySectionCrc(section)
  }
}
