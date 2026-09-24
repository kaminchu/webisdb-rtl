import { ScanResultIndex, StoreName, toEpochMs, type KeyValueStore } from '../db'
import type { Service } from '../../models'

export interface ScanResult {
  id?: number
  physicalChannel: number
  frequency: number
  scannedAt: Date
  succeeded: boolean
  serviceCount: number
  signalLevelDb: number | null
  transportStreamId?: number | null
  services?: Service[]
  cnDb?: number | null
  merDb?: number | null
}

export class ScanResultRepository {
  readonly #store: KeyValueStore

  constructor(store: KeyValueStore) {
    this.#store = store
  }

  async putResults(results: ScanResult[]): Promise<void> {
    if (results.length === 0) return
    await this.#store.putAll(StoreName.ScanResults, results)
  }

  getAll(): Promise<ScanResult[]> {
    return this.#store.getAll<ScanResult>(StoreName.ScanResults)
  }

  getByChannel(physicalChannel: number): Promise<ScanResult[]> {
    return this.#store.getAllByIndex<ScanResult>(
      StoreName.ScanResults,
      ScanResultIndex.PhysicalChannel,
      { only: physicalChannel },
    )
  }

  async latest(physicalChannel?: number): Promise<ScanResult | undefined> {
    const results =
      physicalChannel !== undefined ? await this.getByChannel(physicalChannel) : await this.getAll()
    let latest: ScanResult | undefined
    for (const result of results) {
      if (!latest || toEpochMs(result.scannedAt) > toEpochMs(latest.scannedAt)) latest = result
    }
    return latest
  }
}
