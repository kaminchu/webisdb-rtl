import { describe, expect, it } from 'vitest'
import type { Event } from '../models'
import {
  applyMigrations,
  createMemoryKeyValueStore,
  DB_NAME,
  DB_VERSION,
  EventIndex,
  type MigrationTarget,
  openDatabase,
  ReceptionHistoryIndex,
  SCHEMA,
  StationIndex,
  StoreName,
  storeNames,
} from './db'

function makeEvent(serviceId: number, eventId: number, startTime: Date): Event {
  return { serviceId, eventId, startTime, duration: 1800, title: `e${eventId}` }
}

describe('memory key-value store', () => {
  it('puts, gets and lists records by primary key', async () => {
    const store = createMemoryKeyValueStore()
    await store.put(StoreName.Services, { serviceId: 1, name: 'NHK' })
    await store.put(StoreName.Services, { serviceId: 2, name: 'NTV' })
    expect(await store.get(StoreName.Services, 1)).toEqual({ serviceId: 1, name: 'NHK' })
    expect(await store.getAll(StoreName.Services)).toHaveLength(2)
  })

  it('overwrites an existing record', async () => {
    const store = createMemoryKeyValueStore()
    await store.put(StoreName.Services, { serviceId: 1, name: 'old' })
    await store.put(StoreName.Services, { serviceId: 1, name: 'new' })
    expect(await store.get(StoreName.Services, 1)).toEqual({ serviceId: 1, name: 'new' })
    expect(await store.getAll(StoreName.Services)).toHaveLength(1)
  })

  it('uses a compound primary key for events', async () => {
    const store = createMemoryKeyValueStore()
    const a = makeEvent(1, 10, new Date('2026-01-01T00:00:00Z'))
    const b = makeEvent(2, 10, new Date('2026-01-01T01:00:00Z'))
    await store.put(StoreName.Events, a)
    await store.put(StoreName.Events, b)
    expect(await store.get(StoreName.Events, [1, 10])).toEqual(a)
    expect(await store.get(StoreName.Events, [2, 10])).toEqual(b)
  })

  it('queries a secondary index with an equality range', async () => {
    const store = createMemoryKeyValueStore()
    await store.put(StoreName.Events, makeEvent(1, 1, new Date('2026-01-01T00:00:00Z')))
    await store.put(StoreName.Events, makeEvent(1, 2, new Date('2026-01-01T01:00:00Z')))
    await store.put(StoreName.Events, makeEvent(2, 3, new Date('2026-01-01T02:00:00Z')))
    const found = await store.getAllByIndex<Event>(StoreName.Events, EventIndex.ServiceId, {
      only: 1,
    })
    expect(found.map((event) => event.eventId).toSorted()).toEqual([1, 2])
  })

  it('queries a date index with bounds', async () => {
    const store = createMemoryKeyValueStore()
    await store.put(StoreName.ReceptionHistory, {
      timestamp: new Date('2026-01-01T00:00:00Z'),
      frequency: 1,
    })
    await store.put(StoreName.ReceptionHistory, {
      timestamp: new Date('2026-01-02T00:00:00Z'),
      frequency: 2,
    })
    const found = await store.getAllByIndex(
      StoreName.ReceptionHistory,
      ReceptionHistoryIndex.Timestamp,
      {
        lower: new Date('2026-01-01T12:00:00Z'),
      },
    )
    expect(found).toHaveLength(1)
  })

  it('generates auto-increment keys and deletes by index', async () => {
    const store = createMemoryKeyValueStore()
    const first = { physicalChannel: 13, scannedAt: new Date('2026-01-01T00:00:00Z') }
    const second = { physicalChannel: 15, scannedAt: new Date('2026-01-01T00:00:00Z') }
    await store.put(StoreName.ScanResults, first)
    await store.put(StoreName.ScanResults, second)
    expect((first as { id?: number }).id).toBe(1)
    expect((second as { id?: number }).id).toBe(2)
    const removed = await store.deleteByIndex(StoreName.ScanResults, 'physicalChannel', {
      only: 13,
    })
    expect(removed).toBe(1)
    expect(await store.getAll(StoreName.ScanResults)).toHaveLength(1)
  })

  it('clears a store', async () => {
    const store = createMemoryKeyValueStore()
    await store.put(StoreName.Services, { serviceId: 1, name: 'NHK' })
    await store.clear(StoreName.Services)
    expect(await store.getAll(StoreName.Services)).toHaveLength(0)
  })

  it('rejects unknown indexes', async () => {
    const store = createMemoryKeyValueStore()
    await expect(store.getAllByIndex(StoreName.Services, 'missing')).rejects.toThrow(
      'unknown index missing',
    )
  })
})

function createMigrationTarget() {
  const stores = new Map<string, string[]>()
  const target: MigrationTarget = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => {
      stores.set(name, [])
      return {
        createIndex: (indexName) => {
          stores.get(name)?.push(indexName)
          return {}
        },
      }
    },
  }
  return { target, stores }
}

describe('migrations', () => {
  it('creates every store and its indexes at version 1', () => {
    const { target, stores } = createMigrationTarget()
    applyMigrations(target, 0)
    expect([...stores.keys()].toSorted()).toEqual([...storeNames].toSorted())
    expect(stores.get(StoreName.Events)).toEqual([
      EventIndex.ServiceId,
      EventIndex.StartTime,
      EventIndex.ServiceStart,
    ])
    expect(stores.get(StoreName.Stations)).toEqual([StationIndex.RegionId])
    expect(stores.get(StoreName.ScanResults)).toEqual(['physicalChannel', 'scannedAt'])
  })

  it('is idempotent and skips already-applied versions', () => {
    const { target, stores } = createMigrationTarget()
    applyMigrations(target, 0)
    applyMigrations(target, 0)
    applyMigrations(target, DB_VERSION)
    expect(stores.size).toBe(storeNames.length)
  })

  it('exposes a schema entry for every store', () => {
    for (const name of storeNames) expect(SCHEMA[name]).toBeDefined()
  })
})

interface FakeOpenRequest {
  result?: unknown
  error?: Error
  onupgradeneeded?: (event: { oldVersion: number }) => void
  onsuccess?: () => void
  onerror?: () => void
  onblocked?: () => void
}

function createFakeFactory(behavior: 'success' | 'error' = 'success') {
  const calls: { name: string; version: number }[] = []
  const factory = {
    open(name: string, version: number): FakeOpenRequest {
      calls.push({ name, version })
      const request: FakeOpenRequest = {}
      queueMicrotask(() => {
        if (behavior === 'error') {
          request.error = new Error('open failed')
          request.onerror?.()
          return
        }
        request.result = { closed: false }
        request.onsuccess?.()
      })
      return request
    },
  }
  return { factory: factory as unknown as IDBFactory, calls }
}

describe('openDatabase', () => {
  it('rejects when no IndexedDB implementation is available', async () => {
    expect(typeof indexedDB).toBe('undefined')
    await expect(openDatabase()).rejects.toThrow('IndexedDB is not available')
  })

  it('opens the versioned database through the injected factory', async () => {
    const { factory, calls } = createFakeFactory()
    const db = await openDatabase(factory)
    expect(calls).toEqual([{ name: DB_NAME, version: DB_VERSION }])
    expect(db).toEqual({ closed: false })
  })

  it('propagates open errors', async () => {
    const { factory } = createFakeFactory('error')
    await expect(openDatabase(factory)).rejects.toThrow('open failed')
  })
})
