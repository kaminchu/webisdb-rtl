export const TS_PACKET_SIZE = 188
export const TS_SYNC_BYTE = 0x47

export interface TsPacket {
  pid: number
  transportErrorIndicator: boolean
  payloadUnitStartIndicator: boolean
  transportPriority: boolean
  scramblingControl: number
  adaptationFieldControl: number
  continuityCounter: number
  discontinuityIndicator: boolean
  randomAccessIndicator: boolean
  /** PCR value in 27 MHz units (base * 300 + extension), if signalled. */
  pcr?: number
  payload: Uint8Array
}

export function findSyncByte(bytes: Uint8Array, start = 0): number {
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === TS_SYNC_BYTE) return i
  }
  return -1
}

export function parsePacket(bytes: Uint8Array, offset = 0): TsPacket | null {
  if (offset + TS_PACKET_SIZE > bytes.length) return null
  if (bytes[offset] !== TS_SYNC_BYTE) return null

  const b1 = bytes[offset + 1]
  const b2 = bytes[offset + 2]
  const b3 = bytes[offset + 3]
  const pid = ((b1 & 0x1f) << 8) | b2
  const adaptationFieldControl = (b3 >> 4) & 0x03

  let discontinuityIndicator = false
  let randomAccessIndicator = false
  let pcr: number | undefined
  let payloadStart = offset + 4

  if (adaptationFieldControl === 2 || adaptationFieldControl === 3) {
    const afLength = bytes[offset + 4]
    if (afLength > 0) {
      const flags = bytes[offset + 5]
      discontinuityIndicator = (flags & 0x80) !== 0
      randomAccessIndicator = (flags & 0x40) !== 0
      if ((flags & 0x10) !== 0 && afLength >= 7) {
        const p0 = bytes[offset + 6]
        const p1 = bytes[offset + 7]
        const p2 = bytes[offset + 8]
        const p3 = bytes[offset + 9]
        const p4 = bytes[offset + 10]
        const p5 = bytes[offset + 11]
        const base = p0 * 0x2000000 + ((p1 << 17) | (p2 << 9) | (p3 << 1) | ((p4 >> 7) & 0x01))
        const extension = ((p4 & 0x01) << 8) | p5
        pcr = base * 300 + extension
      }
    }
    payloadStart = Math.min(offset + 5 + afLength, offset + TS_PACKET_SIZE)
  }

  const hasPayload = adaptationFieldControl === 1 || adaptationFieldControl === 3
  const payload = hasPayload
    ? bytes.subarray(payloadStart, offset + TS_PACKET_SIZE)
    : bytes.subarray(offset + TS_PACKET_SIZE, offset + TS_PACKET_SIZE)

  return {
    pid,
    transportErrorIndicator: (b1 & 0x80) !== 0,
    payloadUnitStartIndicator: (b1 & 0x40) !== 0,
    transportPriority: (b1 & 0x20) !== 0,
    scramblingControl: (b3 >> 6) & 0x03,
    adaptationFieldControl,
    continuityCounter: b3 & 0x0f,
    discontinuityIndicator,
    randomAccessIndicator,
    payload,
    ...(pcr !== undefined ? { pcr } : {}),
  }
}

export class PacketReader {
  private buffer = new Uint8Array(0)

  push(bytes: Uint8Array): TsPacket[] {
    let data: Uint8Array
    if (this.buffer.length === 0) {
      data = bytes
    } else {
      data = new Uint8Array(this.buffer.length + bytes.length)
      data.set(this.buffer)
      data.set(bytes, this.buffer.length)
    }

    const packets: TsPacket[] = []
    let offset = 0
    while (offset + TS_PACKET_SIZE <= data.length) {
      if (data[offset] !== TS_SYNC_BYTE) {
        const next = findSyncByte(data, offset + 1)
        if (next < 0) {
          offset = data.length
          break
        }
        offset = next
        continue
      }
      const packet = parsePacket(data, offset)
      if (packet) packets.push(packet)
      offset += TS_PACKET_SIZE
    }

    this.buffer = data.slice(offset)
    return packets
  }

  reset(): void {
    this.buffer = new Uint8Array(0)
  }

  get bufferedBytes(): number {
    return this.buffer.length
  }
}
