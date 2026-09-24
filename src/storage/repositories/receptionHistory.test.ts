import { describe, expect, it } from 'vitest'
import { createMemoryKeyValueStore } from '../db'
import { ReceptionHistoryRepository, type ReceptionHistoryEntry } from './receptionHistory'

function makeEntry(
  overrides: Partial<ReceptionHistoryEntry> & { timestamp: Date },
): ReceptionHistoryEntry {
  return {
    frequency: 473_142_857,
    channel: 13,
    signalLevelDb: -40,
    cnDb: 20,
    packetErrors: 0,
    ...overrides,
  }
}

describe('ReceptionHistoryRepository', () => {
  it('appends entries and returns the most recent first', async () => {
    const repo = new ReceptionHistoryRepository(createMemoryKeyValueStore())
    await repo.append(makeEntry({ timestamp: new Date('2026-01-01T00:00:00Z'), channel: 13 }))
    await repo.append(makeEntry({ timestamp: new Date('2026-01-03T00:00:00Z'), channel: 15 }))
    await repo.append(makeEntry({ timestamp: new Date('2026-01-02T00:00:00Z'), channel: 17 }))
    const recent = await repo.recent(2)
    expect(recent.map((entry) => entry.channel)).toEqual([15, 17])
  })

  it('appends many entries at once', async () => {
    const repo = new ReceptionHistoryRepository(createMemoryKeyValueStore())
    await repo.appendMany([
      makeEntry({ timestamp: new Date('2026-01-01T00:00:00Z') }),
      makeEntry({ timestamp: new Date('2026-01-02T00:00:00Z') }),
    ])
    expect(await repo.recent(10)).toHaveLength(2)
  })

  it('deletes entries before a date', async () => {
    const repo = new ReceptionHistoryRepository(createMemoryKeyValueStore())
    await repo.appendMany([
      makeEntry({ timestamp: new Date('2026-01-01T00:00:00Z') }),
      makeEntry({ timestamp: new Date('2026-01-05T00:00:00Z') }),
    ])
    expect(await repo.deleteBefore(new Date('2026-01-03T00:00:00Z'))).toBe(1)
    expect(await repo.recent(10)).toHaveLength(1)
  })
})
