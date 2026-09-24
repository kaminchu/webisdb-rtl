import type { TsStatistics } from '../models/si'
import { Demuxer } from './demuxer'
import type { DemuxerCallbacks } from './demuxer'
import { PacketReader } from './packet'
import { TsStatisticsCollector } from './statistics'
import type { StatisticsOptions } from './statistics'

export interface TransportStreamCallbacks extends DemuxerCallbacks {
  onStatistics?: (statistics: TsStatistics) => void
}

export function describeStreamType(streamType: number): string {
  switch (streamType) {
    case 0x1b:
      return 'AVC video'
    case 0x0f:
      return 'AAC audio'
    case 0x06:
      return 'data / caption'
    case 0x1c:
      return 'HEVC video'
    default:
      return `0x${streamType.toString(16).padStart(2, '0')}`
  }
}

export class TransportStream {
  private readonly reader = new PacketReader()
  private readonly demuxer: Demuxer
  private readonly statistics: TsStatisticsCollector
  private readonly callbacks: TransportStreamCallbacks

  constructor(callbacks: TransportStreamCallbacks = {}, options: StatisticsOptions = {}) {
    this.callbacks = callbacks
    this.statistics = new TsStatisticsCollector(options)
    this.demuxer = new Demuxer({
      ...callbacks,
      onPmt: (pmt) => {
        for (const stream of pmt.streams) {
          this.statistics.setStreamType(
            stream.pid,
            stream.streamType,
            describeStreamType(stream.streamType),
          )
        }
        callbacks.onPmt?.(pmt)
      },
    })
  }

  push(bytes: Uint8Array): void {
    for (const packet of this.reader.push(bytes)) {
      this.statistics.record(packet)
      this.demuxer.pushPacket(packet)
    }
    this.callbacks.onStatistics?.(this.statistics.snapshot())
  }

  reset(): void {
    this.reader.reset()
    this.demuxer.reset()
    this.statistics.reset()
  }

  selectService(id: number): void {
    this.demuxer.selectService(id)
  }

  get selectedService(): number | null {
    return this.demuxer.selectedService
  }

  getStatistics(): TsStatistics {
    return this.statistics.snapshot()
  }
}
