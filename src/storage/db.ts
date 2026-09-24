/**
 * IndexedDB wrapper (要件定義書 22).
 *
 * Repositories talk to a small `KeyValueStore` interface. The real
 * `IndexedDbKeyValueStore` is used in the browser; `MemoryKeyValueStore` keeps the
 * repository logic testable without a DOM IndexedDB implementation.
 */

export const DB_NAME = 'webisdb-rtl'
export const DB_VERSION = 1

export const StoreName = {
  Stations: 'stations',
  Services: 'services',
  Events: 'events',
  Epg: 'epg',
  ScanResults: 'scanResults',
  ReceptionHistory: 'receptionHistory',
} as const

export type StoreName = (typeof StoreName)[keyof typeof StoreName]

export const storeNames: StoreName[] = Object.values(StoreName)

export const EventIndex = {
  ServiceId: 'serviceId',
  StartTime: 'startTime',
  ServiceStart: 'serviceStart',
} as const

export const StationIndex = {
  RegionId: 'regionId',
} as const

export const ScanResultIndex = {
  PhysicalChannel: 'physicalChannel',
  ScannedAt: 'scannedAt',
} as const

export const ReceptionHistoryIndex = {
  Timestamp: 'timestamp',
} as const

export interface IndexDefinition {
  name: string
  keyPath: string | string[]
  unique?: boolean
}

export interface StoreDefinition {
  keyPath: string | string[]
  autoIncrement?: boolean
  indexes?: IndexDefinition[]
}

export const SCHEMA: Record<StoreName, StoreDefinition> = {
  [StoreName.Stations]: {
    keyPath: 'id',
    indexes: [{ name: StationIndex.RegionId, keyPath: 'regionId' }],
  },
  [StoreName.Services]: {
    keyPath: 'serviceId',
  },
  [StoreName.Events]: {
    keyPath: ['serviceId', 'eventId'],
    indexes: [
      { name: EventIndex.ServiceId, keyPath: 'serviceId' },
      { name: EventIndex.StartTime, keyPath: 'startTime' },
      { name: EventIndex.ServiceStart, keyPath: ['serviceId', 'startTime'] },
    ],
  },
  [StoreName.Epg]: {
    keyPath: 'serviceId',
    indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  },
  [StoreName.ScanResults]: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      { name: ScanResultIndex.PhysicalChannel, keyPath: 'physicalChannel' },
      { name: ScanResultIndex.ScannedAt, keyPath: 'scannedAt' },
    ],
  },
  [StoreName.ReceptionHistory]: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: ReceptionHistoryIndex.Timestamp, keyPath: 'timestamp' }],
  },
}

/** Cached EPG snapshot metadata (要件定義書 21). */
export interface EpgCacheEntry {
  serviceId: number
  transportStreamId?: number
  updatedAt: Date
  eventCount: number
}

export interface MigrationObjectStore {
  createIndex(name: string, keyPath: string | string[], options?: IDBIndexParameters): unknown
}

export interface MigrationTarget {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string, options?: IDBObjectStoreParameters): MigrationObjectStore
}

export interface Migration {
  version: number
  upgrade(db: MigrationTarget): void
}

