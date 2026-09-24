import { ReceptionHistoryIndex, StoreName, toEpochMs, type KeyValueStore } from '../db'

export interface ReceptionHistoryEntry {
  id?: number
  timestamp: Date
  frequency: number
  channel: number | null
  signalLevelDb: number | null
  cnDb: number | null
  packetErrors: number
}

export class ReceptionHistoryRepository {
  readonly #store: KeyValueStore

  constructor(store: KeyValueStore) {
    this.#store = store
  }

  async append(entry: ReceptionHistoryEntry): Promise<void> {
    await this.#store.put(StoreName.ReceptionHistory, entry)
  }

  async appendMany(entries: ReceptionHistoryEntry[]): Promise<void> {
    if (entries.length === 0) return
    await this.#store.putAll(StoreName.ReceptionHistory, entries)
  }

  async recent(limit: number): Promise<ReceptionHistoryEntry[]> {
    const entries = await this.#store.getAll<ReceptionHistoryEntry>(StoreName.ReceptionHistory)
    entries.sort((a, b) => toEpochMs(b.timestamp) - toEpochMs(a.timestamp))
    return entries.slice(0, limit)
  }

  deleteBefore(date: Date): Promise<number> {
    return this.#store.deleteByIndex(StoreName.ReceptionHistory, ReceptionHistoryIndex.Timestamp, {
      upper: date,
      upperOpen: true,
    })
  }
}
