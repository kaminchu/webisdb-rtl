import type { PidStat, TsStatistics } from '../models/si'
import { TS_PACKET_SIZE } from './packet'
import type { TsPacket } from './packet'

export interface StatisticsOptions {
  windowMs?: number
  now?: () => number
  packetSize?: number
}

interface WindowSample {
  time: number
  packets: number
}

interface StreamTypeInfo {
  streamType: number
  description?: string
}

export class TsStatisticsCollector {
  private packets = 0
  private packetsWithError = 0
  private ccErrors = 0
  private bytes = 0
  private readonly pidCounts = new Map<number, number>()
  private readonly lastContinuity = new Map<number, number>()
  private readonly streamTypes = new Map<number, StreamTypeInfo>()
  private window: WindowSample[] = []
  private readonly windowMs: number
  private readonly now: () => number
  private readonly packetSize: number

  constructor(options: StatisticsOptions = {}) {
    this.windowMs = options.windowMs ?? 1000
    this.now = options.now ?? Date.now
    this.packetSize = options.packetSize ?? TS_PACKET_SIZE
  }

  record(packet: TsPacket, byteLength = this.packetSize): void {
    this.packets++
    this.bytes += byteLength
    if (packet.transportErrorIndicator) this.packetsWithError++

    this.pidCounts.set(packet.pid, (this.pidCounts.get(packet.pid) ?? 0) + 1)

    if (packet.payload.length > 0) {
      const previous = this.lastContinuity.get(packet.pid)
      if (previous !== undefined && packet.continuityCounter !== ((previous + 1) & 0x0f)) {
        this.ccErrors++
      }
    }
    this.lastContinuity.set(packet.pid, packet.continuityCounter)

    const time = this.now()
    this.window.push({ time, packets: this.packets })
    const cutoff = time - this.windowMs
    while (this.window.length > 1 && this.window[0].time < cutoff) this.window.shift()
  }

  setStreamType(pid: number, streamType: number, description?: string): void {
    this.streamTypes.set(pid, { streamType, ...(description !== undefined ? { description } : {}) })
  }

  snapshot(): TsStatistics {
    const time = this.now()
    const oldest = this.window.length > 0 ? this.window[0] : { time, packets: this.packets }
    const elapsed = (time - oldest.time) / 1000
    const packetsInWindow = this.packets - oldest.packets
    const bitrate = elapsed > 0 ? Math.round((packetsInWindow * this.packetSize * 8) / elapsed) : 0

    const pids: PidStat[] = [...this.pidCounts.entries()]
      .map(([pid, packets]) => {
        const info = this.streamTypes.get(pid)
        return {
          pid,
          packets,
          ...(info ? { streamType: info.streamType } : {}),
          ...(info?.description !== undefined ? { description: info.description } : {}),
        }
      })
      .toSorted((a, b) => a.pid - b.pid)

    return {
      packets: this.packets,
      packetsWithError: this.packetsWithError,
      ccErrors: this.ccErrors,
      bytes: this.bytes,
      bitrate,
      pids,
    }
  }

  reset(): void {
    this.packets = 0
    this.packetsWithError = 0
    this.ccErrors = 0
    this.bytes = 0
    this.pidCounts.clear()
    this.lastContinuity.clear()
    this.streamTypes.clear()
    this.window = []
  }
}
