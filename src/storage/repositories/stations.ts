import type { StationEntry } from '../../models'
import { StationIndex, StoreName, type KeyValueStore } from '../db'

/** A station plus the region it belongs to, so lookups can go straight to the index. */
export interface StationRecord extends StationEntry {
  regionId: string
}

export class StationRepository {
  readonly #store: KeyValueStore

  constructor(store: KeyValueStore) {
    this.#store = store
  }

  async upsert(stations: StationRecord[]): Promise<void> {
    if (stations.length === 0) return
    await this.#store.putAll(StoreName.Stations, stations)
  }

  getByRegion(regionId: string): Promise<StationRecord[]> {
    return this.#store.getAllByIndex<StationRecord>(StoreName.Stations, StationIndex.RegionId, {
      only: regionId,
    })
  }

  getAll(): Promise<StationRecord[]> {
    return this.#store.getAll<StationRecord>(StoreName.Stations)
  }
}
