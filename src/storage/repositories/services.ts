import type { Service } from '../../models'
import { StoreName, type KeyValueStore } from '../db'

export class ServiceRepository {
  readonly #store: KeyValueStore

  constructor(store: KeyValueStore) {
    this.#store = store
  }

  async upsertServices(services: Service[]): Promise<void> {
    if (services.length === 0) return
    await this.#store.putAll(StoreName.Services, services)
  }

  getServices(): Promise<Service[]> {
    return this.#store.getAll<Service>(StoreName.Services)
  }

  getService(serviceId: number): Promise<Service | undefined> {
    return this.#store.get<Service>(StoreName.Services, serviceId)
  }
}
