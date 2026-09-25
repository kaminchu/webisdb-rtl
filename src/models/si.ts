/** Parsed PSI/SI service information DTOs (要件定義書 23, 24). */
import type { Descriptor } from './descriptor'
import type { Event } from './service'

export interface PatProgram {
  programNumber: number
  pid: number
}

export interface PatSection {
  transportStreamId: number
  version: number
  programs: PatProgram[]
  /** PID carrying NIT (program_number === 0). */
  networkPid: number
}

export interface PmtStream {
  pid: number
  streamType: number
  descriptors: Descriptor[]
}

export interface PmtSection {
  programNumber: number
  version: number
  pcrPid: number
  programInfo: Descriptor[]
  streams: PmtStream[]
}

export interface SdtService {
  serviceId: number
  serviceType: number
  providerName: string
  serviceName: string
  /** Simple logo character string from the logo transmission descriptor, if any. */
  logo?: string
}

export interface SdtSection {
  transportStreamId: number
  originalNetworkId: number
  version: number
  services: SdtService[]
}

export interface EitSection {
  tableId: number
  serviceId: number
  transportStreamId: number
  originalNetworkId: number
  version: number
  presentFollowing: boolean
  schedule: boolean
  events: Event[]
}

export interface NitTransportStream {
  transportStreamId: number
  originalNetworkId: number
  descriptors: Descriptor[]
}

export interface NitSection {
  networkId: number
  networkName: string | null
  version: number
  transportStreams: NitTransportStream[]
  descriptors: Descriptor[]
}

export interface TdtSection {
  utc: Date
}

export interface TotSection {
  utc: Date
  localTimeOffsetMinutes: number
  localTimeOffsetPolarity: number
  descriptors: Descriptor[]
}

export interface PidStat {
  pid: number
  packets: number
  /** PMT stream type if this PID is an elementary stream. */
  streamType?: number
  description?: string
}

export interface TsStatistics {
  packets: number
  packetsWithError: number
  ccErrors: number
  bytes: number
  /** Measured bitrate over the last window, bits per second. */
  bitrate: number
  pids: PidStat[]
}
