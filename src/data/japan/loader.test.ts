import { describe, expect, it } from 'vitest'
import { channelToFrequencyHz } from '../../models/channel'
import {
  channelData,
  getChannelsByTransmitter,
  getRegion,
  getRegionsGeoIndex,
  getStationsByChannel,
  getTransmittersByRegion,
  loadChannels,
  loadRegions,
  loadStations,
  loadTransmitters,
  validateChannelData,
} from './loader'

describe('channel data files', () => {
  it('carries version and updatedAt on every file', () => {
    for (const file of [
      channelData.regions,
      channelData.transmitters,
      channelData.channels,
      channelData.stations,
    ]) {
      expect(file.version).toBe(1)
      expect(file.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('validates all cross-references without errors', () => {
    expect(() => validateChannelData()).not.toThrow()
  })

  it('covers all 47 prefectures exactly once', () => {
    const regions = loadRegions()
    expect(regions).toHaveLength(47)
    expect(new Set(regions.map((r) => r.id)).size).toBe(47)
    for (const region of regions) {
      expect(region.name).toBe(region.prefecture)
    }
  })
})

describe('cross references', () => {
  it('resolves every region transmitter id', () => {
    const transmitterIds = new Set(loadTransmitters().map((t) => t.id))
    for (const region of loadRegions()) {
      expect(region.transmitterIds.length).toBeGreaterThan(0)
      for (const id of region.transmitterIds) expect(transmitterIds.has(id)).toBe(true)
    }
  })

  it('resolves every transmitter region and channel id', () => {
    const regionIds = new Set(loadRegions().map((r) => r.id))
    const channelIds = new Set(loadChannels().map((c) => c.id))
    for (const transmitter of loadTransmitters()) {
      expect(regionIds.has(transmitter.regionId)).toBe(true)
      for (const id of transmitter.channelIds) expect(channelIds.has(id)).toBe(true)
    }
  })

  it('resolves every channel transmitter and station channel id', () => {
    const transmitterIds = new Set(loadTransmitters().map((t) => t.id))
    const channelIds = new Set(loadChannels().map((c) => c.id))
    for (const channel of loadChannels()) {
      expect(transmitterIds.has(channel.transmitterId)).toBe(true)
    }
    for (const station of loadStations()) {
      expect(channelIds.has(station.channelId)).toBe(true)
    }
  })
})

describe('yahiko transmitter', () => {
  it('is the Niigata main site with the measured physical channels', () => {
    const niigata = getRegion('niigata')
    expect(niigata?.transmitterIds).toContain('yahiko')

    const channels = getChannelsByTransmitter('yahiko')
    const physical = channels.map((c) => c.physicalChannel).toSorted((a, b) => a - b)
    expect(physical).toEqual([13, 15, 17, 19, 23, 26])
  })

  it('derives the correct center frequencies', () => {
    for (const channel of getChannelsByTransmitter('yahiko')) {
      expect(channel.frequency).toBe(channelToFrequencyHz(channel.physicalChannel))
    }
    expect(
      getChannelsByTransmitter('yahiko').find((c) => c.physicalChannel === 19)?.frequency,
    ).toBe(509_142_857)
  })

  it('maps the confirmed broadcasters to their channels', () => {
    expect(getStationsByChannel('yahiko-13').map((s) => s.network)).toEqual(['NHK-E'])
    expect(getStationsByChannel('yahiko-15').map((s) => s.network)).toEqual(['NHK-G'])
    expect(getStationsByChannel('yahiko-17').map((s) => s.network)).toEqual(['JNN'])
    expect(getStationsByChannel('yahiko-19').map((s) => s.name)).toEqual(['NST新潟総合テレビ'])
    expect(getStationsByChannel('yahiko-23').map((s) => s.network)).toEqual(['ANN'])
    expect(getStationsByChannel('yahiko-26').map((s) => s.network)).toEqual(['NNN'])
  })
})

describe('geo index', () => {
  it('exposes coordinates for every region with a transmitter', () => {
    const index = getRegionsGeoIndex()
    expect(index).toHaveLength(47)
    const niigata = index.find((entry) => entry.regionId === 'niigata')
    expect(niigata).toBeDefined()
    expect(niigata?.latitude).toBeCloseTo(37.55, 1)
    expect(niigata?.longitude).toBeCloseTo(138.83, 1)
  })

  it('returns the main transmitter for a region', () => {
    expect(getTransmittersByRegion('niigata').map((t) => t.id)).toEqual(['yahiko'])
  })
})
