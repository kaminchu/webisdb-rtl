/**
 * Service / Event (program) models (要件定義書 37).
 */

export interface Service {
  /** Service ID from SDT / PMT. */
  serviceId: number
  /** Physical channel this service was observed on, if known. */
  physicalChannel?: number
  /** Remote control key ID (channel number shown to users), if known. */
  remoteControlKeyId?: number
  /** Human readable service name. */
  name: string
  /** Service provider (broadcaster) name. */
  providerName?: string
  /** Service type bit flags from SDT (0x01 = digital TV). */
  serviceType?: number
  /** Simple logo character string broadcast in the SDT logo transmission descriptor. */
  logo?: string
  /** Whether this service is currently scrambled (should stay false for one-seg). */
  scrambled?: boolean
}

export interface Event {
  /** Event ID from EIT. */
  eventId: number
  serviceId: number
  /** Transport stream ID. */
  transportStreamId?: number
  /** Start time. */
  startTime: Date
  /** Duration in seconds. */
  duration: number
  /** Short event title. */
  title: string
  /** Extended event description, if any. */
  description?: string
  /** Whether the event is currently on air (EIT present/following). */
  running?: boolean
  /** Content genre nibbles from the content descriptor. */
  genres?: number[]
  /** When this record was last updated. */
  updatedAt?: Date
}

export interface EventQuery {
  serviceId?: number
  from?: Date
  to?: Date
  limit?: number
}
