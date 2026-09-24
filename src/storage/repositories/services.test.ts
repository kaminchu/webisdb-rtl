import { describe, expect, it } from 'vitest'
import { createMemoryKeyValueStore } from '../db'
import { ServiceRepository } from './services'

describe('ServiceRepository', () => {
  it('upserts and lists services', async () => {
    const repo = new ServiceRepository(createMemoryKeyValueStore())
    await repo.upsertServices([
      { serviceId: 1, name: 'NHK総合', remoteControlKeyId: 1 },
      { serviceId: 2, name: '日テレ', remoteControlKeyId: 4 },
    ])
    const services = await repo.getServices()
    expect(services).toHaveLength(2)
    expect(await repo.getService(2)).toEqual({
      serviceId: 2,
      name: '日テレ',
      remoteControlKeyId: 4,
    })
  })

  it('overwrites a service with the same id', async () => {
    const repo = new ServiceRepository(createMemoryKeyValueStore())
    await repo.upsertServices([{ serviceId: 1, name: 'old' }])
    await repo.upsertServices([{ serviceId: 1, name: 'new' }])
    const services = await repo.getServices()
    expect(services).toHaveLength(1)
    expect(services[0]?.name).toBe('new')
  })

  it('returns undefined for a missing service', async () => {
    const repo = new ServiceRepository(createMemoryKeyValueStore())
    expect(await repo.getService(99)).toBeUndefined()
  })
})
