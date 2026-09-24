/**
 * localStorage-backed list of enabled channels (要件定義書 16, 22).
 *
 * The viewer picks channels either from a region/transmitter or from a scan;
 * this small list is what the watch and guide screens iterate over.
 */
import type { ConfiguredChannel } from '../models/channel'

export const CHANNELS_STORAGE_KEY = 'webisdb-rtl:channels'

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function normalizeChannel(value: unknown): ConfiguredChannel | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const physicalChannel = record.physicalChannel
  if (typeof physicalChannel !== 'number' || !Number.isFinite(physicalChannel)) return null
  const result: ConfiguredChannel = { physicalChannel }
  if (typeof record.name === 'string') result.name = record.name
  if (typeof record.serviceId === 'number' && Number.isFinite(record.serviceId)) {
    result.serviceId = record.serviceId
  }
  if (typeof record.channelId === 'string') result.channelId = record.channelId
  return result
}

function normalizeChannels(values: unknown): ConfiguredChannel[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<number>()
  const channels: ConfiguredChannel[] = []
  for (const value of values) {
    const channel = normalizeChannel(value)
    if (!channel || seen.has(channel.physicalChannel)) continue
    seen.add(channel.physicalChannel)
    channels.push(channel)
  }
  return channels.toSorted((a, b) => a.physicalChannel - b.physicalChannel)
}

export function loadConfiguredChannels(): ConfiguredChannel[] {
  const storage = getStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(CHANNELS_STORAGE_KEY)
    if (!raw) return []
    return normalizeChannels(JSON.parse(raw))
  } catch {
    return []
  }
}

export function saveConfiguredChannels(channels: ConfiguredChannel[]): ConfiguredChannel[] {
  const normalized = normalizeChannels(channels)
  const storage = getStorage()
  if (storage) {
    try {
      storage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(normalized))
    } catch {
      // ignore quota / serialization failures
    }
  }
  return normalized
}
