/**
 * Typed loader for the bundled Japanese region / transmitter / channel / station data
 * (要件定義書 16.3, 17).
 */

import channelsFile from './channels.json'
import regionsFile from './regions.json'
import stationsFile from './stations.json'
import transmittersFile from './transmitters.json'
import { channelToFrequencyHz } from '../../models/channel'
import type { ConfiguredChannel } from '../../models/channel'
import type {
  ChannelDataFile,
  ChannelEntry,
  Region,
  StationEntry,
  Transmitter,
} from '../../models/region'

export const CHANNEL_DATA_VERSION = 1

export interface ChannelData {
  regions: ChannelDataFile<Region>
  transmitters: ChannelDataFile<Transmitter>
  channels: ChannelDataFile<ChannelEntry>
  stations: ChannelDataFile<StationEntry>
}

export interface RegionGeoEntry {
  regionId: string
  name: string
  latitude: number
  longitude: number
}

export const channelData: ChannelData = {
  regions: regionsFile,
  transmitters: transmittersFile,
  channels: channelsFile,
  stations: stationsFile,
}

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) map.set(item.id, item)
  return map
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const groupKey = key(item)
    const group = map.get(groupKey)
    if (group) group.push(item)
    else map.set(groupKey, [item])
  }
  return map
}

const regionById = indexById(channelData.regions.items)
const transmitterById = indexById(channelData.transmitters.items)
const channelById = indexById(channelData.channels.items)

const transmittersByRegion = groupBy(channelData.transmitters.items, (t) => t.regionId)
const channelsByTransmitter = groupBy(channelData.channels.items, (c) => c.transmitterId)
const stationsByChannel = groupBy(channelData.stations.items, (s) => s.channelId)

const regionGeoIndex: RegionGeoEntry[] = channelData.regions.items.flatMap((region) => {
  const transmitter = transmittersByRegion.get(region.id)?.[0]
  if (!transmitter) return []
  return [
    {
      regionId: region.id,
      name: region.name,
      latitude: transmitter.latitude,
      longitude: transmitter.longitude,
    },
  ]
})

export function loadRegions(): Region[] {
  return channelData.regions.items
}

export function loadTransmitters(): Transmitter[] {
  return channelData.transmitters.items
}

export function loadChannels(): ChannelEntry[] {
  return channelData.channels.items
}

export function loadStations(): StationEntry[] {
  return channelData.stations.items
}

export function getRegion(id: string): Region | undefined {
  return regionById.get(id)
}

export function getTransmitter(id: string): Transmitter | undefined {
  return transmitterById.get(id)
}

export function getChannel(id: string): ChannelEntry | undefined {
  return channelById.get(id)
}

export function getTransmittersByRegion(regionId: string): Transmitter[] {
  return transmittersByRegion.get(regionId) ?? []
}

export function getChannelsByTransmitter(transmitterId: string): ChannelEntry[] {
  return channelsByTransmitter.get(transmitterId) ?? []
}

export function getStationsByChannel(channelId: string): StationEntry[] {
  return stationsByChannel.get(channelId) ?? []
}

export function getRegionsGeoIndex(): RegionGeoEntry[] {
  return regionGeoIndex
}

/** Channel configurations offered by a transmitter, including station names. */
export function configuredChannelsForTransmitter(transmitterId: string): ConfiguredChannel[] {
  return getChannelsByTransmitter(transmitterId)
    .map((channel) => {
      const station = getStationsByChannel(channel.id)[0]
      const configured: ConfiguredChannel = {
        physicalChannel: channel.physicalChannel,
        channelId: channel.id,
      }
      if (station) {
        configured.name = station.name
        if (station.serviceId !== undefined) configured.serviceId = station.serviceId
      }
      return configured
    })
    .toSorted((a, b) => a.physicalChannel - b.physicalChannel)
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusKm = 6371
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a))
}

/** Nearest bundled transmitter to a coordinate, used for GPS auto-selection. */
export function findNearestTransmitter(
  latitude: number,
  longitude: number,
): Transmitter | undefined {
  let nearest: Transmitter | undefined
  let nearestKm = Number.POSITIVE_INFINITY
  for (const transmitter of channelData.transmitters.items) {
    const distanceKm = haversineKm(latitude, longitude, transmitter.latitude, transmitter.longitude)
    if (distanceKm < nearestKm) {
      nearestKm = distanceKm
      nearest = transmitter
    }
  }
  return nearest
}

function assertFile<T>(label: string, file: ChannelDataFile<T>): void {
  if (file.version !== CHANNEL_DATA_VERSION) {
    throw new Error(`${label}: unsupported version ${file.version}`)
  }
  if (!file.updatedAt) throw new Error(`${label}: missing updatedAt`)
}

function assertUniqueIds(label: string, ids: string[]): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${label}: duplicate id ${id}`)
    seen.add(id)
  }
}

export function validateChannelData(data: ChannelData = channelData): void {
  const { regions, transmitters, channels, stations } = data

  assertFile('regions', regions)
  assertFile('transmitters', transmitters)
  assertFile('channels', channels)
  assertFile('stations', stations)

  assertUniqueIds(
    'regions',
    regions.items.map((r) => r.id),
  )
  assertUniqueIds(
    'transmitters',
    transmitters.items.map((t) => t.id),
  )
  assertUniqueIds(
    'channels',
    channels.items.map((c) => c.id),
  )
  assertUniqueIds(
    'stations',
    stations.items.map((s) => s.id),
  )

  const regionIds = new Set(regions.items.map((r) => r.id))
  const transmitterIds = new Set(transmitters.items.map((t) => t.id))
  const channelIds = new Set(channels.items.map((c) => c.id))

  for (const region of regions.items) {
    for (const transmitterId of region.transmitterIds) {
      if (!transmitterIds.has(transmitterId)) {
        throw new Error(`region ${region.id}: unknown transmitter ${transmitterId}`)
      }
    }
  }

  for (const transmitter of transmitters.items) {
    if (!regionIds.has(transmitter.regionId)) {
      throw new Error(`transmitter ${transmitter.id}: unknown region ${transmitter.regionId}`)
    }
    for (const channelId of transmitter.channelIds) {
      if (!channelIds.has(channelId)) {
        throw new Error(`transmitter ${transmitter.id}: unknown channel ${channelId}`)
      }
    }
  }

  for (const channel of channels.items) {
    if (!transmitterIds.has(channel.transmitterId)) {
      throw new Error(`channel ${channel.id}: unknown transmitter ${channel.transmitterId}`)
    }
    const expected = channelToFrequencyHz(channel.physicalChannel)
    if (channel.frequency !== undefined && channel.frequency !== expected) {
      throw new Error(`channel ${channel.id}: frequency ${channel.frequency} != ${expected}`)
    }
  }

  for (const station of stations.items) {
    if (!channelIds.has(station.channelId)) {
      throw new Error(`station ${station.id}: unknown channel ${station.channelId}`)
    }
  }
}

validateChannelData()