/**
 * Versioned migrations. Add a new entry for each schema bump; keep old entries so
 * upgrades from any previous version replay in order.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    upgrade(db) {
      for (const name of storeNames) {
        if (db.objectStoreNames.contains(name)) continue
        const definition = SCHEMA[name]
        const store = db.createObjectStore(name, {
          keyPath: definition.keyPath,
          autoIncrement: definition.autoIncrement,
        })
        for (const index of definition.indexes ?? []) {
          store.createIndex(index.name, index.keyPath, { unique: index.unique })
        }
      }
    },
  },
]

export function applyMigrations(
  db: MigrationTarget,
  fromVersion: number,
  toVersion: number = DB_VERSION,
): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > fromVersion && migration.version <= toVersion) {
      migration.upgrade(db)
    }
  }
}

export function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  const target = factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
  if (!target) return Promise.reject(new Error('IndexedDB is not available'))

  return new Promise((resolve, reject) => {
    const request = target.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      applyMigrations(request.result, event.oldVersion)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('failed to open database'))
    request.onblocked = () => reject(new Error('database open blocked'))
  })
}

export interface KeyRangeQuery {
  only?: IDBValidKey
  lower?: IDBValidKey
  upper?: IDBValidKey
  lowerOpen?: boolean
  upperOpen?: boolean
}

export interface KeyValueStore {
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined>
  getAll<T>(store: StoreName): Promise<T[]>
  getAllByIndex<T>(store: StoreName, index: string, query?: KeyRangeQuery): Promise<T[]>
  put<T>(store: StoreName, value: T): Promise<void>
  putAll<T>(store: StoreName, values: T[]): Promise<void>
  delete(store: StoreName, key: IDBValidKey): Promise<void>
  deleteByIndex(store: StoreName, index: string, query?: KeyRangeQuery): Promise<number>
  clear(store: StoreName): Promise<void>
  close(): void
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('indexeddb transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('indexeddb transaction aborted'))
  })
}

export async function withStore<T>(
  db: IDBDatabase,
  name: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const transaction = db.transaction(name, mode)
  const done = transactionDone(transaction)
  try {
    const result = await fn(transaction.objectStore(name))
    await done
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // transaction already finished
    }
    throw error
  }
}

function toIDBKeyRange(query?: KeyRangeQuery): IDBKeyRange | undefined {
  if (!query) return undefined
  if (query.only !== undefined) return IDBKeyRange.only(query.only)
  if (query.lower !== undefined && query.upper !== undefined) {
    return IDBKeyRange.bound(query.lower, query.upper, query.lowerOpen, query.upperOpen)
  }
  if (query.lower !== undefined) return IDBKeyRange.lowerBound(query.lower, query.lowerOpen)
  if (query.upper !== undefined) return IDBKeyRange.upperBound(query.upper, query.upperOpen)
  return undefined
}

export class IndexedDbKeyValueStore implements KeyValueStore {
  readonly #db: IDBDatabase

  constructor(db: IDBDatabase) {
    this.#db = db
  }

  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return withStore(this.#db, store, 'readonly', (target) =>
      requestToPromise(target.get(key) as IDBRequest<T | undefined>),
    )
  }

  getAll<T>(store: StoreName): Promise<T[]> {
    return withStore(this.#db, store, 'readonly', (target) =>
      requestToPromise(target.getAll() as IDBRequest<T[]>),
    )
  }

  getAllByIndex<T>(store: StoreName, index: string, query?: KeyRangeQuery): Promise<T[]> {
    return withStore(this.#db, store, 'readonly', (target) =>
      requestToPromise(target.index(index).getAll(toIDBKeyRange(query)) as IDBRequest<T[]>),
    )
  }

  async put<T>(store: StoreName, value: T): Promise<void> {
    await withStore(this.#db, store, 'readwrite', (target) => requestToPromise(target.put(value)))
  }

  async putAll<T>(store: StoreName, values: T[]): Promise<void> {
    await withStore(this.#db, store, 'readwrite', async (target) => {
      for (const value of values) await requestToPromise(target.put(value))
    })
  }

  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    await withStore(this.#db, store, 'readwrite', (target) => requestToPromise(target.delete(key)))
  }

  deleteByIndex(store: StoreName, index: string, query?: KeyRangeQuery): Promise<number> {
    return withStore(this.#db, store, 'readwrite', (target) => {
      return new Promise<number>((resolve, reject) => {
        const request = target.index(index).openCursor(toIDBKeyRange(query))
        let removed = 0
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) {
            resolve(removed)
            return
          }
          cursor.delete()
          removed++
          cursor.continue()
        }
        request.onerror = () => reject(request.error ?? new Error('indexeddb cursor failed'))
      })
    })
  }

  async clear(store: StoreName): Promise<void> {
    await withStore(this.#db, store, 'readwrite', (target) => requestToPromise(target.clear()))
  }

  close(): void {
    this.#db.close()
  }
}

function valueAtPath(record: unknown, path: string | string[]): IDBValidKey | undefined {
  if (Array.isArray(path)) {
    const parts = path.map((segment) => valueAtPath(record, segment))
    if (parts.some((part) => part === undefined)) return undefined
    return parts as IDBValidKey[]
  }
  if (record === null || typeof record !== 'object') return undefined
  return (record as Record<string, IDBValidKey>)[path]
}

function serializeKey(key: IDBValidKey): string {
  if (key instanceof Date) return `d:${key.getTime()}`
  if (Array.isArray(key))
    return `a:[${key.map((part) => serializeKey(part as IDBValidKey)).join(',')}]`
  if (typeof key === 'number') return `n:${key}`
  if (typeof key === 'string') return `s:${key}`
  return `x:${String(key)}`
}

function compareKeys(a: IDBValidKey, b: IDBValidKey): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.min(a.length, b.length)
    for (let i = 0; i < length; i++) {
      const result = compareKeys(a[i] as IDBValidKey, b[i] as IDBValidKey)
      if (result !== 0) return result
    }
    return a.length - b.length
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  return 0
}

function matchesQuery(key: IDBValidKey, query?: KeyRangeQuery): boolean {
  if (!query) return true
  if (query.only !== undefined) return compareKeys(key, query.only) === 0
  if (query.lower !== undefined) {
    const result = compareKeys(key, query.lower)
    if (result < 0 || (result === 0 && query.lowerOpen)) return false
  }
  if (query.upper !== undefined) {
    const result = compareKeys(key, query.upper)
    if (result > 0 || (result === 0 && query.upperOpen)) return false
  }
  return true
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly #schema: Record<StoreName, StoreDefinition>
  readonly #tables = new Map<StoreName, Map<string, unknown>>()
  readonly #counters = new Map<StoreName, number>()

  constructor(schema: Record<StoreName, StoreDefinition> = SCHEMA) {
    this.#schema = schema
    for (const name of storeNames) this.#tables.set(name, new Map())
  }

  #table(store: StoreName): Map<string, unknown> {
    const table = this.#tables.get(store)
    if (!table) throw new Error(`unknown store ${store}`)
    return table
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.#table(store).get(serializeKey(key)) as T | undefined
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return [...this.#table(store).values()] as T[]
  }

  async getAllByIndex<T>(store: StoreName, index: string, query?: KeyRangeQuery): Promise<T[]> {
    const indexDefinition = this.#indexDefinition(store, index)
    const results: T[] = []
    for (const record of this.#table(store).values()) {
      const key = valueAtPath(record, indexDefinition.keyPath)
      if (key === undefined || !matchesQuery(key, query)) continue
      results.push(record as T)
    }
    return results
  }

  async put<T>(store: StoreName, value: T): Promise<void> {
    const definition = this.#schema[store]
    const table = this.#table(store)
    let key = valueAtPath(value, definition.keyPath)
    if (key === undefined) {
      if (!definition.autoIncrement || typeof definition.keyPath !== 'string') {
        throw new Error(`${store}: missing primary key`)
      }
      const next = (this.#counters.get(store) ?? 0) + 1
      this.#counters.set(store, next)
      key = next
      const record = value as Record<string, unknown>
      record[definition.keyPath] = next
    } else if (typeof key === 'number' && definition.autoIncrement) {
      const current = this.#counters.get(store) ?? 0
      if (key > current) this.#counters.set(store, key)
    }
    table.set(serializeKey(key), value)
  }

  async putAll<T>(store: StoreName, values: T[]): Promise<void> {
    for (const value of values) await this.put(store, value)
  }

  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    this.#table(store).delete(serializeKey(key))
  }

  async deleteByIndex(store: StoreName, index: string, query?: KeyRangeQuery): Promise<number> {
    const indexDefinition = this.#indexDefinition(store, index)
    const table = this.#table(store)
    const keys: string[] = []
    for (const [key, record] of table) {
      const indexKey = valueAtPath(record, indexDefinition.keyPath)
      if (indexKey !== undefined && matchesQuery(indexKey, query)) keys.push(key)
    }
    for (const key of keys) table.delete(key)
    return keys.length
  }

  async clear(store: StoreName): Promise<void> {
    this.#tables.set(store, new Map())
    this.#counters.delete(store)
  }

  close(): void {
    this.#tables.clear()
  }

  #indexDefinition(store: StoreName, index: string): IndexDefinition {
    const definition = this.#schema[store]?.indexes?.find((candidate) => candidate.name === index)
    if (!definition) throw new Error(`${store}: unknown index ${index}`)
    return definition
  }
}

export function createMemoryKeyValueStore(
  schema: Record<StoreName, StoreDefinition> = SCHEMA,
): MemoryKeyValueStore {
  return new MemoryKeyValueStore(schema)
}

export async function openKeyValueStore(factory?: IDBFactory): Promise<KeyValueStore> {
  return new IndexedDbKeyValueStore(await openDatabase(factory))
}

export function toEpochMs(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}
