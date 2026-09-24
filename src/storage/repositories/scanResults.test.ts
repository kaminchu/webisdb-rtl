import { describe, expect, it } from 'vitest'
import { createMemoryKeyValueStore } from '../db'
import { ScanResultRepository, type ScanResult } from './scanResults'

function makeResult(overrides: Partial<ScanResult> & { physicalChannel: number }): ScanResult {
  return {
    frequency: 473_142_857,
    scannedAt: new Date('2026-01-01T00:00:00Z'),
    succeeded: true,
    serviceCount: 1,
    signalLevelDb: null,
    ...overrides,
  }
}

describe('ScanResultRepository', () => {
  it('stores results with generated ids and lists them', async () => {
    const repo = new ScanResultRepository(createMemoryKeyValueStore())
    const results = [makeResult({ physicalChannel: 13 }), makeResult({ physicalChannel: 15 })]
    await repo.putResults(results)
    expect(results.map((result) => result.id)).toEqual([1, 2])
    expect(await repo.getAll()).toHaveLength(2)
  })

  it('filters results by physical channel', async () => {
    const repo = new ScanResultRepository(createMemoryKeyValueStore())
    await repo.putResults([
      makeResult({ physicalChannel: 13 }),
      makeResult({ physicalChannel: 13 }),
      makeResult({ physicalChannel: 15 }),
    ])
    expect(await repo.getByChannel(13)).toHaveLength(2)
  })

  it('returns the latest result overall and per channel', async () => {
    const repo = new ScanResultRepository(createMemoryKeyValueStore())
    await repo.putResults([
      makeResult({ physicalChannel: 13, scannedAt: new Date('2026-01-01T00:00:00Z') }),
      makeResult({ physicalChannel: 13, scannedAt: new Date('2026-01-03T00:00:00Z') }),
      makeResult({ physicalChannel: 15, scannedAt: new Date('2026-01-02T00:00:00Z') }),
    ])
    expect((await repo.latest())?.scannedAt).toEqual(new Date('2026-01-03T00:00:00Z'))
    expect((await repo.latest(15))?.physicalChannel).toBe(15)
  })

  it('returns undefined when there are no results', async () => {
    const repo = new ScanResultRepository(createMemoryKeyValueStore())
    expect(await repo.latest()).toBeUndefined()
  })
})
