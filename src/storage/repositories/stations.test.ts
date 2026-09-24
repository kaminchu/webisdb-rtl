import { describe, expect, it } from 'vitest'
import { createMemoryKeyValueStore } from '../db'
import { StationRepository, type StationRecord } from './stations'

const stations: StationRecord[] = [
  { id: 's1', channelId: 'c1', name: 'NHK新潟', regionId: 'niigata', serviceId: 1 },
  { id: 's2', channelId: 'c1', name: 'TeNY', regionId: 'niigata', serviceId: 2 },
  { id: 's3', channelId: 'c2', name: 'NHK東京', regionId: 'tokyo', serviceId: 1 },
]

describe('StationRepository', () => {
  it('upserts and filters by region', async () => {
    const repo = new StationRepository(createMemoryKeyValueStore())
    await repo.upsert(stations)
    const niigata = await repo.getByRegion('niigata')
    expect(niigata.map((station) => station.id).toSorted()).toEqual(['s1', 's2'])
    expect(await repo.getAll()).toHaveLength(3)
  })

  it('updates a station with the same id', async () => {
    const repo = new StationRepository(createMemoryKeyValueStore())
    await repo.upsert([{ id: 's1', channelId: 'c1', name: 'old', regionId: 'niigata' }])
    await repo.upsert([{ id: 's1', channelId: 'c1', name: 'new', regionId: 'niigata' }])
    const found = await repo.getByRegion('niigata')
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('new')
  })
})
