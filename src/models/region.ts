/**
 * Region / transmitter / station data models (要件定義書 16.3, 17).
 */

export interface Region {
  id: string
  name: string
  /** Prefecture name (都道府県). */
  prefecture: string
  /** Representative transmitter IDs available in this region. */
  transmitterIds: string[]
}

export interface Transmitter {
  id: string
  name: string
  regionId: string
  /** Latitude in degrees. */
  latitude: number
  /** Longitude in degrees. */
  longitude: number
  /** Physical channels transmitted from this site. */
  channelIds: string[]
}

export interface ChannelEntry {
  id: string
  transmitterId: string
  /** Physical channel number. */
  physicalChannel: number
  /** Center frequency in Hz (derived at load time if omitted). */
  frequency?: number
}

export interface StationEntry {
  id: string
  channelId: string
  /** Broadcaster / station name. */
  name: string
  /** Network affiliation, e.g. NHK-G / NHK-E / NNN. */
  network?: string
  serviceId?: number
}

export interface ChannelDataFile<T> {
  version: number
  updatedAt: string
  items: T[]
}
