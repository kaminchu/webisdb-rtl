import type { Service } from './service'

/** A logical MPEG-TS multiplex as observed over the air. */
export interface TransportStreamInfo {
  /** Transport stream ID from PAT/NIT/SDT. */
  transportStreamId: number
  /** Original network ID from NIT/SDT, if known. */
  originalNetworkId?: number
  /** Network name from NIT, if known. */
  networkName?: string
  /** Services discovered in this multiplex. */
  services: Service[]
}

/** PID usage classification from the PMT. */
export const StreamKind = {
  Video: 'video',
  Audio: 'audio',
  Caption: 'caption',
  DataBroadcast: 'data',
  Other: 'other',
} as const

export type StreamKind = (typeof StreamKind)[keyof typeof StreamKind]
